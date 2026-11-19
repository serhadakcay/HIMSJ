class NexusE2EE {
  constructor() {
    this.keyPair = null;
    this.publicKeyJwkStr = '';
    this.sessions = new Map();
    this.plainCache = new Map();
  }

  async initForUser(phoneNorm) {
    const storeKey = `nexus_identity_jwk_${phoneNorm}`;
    const saved = localStorage.getItem(storeKey);

    if (saved) {
      const parsed = JSON.parse(saved);
      const priv = await crypto.subtle.importKey('jwk', parsed.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const pub = await crypto.subtle.importKey('jwk', parsed.pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      this.keyPair = { privateKey: priv, publicKey: pub };
      this.publicKeyJwkStr = JSON.stringify(parsed.pub);
      return this.publicKeyJwkStr;
    }

    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    localStorage.setItem(storeKey, JSON.stringify({ pub: pubJwk, priv: privJwk }));

    this.keyPair = kp;
    this.publicKeyJwkStr = JSON.stringify(pubJwk);
    return this.publicKeyJwkStr;
  }

  async _hkdf(rawBuf, info) {
    const base = await crypto.subtle.importKey('raw', rawBuf, 'HKDF', false, ['deriveBits']);
    return await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
      base,
      256
    );
  }

  async _ensureSession(peerId, peerPubJwkStr) {
    if (this.sessions.has(peerId)) return this.sessions.get(peerId);
    const peerJwk = JSON.parse(peerPubJwkStr);
    const myJwk = JSON.parse(this.publicKeyJwkStr);
    const peerPub = await crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, this.keyPair.privateKey, 256);
    const chainA = await this._hkdf(shared, 'Nexus-v9-ChainA');
    const chainB = await this._hkdf(shared, 'Nexus-v9-ChainB');
    const isLower = myJwk.x < peerJwk.x;

    const state = {
      sendChain: isLower ? chainA : chainB,
      recvChain: isLower ? chainB : chainA,
      sendNum: 0,
      recvNum: 0,
      skipped: new Map()
    };
    this.sessions.set(peerId, state);
    return state;
  }

  async _stepRatchet(chainBuf) {
    const nextChain = await this._hkdf(chainBuf, 'Step-Next');
    const msgBits = await this._hkdf(chainBuf, 'Step-Msg');
    const aesKey = await crypto.subtle.importKey('raw', msgBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { nextChain, aesKey };
  }

  async encryptMessage(peerId, peerPubJwkStr, payloadObj) {
    const state = await this._ensureSession(peerId, peerPubJwkStr);
    const { nextChain, aesKey } = await this._stepRatchet(state.sendChain);
    state.sendChain = nextChain;

    const msgNum = state.sendNum++;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`nexus-msg:${msgNum}`);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aesKey,
      new TextEncoder().encode(JSON.stringify(payloadObj))
    );

    return { msgNum, iv: this._toB64(iv), ciphertext: this._toB64(cipherBuf) };
  }

  async decryptMessage(peerId, peerPubJwkStr, msgRow) {
    if (this.plainCache.has(msgRow.id)) return this.plainCache.get(msgRow.id);
    const remotePubStr = msgRow.sender_public_key_jwk || peerPubJwkStr;
    if (!remotePubStr) return { text: '🔒 [Anahtar bekleniyor]' };

    const state = await this._ensureSession(peerId, remotePubStr);
    const msgNum = Number(msgRow.msg_num || 0);
    let aesKey;

    if (state.skipped.has(msgNum)) {
      aesKey = state.skipped.get(msgNum);
      state.skipped.delete(msgNum);
    } else if (msgNum >= state.recvNum) {
      while (state.recvNum < msgNum) {
        const step = await this._stepRatchet(state.recvChain);
        state.recvChain = step.nextChain;
        state.skipped.set(state.recvNum, step.aesKey);
        state.recvNum++;
      }
      const cur = await this._stepRatchet(state.recvChain);
      state.recvChain = cur.nextChain;
      aesKey = cur.aesKey;
      state.recvNum++;
    } else {
      return { text: '🔒 [Şifreli Geçmiş Mesaj]' };
    }

    const aad = new TextEncoder().encode(`nexus-msg:${msgNum}`);
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this._fromB64(msgRow.iv), additionalData: aad },
      aesKey,
      this._fromB64(msgRow.ciphertext)
    );
    const obj = JSON.parse(new TextDecoder().decode(plainBuf));
    this.plainCache.set(msgRow.id, obj);
    return obj;
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
