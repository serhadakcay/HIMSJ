class NexusE2EE {
  constructor() {
    this.keyPair = null;
    this.publicKeyJwkStr = '';
    this.myPhoneNorm = '';
    this.sharedKeyCache = new Map();
    this.plainCache = new Map();
    this.vaultKey = '';
  }

  async initForUser(phoneNorm) {
    this.myPhoneNorm = String(phoneNorm || '').replace(/\D/g, '');
    const storeKey = `nexus_identity_jwk_${this.myPhoneNorm}`;
    this.vaultKey = `nexus_plain_vault_${this.myPhoneNorm}`;
    this._loadVaultFromDisk();

    const saved = localStorage.getItem(storeKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const priv = await crypto.subtle.importKey('jwk', parsed.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        const pub = await crypto.subtle.importKey('jwk', parsed.pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        this.keyPair = { privateKey: priv, publicKey: pub };
        this.publicKeyJwkStr = JSON.stringify(parsed.pub);
        return this.publicKeyJwkStr;
      } catch {}
    }

    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    localStorage.setItem(storeKey, JSON.stringify({ pub: pubJwk, priv: privJwk }));

    this.keyPair = kp;
    this.publicKeyJwkStr = JSON.stringify(pubJwk);
    return this.publicKeyJwkStr;
  }

  _loadVaultFromDisk() {
    if (!this.vaultKey) return;
    try {
      const raw = localStorage.getItem(this.vaultKey);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          this.plainCache.set(k, v);
        }
      }
    } catch {}
  }

  saveToVault(msgId, payloadObj) {
    if (!msgId || !payloadObj) return;
    this.plainCache.set(msgId, payloadObj);
    if (!this.vaultKey) return;
    try {
      const entries = Array.from(this.plainCache.entries()).slice(-500);
      localStorage.setItem(this.vaultKey, JSON.stringify(Object.fromEntries(entries)));
    } catch {}
  }

  async _getSharedSecretBits(remotePubJwkStr) {
    if (this.sharedKeyCache.has(remotePubJwkStr)) {
      return this.sharedKeyCache.get(remotePubJwkStr);
    }
    const peerJwk = typeof remotePubJwkStr === 'string' ? JSON.parse(remotePubJwkStr) : remotePubJwkStr;
    const peerPub = await crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, this.keyPair.privateKey, 256);
    this.sharedKeyCache.set(remotePubJwkStr, sharedBits);
    return sharedBits;
  }

  async _getFallbackPairBits(peerPhone) {
    const p1 = this.myPhoneNorm.slice(-10);
    const p2 = String(peerPhone || '').replace(/\D/g, '').slice(-10);
    const pair = [p1, p2].sort().join(':');
    return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`NexusChat-OfflinePair-v14:${pair}`));
  }

  async _deriveMessageAesKey(sharedBits, ivBytes, msgNum, usages) {
    const baseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: ivBytes,
        info: new TextEncoder().encode(`NexusChat-v10-MsgKey:${msgNum}`)
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  }

  async encryptMessage(peerId, peerPubJwkStr, payloadObj, peerPhone = '') {
    let sharedBits;
    let usedPubKey = peerPubJwkStr || '';
    // Güvenlik: telefon numarasından türetilen zayıf yedek anahtar ile ŞİFRELEME YAPILMAZ.
    // (Yedek anahtar sadece eski mesajları okuyabilmek için çözmede kullanılır.)
    if (!peerPubJwkStr) {
      throw new Error('Bu kişinin şifreleme anahtarı yok. Kişi NexusChat\'e kaydolup en az bir kez giriş yapınca mesaj gönderebilirsiniz.');
    }
    try {
      sharedBits = await this._getSharedSecretBits(peerPubJwkStr);
    } catch {
      throw new Error('Kişinin şifreleme anahtarı geçersiz. Mesaj güvenli şekilde gönderilemedi.');
    }

    const msgNum = Date.now();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await this._deriveMessageAesKey(sharedBits, iv, msgNum, ['encrypt']);
    const aad = new TextEncoder().encode(`nexus-msg:${msgNum}`);

    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payloadObj))
    );

    return {
      msgNum,
      iv: this._toB64(iv),
      ciphertext: this._toB64(cipherBuf),
      senderPublicKeyJwk: this.publicKeyJwkStr,
      recipientPublicKeyJwk: usedPubKey
    };
  }

  async decryptMessage(myUserId, peerPubJwkStr, msgRow, peerPhone = '') {
    if (this.plainCache.has(msgRow.id)) return this.plainCache.get(msgRow.id);

    const isMine = msgRow.sender_id === myUserId;
    const candidates = isMine
      ? [msgRow.recipient_public_key_jwk, peerPubJwkStr, msgRow.sender_public_key_jwk]
      : [msgRow.sender_public_key_jwk, peerPubJwkStr, msgRow.recipient_public_key_jwk];

    const uniqueKeys = [...new Set(candidates.filter(Boolean))];
    const msgNum = Number(msgRow.msg_num || 0);
    const ivBytes = this._fromB64(msgRow.iv);
    const cipherBytes = this._fromB64(msgRow.ciphertext);
    const aad = new TextEncoder().encode(`nexus-msg:${msgNum}`);

    for (const remoteKeyStr of uniqueKeys) {
      try {
        const sharedBits = await this._getSharedSecretBits(remoteKeyStr);
        const aesKey = await this._deriveMessageAesKey(sharedBits, ivBytes, msgNum, ['decrypt']);
        const plainBuf = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: ivBytes, additionalData: aad },
          aesKey,
          cipherBytes
        );
        const obj = JSON.parse(new TextDecoder().decode(plainBuf));
        this.saveToVault(msgRow.id, obj);
        return obj;
      } catch {}
    }

    // Fallback offline-pair key decryption
    try {
      const fbBits = await this._getFallbackPairBits(peerPhone || (isMine ? msgRow.recipient_id : msgRow.sender_id));
      const aesKey = await this._deriveMessageAesKey(fbBits, ivBytes, msgNum, ['decrypt']);
      const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivBytes, additionalData: aad },
        aesKey,
        cipherBytes
      );
      const obj = JSON.parse(new TextDecoder().decode(plainBuf));
      this.saveToVault(msgRow.id, obj);
      return obj;
    } catch {}

    return { kind: 'text', text: '🔒 [Şifreli Mesaj]' };
  }

  async encryptFileBlob(arrayBuffer) {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, arrayBuffer);
    const hashBuf = await crypto.subtle.digest('SHA-256', cipherBuf);

    return {
      encryptedBase64: this._toB64(cipherBuf),
      mediaKeyB64: this._toB64(rawKey),
      mediaIvB64: this._toB64(iv),
      sha256B64: this._toB64(hashBuf)
    };
  }

  async decryptFileBlob(encryptedArrayBuf, mediaKeyB64, mediaIvB64, expectedSha256B64) {
    if (expectedSha256B64) {
      const actualHash = this._toB64(await crypto.subtle.digest('SHA-256', encryptedArrayBuf));
      if (actualHash !== expectedSha256B64) throw new Error('Dosya bütünlük doğrulaması (SHA-256) başarısız!');
    }
    const aesKey = await crypto.subtle.importKey('raw', this._fromB64(mediaKeyB64), { name: 'AES-GCM' }, false, ['decrypt']);
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this._fromB64(mediaIvB64) }, aesKey, encryptedArrayBuf);
  }

  _toB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  _fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
}
