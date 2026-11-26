// ---- Güvenli yerel depo (IndexedDB) ----
// Özel anahtar "dışa aktarılamaz" (non-extractable) CryptoKey olarak saklanır;
// sayfadaki bir betik anahtarı kullanabilse bile ham halini kopyalayıp dışarı çıkaramaz.
const NexusIDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('nexus_secure_store', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this._db = r.result; resolve(r.result); };
      r.onerror = () => reject(r.error);
    });
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const store = db.transaction('kv', mode).objectStore('kv');
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  get(k) { return this._tx('readonly', (s) => s.get(k)); },
  set(k, v) { return this._tx('readwrite', (s) => s.put(v, k)); },
  del(k) { return this._tx('readwrite', (s) => s.delete(k)); }
};

class NexusE2EE {
  constructor() {
    this.keyPair = null;
    this.publicKeyJwkStr = '';
    this.myPhoneNorm = '';
    this.sharedKeyCache = new Map();
    this.plainCache = new Map();
    this.idKey = '';
    this.vaultIdbKey = '';
    this.vaultAesKey = null;
    this._pendingBackupJwk = null; // Sadece yeni üretilen anahtarın yedeği alınana kadar bellekte tutulur
    this._vaultTimer = null;
  }

  _pubOnly(jwk) {
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
  }

  async _storeIdentity(pubJwk, privJwk) {
    const cleanPriv = { kty: privJwk.kty, crv: privJwk.crv, x: privJwk.x, y: privJwk.y, d: privJwk.d };
    const priv = await crypto.subtle.importKey('jwk', cleanPriv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const rec = { pubJwk: this._pubOnly(pubJwk), priv };
    await NexusIDB.set(this.idKey, rec);
    this.keyPair = { privateKey: priv, publicKey: null };
    this.publicKeyJwkStr = JSON.stringify(rec.pubJwk);
    this.sharedKeyCache.clear();
    return rec;
  }

  // Yeni hesap açılırken bu numaraya ait eski yerel anahtarları siler (temiz başlangıç)
  async resetLocalIdentity(phoneNorm) {
    const n = String(phoneNorm || '').replace(/\D/g, '');
    await NexusIDB.del(`identity_${n}`).catch(() => {});
    await NexusIDB.del(`vault_${n}`).catch(() => {});
    await NexusIDB.del(`vaultkey_${n}`).catch(() => {});
    try { localStorage.removeItem(`nexus_identity_jwk_${n}`); localStorage.removeItem(`nexus_plain_vault_${n}`); } catch {}
  }

  async initForUser(phoneNorm) {
    this.myPhoneNorm = String(phoneNorm || '').replace(/\D/g, '');
    this.idKey = `identity_${this.myPhoneNorm}`;
    this.vaultIdbKey = `vault_${this.myPhoneNorm}`;
    this.sharedKeyCache.clear();
    this.plainCache.clear();
    this._pendingBackupJwk = null;

    let rec = await NexusIDB.get(this.idKey).catch(() => null);

    // Eski sürümden geçiş: localStorage'daki açık anahtarı güvenli depoya taşı ve sil
    const legacyKey = `nexus_identity_jwk_${this.myPhoneNorm}`;
    const legacy = localStorage.getItem(legacyKey);
    if (!rec && legacy) {
      try {
        const p = JSON.parse(legacy);
        rec = await this._storeIdentity(p.pub, p.priv);
        this._pendingBackupJwk = { pub: this._pubOnly(p.pub), priv: p.priv };
      } catch {}
    }
    if (legacy) localStorage.removeItem(legacyKey);

    if (!rec) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      rec = await this._storeIdentity(pubJwk, privJwk);
      this._pendingBackupJwk = { pub: this._pubOnly(pubJwk), priv: privJwk };
    } else {
      this.keyPair = { privateKey: rec.priv, publicKey: null };
      this.publicKeyJwkStr = JSON.stringify(rec.pubJwk);
    }

    await this._initVault();
    return this.publicKeyJwkStr;
  }

  // ---- Şifreli mesaj kasası (çözülmüş mesajlar yerelde ŞİFRELİ saklanır) ----
  async _initVault() {
    try {
      const vkName = `vaultkey_${this.myPhoneNorm}`;
      let vk = await NexusIDB.get(vkName).catch(() => null);
      if (!vk) {
        vk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await NexusIDB.set(vkName, vk);
      }
      this.vaultAesKey = vk;

      const stored = await NexusIDB.get(this.vaultIdbKey).catch(() => null);
      if (stored && stored.iv && stored.ct) {
        try {
          const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, vk, stored.ct);
          const obj = JSON.parse(new TextDecoder().decode(plain));
          for (const [k, v] of Object.entries(obj)) this.plainCache.set(k, v);
        } catch {}
      }

      // Eski sürümden geçiş: açık metin kasayı al, şifreli kaydet, sil
      const legacyVault = `nexus_plain_vault_${this.myPhoneNorm}`;
      const raw = localStorage.getItem(legacyVault);
      if (raw) {
        try {
          const obj = JSON.parse(raw);
          for (const [k, v] of Object.entries(obj)) if (!this.plainCache.has(k)) this.plainCache.set(k, v);
        } catch {}
        localStorage.removeItem(legacyVault);
        await this._persistVault();
      }
    } catch {}
  }

  async _persistVault() {
    if (!this.vaultAesKey || !this.vaultIdbKey) return;
    try {
      const entries = Array.from(this.plainCache.entries()).slice(-500);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        this.vaultAesKey,
        new TextEncoder().encode(JSON.stringify(Object.fromEntries(entries)))
      );
      await NexusIDB.set(this.vaultIdbKey, { iv, ct });
    } catch {}
  }

  saveToVault(msgId, payloadObj) {
    if (!msgId || !payloadObj) return;
    this.plainCache.set(msgId, payloadObj);
    clearTimeout(this._vaultTimer);
    this._vaultTimer = setTimeout(() => this._persistVault(), 400);
  }

  // ---- Çoklu cihaz: şifre ile korunan anahtar yedeği ----
  async _passwordKey(password, saltBytes) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 310000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  hasPendingBackup() { return Boolean(this._pendingBackupJwk); }
  clearPendingBackup() { this._pendingBackupJwk = null; }

  async createKeyBackup(password) {
    if (!this._pendingBackupJwk || !password) return '';
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await this._passwordKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(this._pendingBackupJwk)));
    return JSON.stringify({
      v: 1,
      pub: this._pendingBackupJwk.pub,
      salt: this._toB64(salt),
      iv: this._toB64(iv),
      ct: this._toB64(ct)
    });
  }

  async restoreFromBackup(backupStr, password) {
    const b = JSON.parse(backupStr);
    const k = await this._passwordKey(password, this._fromB64(b.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this._fromB64(b.iv) }, k, this._fromB64(b.ct));
    const obj = JSON.parse(new TextDecoder().decode(plain));
    await this._storeIdentity(obj.pub, obj.priv);
    this._pendingBackupJwk = null;
    return this.publicKeyJwkStr;
  }

  // Mevcut yedeği eski şifreyle açıp yeni şifreyle yeniden şifreler (anahtarın kendisi değişmez)
  async rewrapBackup(backupStr, oldPassword, newPassword) {
    const b = JSON.parse(backupStr);
    const oldK = await this._passwordKey(oldPassword, this._fromB64(b.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: this._fromB64(b.iv) }, oldK, this._fromB64(b.ct));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const newK = await this._passwordKey(newPassword, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, newK, plain);
    return JSON.stringify({ v: 1, pub: b.pub, salt: this._toB64(salt), iv: this._toB64(iv), ct: this._toB64(ct) });
  }

  // ---- Güvenlik numarası: İKİ tarafın anahtarından üretilir (iki telefonda da aynı çıkar) ----
  async computeSafetyNumber(peerPubJwkStr) {
    const norm = (s) => {
      const j = typeof s === 'string' ? JSON.parse(s) : s;
      return `${j.crv}:${j.x}:${j.y}`;
    };
    const parts = [norm(this.publicKeyJwkStr), norm(peerPubJwkStr)].sort();
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`NexusChat-Safety-v1|${parts[0]}|${parts[1]}`)));
    const blocks = [];
    for (let i = 0; i < 12; i++) {
      const n = ((d[i * 2] << 8) | d[i * 2 + 1]) % 100000;
      blocks.push(String(n).padStart(5, '0'));
    }
    return blocks.slice(0, 6).join(' ') + '\n' + blocks.slice(6).join(' ');
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
