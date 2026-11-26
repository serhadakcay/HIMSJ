// Firebase Cloud Messaging (HTTP v1) - ek paket gerektirmez
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

let serviceAccount = null;
let cachedToken = null;
let cachedTokenExp = 0;

function loadServiceAccount() {
  if (serviceAccount) return serviceAccount;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
      const f = path.join(__dirname, 'firebase-servis-anahtari.json');
      if (fs.existsSync(f)) serviceAccount = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch (e) {
    console.error('Firebase servis anahtarı okunamadı:', e.message);
  }
  return serviceAccount;
}

function isFcmEnabled() {
  const sa = loadServiceAccount();
  return Boolean(sa && sa.private_key && sa.client_email && sa.project_id);
}

function httpsJson(method, url, headers, bodyStr) {
  return new Promise((resolve) => {
    const req = https.request(url, { method, headers, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getAccessToken() {
  const sa = loadServiceAccount();
  if (!sa) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedTokenExp - 60 > now) return cachedToken;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key).toString('base64url');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${header}.${payload}.${sig}`
  }).toString();
  const r = await httpsJson('POST', 'https://oauth2.googleapis.com/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    console.error('Firebase erişim anahtarı alınamadı:', r.status, r.json && r.json.error);
    return null;
  }
  cachedToken = r.json.access_token;
  cachedTokenExp = now + (r.json.expires_in || 3600);
  return cachedToken;
}

// Sadece "data" mesajı gönderilir: bildirimi uygulamanın kendisi oluşturur (arama ekranı için gerekli)
async function sendFcm(deviceToken, data) {
  if (!isFcmEnabled()) return { ok: false, status: 0 };
  const access = await getAccessToken();
  if (!access) return { ok: false, status: 0 };
  const strData = {};
  for (const [k, v] of Object.entries(data || {})) strData[k] = String(v == null ? '' : v);
  const body = JSON.stringify({
    message: {
      token: deviceToken,
      data: strData,
      android: { priority: 'HIGH', ttl: strData.type === 'incoming-call' ? '60s' : '86400s' }
    }
  });
  const r = await httpsJson('POST', `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
    Authorization: `Bearer ${access}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  const errCode = r.json && r.json.error && (r.json.error.status || '');
  const invalid = r.status === 404 || errCode === 'NOT_FOUND' || errCode === 'UNREGISTERED' ||
    (r.status === 400 && JSON.stringify(r.json || {}).includes('registration token'));
  return { ok: r.status === 200, status: r.status, invalid };
}

module.exports = { isFcmEnabled, sendFcm };
