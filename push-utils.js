/**
 * Sıfır Bağımlılıklı RFC 8291 / RFC 8292 Web Push (VAPID ES256 + aes128gcm) Motoru
 * Uygulama tamamen kapalıyken dahi telefon ve bilgisayara mesaj ve gelen arama bildirimi gönderir.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

function ensureVapidKeys(certsDir) {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }
  const vapidFile = path.join(certsDir, 'vapid.json');
  if (fs.existsSync(vapidFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
      if (saved && saved.publicKey && saved.privJwk) return saved;
    } catch {}
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubRaw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url')
  ]);

  const keys = { publicKey: pubRaw.toString('base64url'), privJwk };
  fs.writeFileSync(vapidFile, JSON.stringify(keys, null, 2), 'utf8');
  return keys;
}

function createVapidJwt(aud, vapidKeys) {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:security@nexuschat.app'
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const privKey = crypto.createPrivateKey({ key: vapidKeys.privJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

function encryptWebPushPayload(payloadStr, p256dhB64, authB64) {
  const clientPub = Buffer.from(String(p256dhB64), 'base64url');
  const authSecret = Buffer.from(String(authB64), 'base64url');
  const serverEcdh = crypto.createECDH('prime256v1');
  const serverPub = serverEcdh.generateKeys();
  const sharedSecret = serverEcdh.computeSecret(clientPub);
  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), clientPub, serverPub]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  const plain = Buffer.concat([Buffer.from(String(payloadStr), 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([serverPub.length]), serverPub]);
  return Buffer.concat([header, encrypted]);
}

function sendWebPush(subscription, payloadObj, vapidKeys) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(subscription.endpoint);
      const aud = `${parsed.protocol}//${parsed.host}`;
      const jwt = createVapidJwt(aud, vapidKeys);
      const bodyBuf = encryptWebPushPayload(
        JSON.stringify(payloadObj),
        subscription.keys.p256dh,
        subscription.keys.auth
      );

      const headers = {
        Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bodyBuf.length),
        TTL: '120',
        Urgency: 'high'
      };

      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.request(subscription.endpoint, { method: 'POST', headers, timeout: 8000 }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
      req.on('error', () => resolve({ ok: false, status: 0 }));
      req.write(bodyBuf);
      req.end();
    } catch {
      resolve({ ok: false, status: 0 });
    }
  });
}

module.exports = { ensureVapidKeys, sendWebPush };
