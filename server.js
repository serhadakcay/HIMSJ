const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const {
  db,
  normalizePhone,
  formatPhoneDisplay,
  hashPassword,
  verifyPassword,
  generateFingerprint,
  buildInviteLinks,
  parseRawContactsText,
  initDb
} = require('./db');
const { ensureVapidKeysDb, sendWebPush } = require('./push-utils');

process.on('unhandledRejection', (err) => console.error('Yakalanmamış hata:', err && err.message ? err.message : err));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_ROOT = process.env.DATA_DIR || __dirname;
const CERTS_DIR = path.join(STORAGE_ROOT, 'certs');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let vapidKeys = null; // Başlangıçta veritabanından yüklenir

const onlineSockets = new Map();
const activeCalls = new Map();

function sendWs(socket, obj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch {}
}

function sendToUser(userId, obj, options = {}) {
  const set = onlineSockets.get(userId);
  if (!set) return;
  for (const client of set) {
    if (options.skipHiddenDesktop && client.deviceType === 'desktop' && !client.isForeground) {
      continue;
    }
    sendWs(client.socket, obj);
  }
}

// ---- Güvenlik yardımcıları ----
const loginAttempts = new Map(); // phone -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const SESSION_DAYS = 30;
const MAX_WS_FRAME = 8 * 1024 * 1024;

function checkLoginLock(phone) {
  const a = loginAttempts.get(phone);
  if (a && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function registerLoginFail(phone) {
  const a = loginAttempts.get(phone) || { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_LOGIN_ATTEMPTS) { a.lockedUntil = Date.now() + LOGIN_LOCK_MS; a.count = 0; }
  loginAttempts.set(phone, a);
}

function sanitizeMediaUrl(v) {
  const u = String(v || '').trim();
  if (!u) return '';
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  if (/^\/blobs\/[A-Za-z0-9-]+\.bin$/.test(u)) return u;
  if (/^https:\/\/[^\s"'<>]+$/.test(u)) return u;
  return '';
}
function sanitizeColor(v, def) {
  const c = String(v || '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : def;
}

// İki kullanıcı arasında rehber ilişkisi var mı? (herhangi bir yönde)
async function areConnected(a, b) {
  if (!a || !b) return false;
  const r = await db.prepare(
    'SELECT 1 FROM contacts WHERE (user_id = ? AND contact_user_id = ?) OR (user_id = ? AND contact_user_id = ?) LIMIT 1'
  ).get(a, b, b, a);
  return Boolean(r);
}

// Bu kullanıcıyla bu hedef arasında aktif bir arama var mı?
function findCallBetween(userA, userB, callId) {
  if (callId && activeCalls.has(callId)) {
    const c = activeCalls.get(callId);
    if ((c.callerId === userA && c.targetUserId === userB) || (c.callerId === userB && c.targetUserId === userA)) return c;
    return null;
  }
  for (const c of activeCalls.values()) {
    if ((c.callerId === userA && c.targetUserId === userB) || (c.callerId === userB && c.targetUserId === userA)) return c;
  }
  return null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isUserOnline(userId) {
  const set = onlineSockets.get(userId);
  return Boolean(set && set.size > 0);
}

async function broadcastPresence(userId, online) {
  try {
    await db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  } catch (e) {
    console.error('Presence hatası:', e.message);
  }
  let related = [];
  try {
    related = await db.prepare(
      'SELECT contact_user_id AS uid FROM contacts WHERE user_id = ? UNION SELECT user_id AS uid FROM contacts WHERE contact_user_id = ?'
    ).all(userId, userId);
  } catch {}
  for (const r of related) {
    sendToUser(r.uid, { type: 'PRESENCE', userId, online });
  }
}

async function triggerPushToUser(userId, payloadObj) {
  if (!vapidKeys || !userId) return;
  try {
  const subs = await db.prepare('SELECT endpoint, device_type, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    const res = await sendWebPush(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      payloadObj,
      vapidKeys
    );
    if (res.status === 404 || res.status === 410) {
      await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
    }
  }
  } catch (e) {
    console.error('Push hatası:', e.message);
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new HttpError(413, 'Dosya boyutu sınırı aşıldı.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'Geçersiz JSON verisi.'));
      }
    });
    req.on('error', reject);
  });
}

async function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  return await db.prepare(`
    SELECT u.*, s.device_type as session_device_type FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.created_at > to_char((now() - interval '30 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  `).get(token) || null;
}

function getPublicUrl(req) {
  const fixed = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  if (fixed) return fixed.replace(/\/+$/, '');
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function integratePhoneContacts(userId, normPhone, displayName, displayPhone) {
  const placeholderContacts = await db.prepare(`
    SELECT user_id, contact_user_id, contact_name, contact_phone
    FROM contacts
    WHERE contact_phone_normalized = ? AND contact_user_id != ?
  `).all(normPhone, userId);

  for (const pc of placeholderContacts) {
    const oldTarget = await db.prepare('SELECT is_registered FROM users WHERE id = ?').get(pc.contact_user_id);
    if (oldTarget && oldTarget.is_registered === 1) {
      // Asla kayıtlı bir kullanıcının kaydını veya rehber bağlantısını silme!
      continue;
    }
    if (pc.user_id === userId) {
      await db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(userId, pc.contact_user_id);
      continue;
    }
    await db.prepare(`
      INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
        contact_name = excluded.contact_name,
        contact_phone = excluded.contact_phone
    `).run(pc.user_id, userId, pc.contact_name || displayName, pc.contact_phone || displayPhone, normPhone);
    await db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(pc.user_id, pc.contact_user_id);
  }

  const savers = await db.prepare(`
    SELECT c.user_id, u.display_name as saver_name, u.phone as saver_phone, u.phone_normalized as saver_norm
    FROM contacts c
    JOIN users u ON u.id = c.user_id
    WHERE (c.contact_user_id = ? OR c.contact_phone_normalized = ?) AND c.user_id != ?
  `).all(userId, normPhone, userId);

  for (const s of savers) {
    await db.prepare(`
      INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, contact_user_id) DO NOTHING
    `).run(userId, s.user_id, s.saver_name, s.saver_phone, s.saver_norm);

    sendToUser(s.user_id, {
      type: 'CONTACT_JOINED',
      userId,
      displayName,
      phone: displayPhone
    });
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    
    if (pathname === '/api/vcard' && req.method === 'GET') {
      const rawName = String(parsedUrl.searchParams.get('name') || 'Yeni Kişi').trim();
      const rawPhone = String(parsedUrl.searchParams.get('phone') || '').trim();
      const norm = normalizePhone(rawPhone) || rawPhone;
      const parts = rawName.split(/\s+/);
      const firstName = parts[0] || rawName;
      const lastName = parts.slice(1).join(' ');
      const vcf = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N;CHARSET=UTF-8:${lastName};${firstName};;;`,
        `FN;CHARSET=UTF-8:${rawName}`,
        `TEL;TYPE=CELL,VOICE:${norm}`,
        'END:VCARD'
      ].join('\r\n');

      const safeFileName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'kisi';
      res.writeHead(200, {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFileName}.vcf"`,
        'Cache-Control': 'no-store'
      });
      return res.end(vcf);
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
      return sendJson(res, 200, { publicKey: vapidKeys.publicKey });
    }

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const displayName = String(body.displayName || '').trim();
      const normPhone = normalizePhone(body.phone);
      const displayPhone = formatPhoneDisplay(body.phone);
      const password = String(body.password || '');
      const publicKeyJwk = String(body.publicKeyJwk || '');
      const deviceType = body.deviceType === 'desktop' ? 'desktop' : 'mobile';

      if (displayName.length < 2) return sendJson(res, 400, { error: 'Ad Soyad en az 2 karakter olmalıdır.' });
      if (normPhone.length < 7) return sendJson(res, 400, { error: 'Geçerli bir cep telefonu numarası girin.' });
      if (password.length < 8) return sendJson(res, 400, { error: 'Şifre en az 8 karakter olmalıdır.' });

      const existing = await db.prepare('SELECT * FROM users WHERE phone_normalized = ?').get(normPhone);
      if (existing && existing.is_registered === 1) {
        return sendJson(res, 409, { error: 'Bu telefon numarası zaten kayıtlı. Giriş Yap sekmesinden giriş yapın.' });
      }

      const { hash, salt } = hashPassword(password);
      const fingerprint = generateFingerprint(publicKeyJwk || normPhone);
      let userId;

      if (existing && existing.is_registered === 0) {
        userId = existing.id;
        await db.prepare(`
          UPDATE users
          SET display_name = ?, phone = ?, password_hash = ?, password_salt = ?,
              is_registered = 1, public_key_jwk = ?, key_fingerprint = ?
          WHERE id = ?
        `).run(displayName, displayPhone, hash, salt, publicKeyJwk, fingerprint, userId);
      } else {
        userId = 'usr_' + crypto.randomBytes(6).toString('hex');
        const colors = ['#00a884', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        await db.prepare(`
          INSERT INTO users (id, display_name, phone, phone_normalized, password_hash, password_salt, is_registered, public_key_jwk, key_fingerprint, avatar_color)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(userId, displayName, displayPhone, normPhone, hash, salt, publicKeyJwk, fingerprint, color);
      }

      const keyBackup = String(body.keyBackup || '').slice(0, 20000);
      if (keyBackup) await db.prepare('UPDATE users SET key_backup = ? WHERE id = ?').run(keyBackup, userId);

      await integratePhoneContacts(userId, normPhone, displayName, displayPhone);

      const token = crypto.randomBytes(32).toString('hex');
      await db.prepare('INSERT INTO sessions (token, user_id, device_name, device_type) VALUES (?, ?, ?, ?)').run(token, userId, deviceType === 'desktop' ? 'Bilgisayar' : 'Cep Telefonu', deviceType);
      const user = await db.prepare('SELECT id, display_name, phone, phone_normalized, public_key_jwk, key_fingerprint, avatar_color, avatar_url, bio FROM users WHERE id = ?').get(userId);
      return sendJson(res, 201, { token, user });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const normPhone = normalizePhone(body.phone);
      const password = String(body.password || '');
      const publicKeyJwk = String(body.publicKeyJwk || '');
      const deviceType = body.deviceType === 'desktop' ? 'desktop' : 'mobile';

      const lockMin = checkLoginLock(normPhone);
      if (lockMin > 0) return sendJson(res, 429, { error: `Çok fazla hatalı deneme. ${lockMin} dakika sonra tekrar deneyin.` });
      const userRow = await db.prepare('SELECT * FROM users WHERE phone_normalized = ? AND is_registered = 1').get(normPhone);
      if (!userRow) return sendJson(res, 404, { error: 'Bu numaraya ait kayıtlı hesap bulunamadı. Önce Kayıt Olun.' });
      if (!verifyPassword(password, userRow.password_hash, userRow.password_salt)) {
        registerLoginFail(normPhone);
        return sendJson(res, 401, { error: 'Hatalı şifre girdiniz!' });
      }
      loginAttempts.delete(normPhone);

      if (publicKeyJwk && publicKeyJwk !== userRow.public_key_jwk && !userRow.key_backup) {
        const fp = generateFingerprint(publicKeyJwk);
        await db.prepare('UPDATE users SET public_key_jwk = ?, key_fingerprint = ? WHERE id = ?').run(publicKeyJwk, fp, userRow.id);
        userRow.public_key_jwk = publicKeyJwk;
        userRow.key_fingerprint = fp;
      }

      const token = crypto.randomBytes(32).toString('hex');
      await db.prepare('INSERT INTO sessions (token, user_id, device_name, device_type) VALUES (?, ?, ?, ?)').run(token, userRow.id, deviceType === 'desktop' ? 'Bilgisayar' : 'Cep Telefonu', deviceType);

      return sendJson(res, 200, {
        token,
        user: {
          id: userRow.id,
          display_name: userRow.display_name,
          phone: userRow.phone,
          phone_normalized: userRow.phone_normalized,
          public_key_jwk: userRow.public_key_jwk,
          key_fingerprint: userRow.key_fingerprint,
          avatar_color: userRow.avatar_color,
          avatar_url: userRow.avatar_url || '',
          bio: userRow.bio || '',
          key_backup: userRow.key_backup || ''
        }
      });
    }

    if (pathname.startsWith('/api/')) {
      const me = await getAuthUser(req);
      if (!me) return sendJson(res, 401, { error: 'Oturum geçersiz.' });

      
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const authHeader = req.headers['authorization'] || '';
        const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (tok) await db.prepare('DELETE FROM sessions WHERE token = ?').run(tok);
        return sendJson(res, 200, { ok: true });
      }

      // Kendi anahtar yedeğini getir (şifre değiştirmeden önce yeniden şifrelemek için)
      if (pathname === '/api/auth/key-backup' && req.method === 'GET') {
        const row = await db.prepare('SELECT key_backup FROM users WHERE id = ?').get(me.id);
        return sendJson(res, 200, { keyBackup: (row && row.key_backup) || '' });
      }

      // Şifre değiştir: eski şifre doğrulanır, anahtar yedeği yeni şifreyle güncellenir, diğer oturumlar kapatılır
      if (pathname === '/api/auth/password' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const oldPw = String(body.oldPassword || '');
        const newPw = String(body.newPassword || '');
        if (!verifyPassword(oldPw, me.password_hash, me.password_salt)) {
          return sendJson(res, 401, { error: 'Mevcut şifreniz hatalı.' });
        }
        if (newPw.length < 8) return sendJson(res, 400, { error: 'Yeni şifre en az 8 karakter olmalıdır.' });
        if (newPw === oldPw) return sendJson(res, 400, { error: 'Yeni şifre eskisiyle aynı olamaz.' });
        const current = await db.prepare('SELECT key_backup FROM users WHERE id = ?').get(me.id);
        const newBackup = String(body.keyBackup || '').slice(0, 20000);
        if (current && current.key_backup) {
          // Yedek varsa yeni şifreyle şifrelenmiş hali gönderilmek zorunda ve aynı anahtara ait olmalı
          let samePub = false;
          try {
            const a = JSON.parse(current.key_backup).pub;
            const b = JSON.parse(newBackup).pub;
            samePub = a && b && a.x === b.x && a.y === b.y;
          } catch {}
          if (!samePub) return sendJson(res, 400, { error: 'Anahtar yedeği güncellenemedi. Şifre değiştirilmedi.' });
        }
        const { hash, salt } = hashPassword(newPw);
        await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, me.id);
        if (newBackup && current && current.key_backup) {
          await db.prepare('UPDATE users SET key_backup = ? WHERE id = ?').run(newBackup, me.id);
        }
        const authHeader = req.headers['authorization'] || '';
        const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(me.id, tok);
        return sendJson(res, 200, { ok: true });
      }

      // Hesabı kalıcı olarak sil (şifre onayı ister). Mesajlar, rehber, aramalar, durumlar ve dosyalar da silinir.
      if (pathname === '/api/auth/account' && req.method === 'DELETE') {
        const body = await readJsonBody(req);
        if (!verifyPassword(String(body.password || ''), me.password_hash, me.password_salt)) {
          return sendJson(res, 401, { error: 'Şifre hatalı. Hesap silinmedi.' });
        }
        await db.prepare('DELETE FROM users WHERE id = ?').run(me.id);
        // Artık hiçbir rehberde bulunmayan kayıtsız (yer tutucu) kişileri temizle
        await db.prepare(`
          DELETE FROM users u WHERE u.is_registered = 0
            AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.contact_user_id = u.id)
        `).run();
        const set = onlineSockets.get(me.id);
        if (set) { for (const cl of set) { try { cl.socket.destroy(); } catch {} } onlineSockets.delete(me.id); }
        for (const [id, call] of activeCalls) if (call.callerId === me.id || call.targetUserId === me.id) activeCalls.delete(id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/auth/me' && req.method === 'GET') {
        return sendJson(res, 200, {
          user: {
            id: me.id,
            display_name: me.display_name,
            phone: me.phone,
            phone_normalized: me.phone_normalized,
            public_key_jwk: me.public_key_jwk,
            key_fingerprint: me.key_fingerprint,
            avatar_color: me.avatar_color,
            avatar_url: me.avatar_url || '',
            bio: me.bio || ''
          }
        });
      }

      
      if (pathname === '/api/auth/keys' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const pub = String(body.publicKeyJwk || '');
        const keyBackup = String(body.keyBackup || '').slice(0, 20000);
        const current = await db.prepare('SELECT key_backup FROM users WHERE id = ?').get(me.id);
        let backupPub = '';
        if (current && current.key_backup) {
          try {
            const bp = JSON.parse(current.key_backup).pub;
            if (bp) backupPub = `${bp.x}:${bp.y}`;
          } catch {}
        }
        if (pub) {
          let newPub = '';
          try { const j = JSON.parse(pub); newPub = `${j.x}:${j.y}`; } catch {}
          if (!newPub) return sendJson(res, 400, { error: 'Geçersiz anahtar.' });
          // Hesabın anahtar yedeği varsa, tüm cihazlar aynı anahtarı kullanmak zorunda
          if (backupPub && newPub !== backupPub) {
            return sendJson(res, 409, { error: 'Anahtar yedeği farklı. Bu cihazda çıkış yapıp şifrenizle tekrar giriş yapın.' });
          }
          const fp = generateFingerprint(pub);
          await db.prepare('UPDATE users SET public_key_jwk = ?, key_fingerprint = ? WHERE id = ?').run(pub, fp, me.id);
        }
        // Yedek sadece hiç yoksa kaydedilir (başka bir cihazın yedeğinin üzerine yazılmaz)
        if (keyBackup && !backupPub) {
          await db.prepare('UPDATE users SET key_backup = ? WHERE id = ?').run(keyBackup, me.id);
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/auth/profile' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const displayName = String(body.displayName || me.display_name).trim().slice(0, 60);
        const bio = String(body.bio ?? me.bio).trim().slice(0, 300);
        const avatarUrl = body.avatarUrl !== undefined ? sanitizeMediaUrl(body.avatarUrl) : (me.avatar_url || '');
        await db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar_url = ? WHERE id = ?').run(displayName, bio, avatarUrl, me.id);
        const updated = await db.prepare('SELECT id, display_name, phone, phone_normalized, public_key_jwk, key_fingerprint, avatar_color, avatar_url, bio FROM users WHERE id = ?').get(me.id);
        return sendJson(res, 200, { user: updated });
      }

      if (pathname === '/api/blobs' && req.method === 'POST') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        const b64 = String(body.encryptedBase64 || '');
        if (!b64) return sendJson(res, 400, { error: 'Boş şifreli veri.' });
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 16) return sendJson(res, 400, { error: 'Geçersiz şifreli dosya.' });
        const blobId = crypto.randomUUID() + '.bin';
        await db.prepare('INSERT INTO blobs (id, data, owner_id) VALUES (?, ?, ?)').run(blobId, buf, me.id);
        return sendJson(res, 201, { blobUrl: `/blobs/${blobId}`, size: buf.length });
      }

      if (pathname === '/api/push/subscribe' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const sub = body.subscription;
        const deviceType = body.deviceType === 'desktop' ? 'desktop' : 'mobile';
        if (sub && sub.endpoint && sub.keys) {
          await db.prepare(`
            INSERT INTO push_subscriptions (endpoint, user_id, device_type, p256dh, auth, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, device_type = excluded.device_type, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = CURRENT_TIMESTAMP
          `).run(sub.endpoint, me.id, deviceType, sub.keys.p256dh, sub.keys.auth);
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.endpoint) await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(body.endpoint);
        else if (body.deviceType === 'desktop') await db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND device_type = 'desktop'").run(me.id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/contacts/add' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let list = Array.isArray(body.contacts) ? body.contacts.slice() : [];
        if (body.rawText) list.push(...parseRawContactsText(body.rawText));
        if (list.length === 0 && (body.name || body.phone)) list.push({ name: body.name, phone: body.phone });

        const appUrl = getPublicUrl(req);
        const addedResults = [];
        let skippedSelf = false;

        for (const item of list) {
          if (!item) continue;
          const rawName = Array.isArray(item.name) ? item.name[0] : item.name;
          const rawPhones = Array.isArray(item.tel) ? item.tel : (Array.isArray(item.phone) ? item.phone : [item.phone || item.tel]);

          for (const rawP of rawPhones) {
            const norm = normalizePhone(rawP);
            if (norm.length < 7) continue;
            if (norm === me.phone_normalized) { skippedSelf = true; continue; }

            const dispPhone = formatPhoneDisplay(rawP);
            const cleanName = String(rawName || dispPhone).trim();

            let target = await db.prepare('SELECT * FROM users WHERE phone_normalized = ?').get(norm);
            if (!target) {
              const newId = 'usr_' + crypto.randomBytes(6).toString('hex');
              const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
              await db.prepare(`
                INSERT INTO users (id, display_name, phone, phone_normalized, password_hash, password_salt, is_registered, avatar_color)
                VALUES (?, ?, ?, ?, ?, ?, 0, '#64748b')
              `).run(newId, cleanName, dispPhone, norm, hash, salt);
              target = await db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
            }

            await db.prepare(`
              INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
                contact_name = excluded.contact_name,
                contact_phone = excluded.contact_phone,
                contact_phone_normalized = excluded.contact_phone_normalized
            `).run(me.id, target.id, cleanName, dispPhone, norm);

            if (target.is_registered === 1) {
              await db.prepare(`
                INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, contact_user_id) DO NOTHING
              `).run(target.id, me.id, me.display_name, me.phone, me.phone_normalized);
            }

            const invite = buildInviteLinks({
              targetPhone: dispPhone,
              targetName: cleanName,
              senderName: me.display_name,
              senderPhone: me.phone,
              appUrl
            });

            addedResults.push({
              id: target.id,
              display_name: cleanName,
              phone: dispPhone,
              isRegistered: Boolean(target.is_registered),
              online: isUserOnline(target.id),
              publicKeyJwk: target.public_key_jwk,
              keyFingerprint: target.key_fingerprint,
              avatarColor: target.avatar_color,
              avatarUrl: target.avatar_url || '',
              bio: target.bio || '',
              ...invite
            });
          }
        }

        if (addedResults.length === 0) {
          if (skippedSelf) return sendJson(res, 400, { error: 'Kendi telefon numaranızı kişi olarak ekleyemezsiniz.' });
          return sendJson(res, 400, { error: 'Geçerli bir telefon numarası bulunamadı.' });
        }
        return sendJson(res, 200, { ok: true, count: addedResults.length, contacts: addedResults });
      }

      if (pathname === '/api/contacts' && req.method === 'GET') {
        const appUrl = getPublicUrl(req);
        const rows = await db.prepare(`
          SELECT c.contact_name, c.contact_phone, c.contact_phone_normalized,
                 COALESCE(reg.id, u.id) as id,
                 COALESCE(reg.is_registered, u.is_registered) as is_registered,
                 COALESCE(NULLIF(reg.public_key_jwk, ''), u.public_key_jwk) as public_key_jwk,
                 COALESCE(NULLIF(reg.key_fingerprint, ''), u.key_fingerprint) as key_fingerprint,
                 COALESCE(reg.avatar_color, u.avatar_color) as avatar_color,
                 COALESCE(NULLIF(reg.avatar_url, ''), u.avatar_url) as avatar_url,
                 COALESCE(NULLIF(reg.bio, ''), u.bio) as bio
          FROM contacts c
          JOIN users u ON u.id = c.contact_user_id
          LEFT JOIN users reg ON reg.phone_normalized = c.contact_phone_normalized AND reg.is_registered = 1
          WHERE c.user_id = ?
          ORDER BY is_registered DESC, c.contact_name ASC
        `).all(me.id);

        const savedIds = new Set(rows.map((r) => r.id));
        savedIds.add(me.id);

        const contacts = rows.map((r) => {
          const invite = buildInviteLinks({
            targetPhone: r.contact_phone,
            targetName: r.contact_name,
            senderName: me.display_name,
            senderPhone: me.phone,
            appUrl
          });
          return {
            id: r.id,
            display_name: r.contact_name,
            phone: r.contact_phone,
            isRegistered: Boolean(r.is_registered),
            online: isUserOnline(r.id),
            publicKeyJwk: r.public_key_jwk,
            keyFingerprint: r.key_fingerprint,
            avatarColor: r.avatar_color,
            avatarUrl: r.avatar_url || '',
            bio: r.bio || '',
            isSaved: true,
            ...invite
          };
        });

        // Gizlilik: Tüm kullanıcı listesi artık paylaşılmıyor
        const allRegistered = [];
        const discoverable = allRegistered
          .filter((u) => !savedIds.has(u.id))
          .map((u) => ({
            id: u.id,
            display_name: u.display_name,
            phone: u.phone,
            avatarColor: u.avatar_color,
            avatarUrl: u.avatar_url || '',
            bio: u.bio || '',
            online: isUserOnline(u.id)
          }));

        return sendJson(res, 200, { contacts, discoverable });
      }

      // HTTP ÜZERİNDEN ARAMA BAŞLATMA VE DURUM KONTROLÜ (WebSocket uyuduğunda bile %100 çalışır)
      if (pathname === '/api/calls/offer' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const callId = String(body.callId || ('call_' + crypto.randomBytes(6).toString('hex')));
        const targetUserId = String(body.targetUserId || '');
        const callType = body.callType === 'video' ? 'video' : 'audio';
        if (!targetUserId || !(await areConnected(me.id, targetUserId))) {
          return sendJson(res, 403, { error: 'Bu kişiyi arama yetkiniz yok. Önce rehbere ekleyin.' });
        }
        if (activeCalls.has(callId) && activeCalls.get(callId).callerId !== me.id) {
          return sendJson(res, 409, { error: 'Geçersiz çağrı kimliği.' });
        }

        const callObj = {
          callId,
          callerId: me.id,
          fromUserId: me.id,
          callerName: me.display_name,
          fromDisplayName: me.display_name,
          targetUserId,
          callType,
          sdp: body.sdp,
          iceCandidates: [],
          status: 'ringing',
          createdAt: Date.now()
        };
        activeCalls.set(callId, callObj);

        if (targetUserId) {
          sendToUser(targetUserId, { type: 'CALL_OFFER', ...callObj }, { skipHiddenDesktop: true });
          await triggerPushToUser(targetUserId, {
            type: 'incoming-call',
            callId,
            callerId: me.id,
            callerName: me.display_name,
            callType,
            title: `📞 GELEN ARAMA: ${me.display_name}`,
            body: callType === 'video' ? '📹 Görüntülü Arama Geliyor — Yanıtlamak için dokunun' : '📞 Sesli Arama Geliyor — Yanıtlamak için dokunun'
          });
        }
        return sendJson(res, 201, { ok: true, callId });
      }

      if (pathname === '/api/calls/poll' && req.method === 'GET') {
        const now = Date.now();
        let incoming = null;
        for (const [id, c] of activeCalls.entries()) {
          if (now - c.createdAt > 65000) {
            activeCalls.delete(id);
            continue;
          }
          if (c.targetUserId === me.id && c.status === 'ringing') {
            incoming = c;
          }
        }
        return sendJson(res, 200, { incomingCall: incoming });
      }

      if (pathname === '/api/calls/active' && req.method === 'GET') {
        const callId = parsedUrl.searchParams.get('callId');
        if (callId && activeCalls.has(callId)) {
          const c = activeCalls.get(callId);
          if (c.callerId === me.id || c.targetUserId === me.id) return sendJson(res, 200, { call: c });
        }
        for (const call of activeCalls.values()) {
          if (call.targetUserId === me.id && call.status === 'ringing') return sendJson(res, 200, { call });
        }
        return sendJson(res, 404, { error: 'Aktif çağrı yok.' });
      }

      if (pathname === '/api/calls' && req.method === 'GET') {
        const rows = await db.prepare(`
          SELECT cl.*,
                 u1.display_name as caller_name, u1.phone as caller_phone,
                 u2.display_name as callee_name, u2.phone as callee_phone
          FROM call_logs cl
          JOIN users u1 ON u1.id = cl.caller_id
          JOIN users u2 ON u2.id = cl.callee_id
          WHERE cl.caller_id = ? OR cl.callee_id = ?
          ORDER BY cl.created_at DESC
          LIMIT 50
        `).all(me.id, me.id);
        return sendJson(res, 200, { calls: rows });
      }

      if (pathname === '/api/calls/log' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const callId = String(body.callId || ('call_' + crypto.randomBytes(6).toString('hex')));
        const callerId = String(body.callerId || me.id);
        const calleeId = String(body.calleeId || '');
        const callType = body.callType === 'video' ? 'video' : 'audio';
        const status = ['missed', 'completed', 'rejected'].includes(body.status) ? body.status : 'missed';
        const durationSec = Math.max(0, Math.min(86400, Math.floor(Number(body.durationSec) || 0)));

        if (callerId !== me.id && calleeId !== me.id) {
          return sendJson(res, 403, { error: 'Bu arama kaydını oluşturma yetkiniz yok.' });
        }
        const otherId = callerId === me.id ? calleeId : callerId;
        if (otherId && !(await areConnected(me.id, otherId))) {
          return sendJson(res, 403, { error: 'Bu arama kaydını oluşturma yetkiniz yok.' });
        }
        const existingLog = await db.prepare('SELECT caller_id, callee_id FROM call_logs WHERE id = ?').get(callId);
        if (existingLog && existingLog.caller_id !== me.id && existingLog.callee_id !== me.id) {
          return sendJson(res, 403, { error: 'Bu arama kaydını değiştirme yetkiniz yok.' });
        }
        if (calleeId) {
          await db.prepare(`
            INSERT INTO call_logs (id, caller_id, callee_id, call_type, status, duration_sec)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET status = excluded.status, duration_sec = excluded.duration_sec, call_type = excluded.call_type
          `).run(callId, callerId, calleeId, callType, status, durationSec);
        }
        return sendJson(res, 201, { ok: true });
      }

      if (pathname === '/api/stories' && req.method === 'GET') {
        const allowedIds = new Set([me.id]);
        const myContacts = await db.prepare('SELECT contact_user_id FROM contacts WHERE user_id = ?').all(me.id);
        for (const c of myContacts) allowedIds.add(c.contact_user_id);

        const rowsAll = await db.prepare(`
          SELECT s.*, u.display_name, u.avatar_color, u.avatar_url
          FROM stories s
          JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > datetime('now')
          ORDER BY s.created_at DESC
        `).all();
        const rows = rowsAll.filter((s) => allowedIds.has(s.user_id));

        const stories = await Promise.all(rows.map(async (s) => {
          const views = await db.prepare(`
            SELECT sv.viewer_id, u.display_name, sv.viewed_at
            FROM story_views sv JOIN users u ON u.id = sv.viewer_id
            WHERE sv.story_id = ?
          `).all(s.id);
          return { ...s, viewCount: views.length, views, viewedByMe: views.some((v) => v.viewer_id === me.id) };
        }));

        return sendJson(res, 200, { stories });
      }

      if (pathname === '/api/stories' && req.method === 'POST') {
        const body = await readJsonBody(req, 15 * 1024 * 1024);
        const caption = String(body.caption || '').trim();
        const mediaUrl = sanitizeMediaUrl(body.mediaUrl);
        const bgColor = sanitizeColor(body.bgColor, '#0f766e');
        if (!caption && !mediaUrl) return sendJson(res, 400, { error: 'Durum metni veya fotoğrafı seçin.' });

        const storyId = 'st_' + crypto.randomBytes(6).toString('hex');
        await db.prepare(`
          INSERT INTO stories (id, user_id, caption, media_url, bg_color, expires_at)
          VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
        `).run(storyId, me.id, caption, mediaUrl, bgColor);

        return sendJson(res, 201, { ok: true, storyId });
      }

      const storyViewMatch = pathname.match(/^\/api\/stories\/([^/]+)\/view$/);
      if (storyViewMatch && req.method === 'POST') {
        const st = await db.prepare('SELECT id FROM stories WHERE id = ?').get(storyViewMatch[1]);
        if (!st) return sendJson(res, 404, { error: 'Durum bulunamadı.' });
        await db.prepare('INSERT INTO story_views (story_id, viewer_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(storyViewMatch[1], me.id);
        return sendJson(res, 200, { ok: true });
      }

      const msgMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (msgMatch) {
        const peerId = msgMatch[1];
        const peerExists = await db.prepare('SELECT id FROM users WHERE id = ?').get(peerId);
        if (!peerExists) return sendJson(res, 404, { error: 'Kişi bulunamadı.' });

        if (req.method === 'GET') {
          const peerInfo = await db.prepare('SELECT phone_normalized FROM users WHERE id = ?').get(peerId);
          const peerIds = [peerId];
          if (peerInfo && peerInfo.phone_normalized) {
            const alts = await db.prepare('SELECT id FROM users WHERE phone_normalized = ?').all(peerInfo.phone_normalized);
            for (const a of alts) if (!peerIds.includes(a.id)) peerIds.push(a.id);
          }
          const placeholders = peerIds.map(() => '?').join(',');
          const rows = await db.prepare(`
            SELECT * FROM messages
            WHERE (sender_id = ? AND recipient_id IN (${placeholders}))
               OR (sender_id IN (${placeholders}) AND recipient_id = ?)
            ORDER BY seq DESC
            LIMIT 250
          `).all(me.id, ...peerIds, ...peerIds, me.id);
          return sendJson(res, 200, { messages: rows.reverse() });
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');
          const msgType = String(body.msgType || 'text');
          const ciphertext = String(body.ciphertext || '');
          const iv = String(body.iv || '');
          if (!ciphertext || !iv) return sendJson(res, 400, { error: 'Boş şifreli mesaj.' });
          const msgNum = Number(body.msgNum || 0);
          const ttlMs = Number(body.ttlMs || 0);
          const senderPub = String(body.senderPublicKeyJwk || me.public_key_jwk || '');
          const peerRow = await db.prepare('SELECT public_key_jwk FROM users WHERE id = ?').get(peerId);
          const recipientPub = String(body.recipientPublicKeyJwk || (peerRow && peerRow.public_key_jwk) || '');

          await db.prepare(`
            INSERT INTO messages (id, sender_id, recipient_id, msg_type, ciphertext, iv, msg_num, sender_public_key_jwk, recipient_public_key_jwk, ttl_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(msgId, me.id, peerId, msgType, ciphertext, iv, msgNum, senderPub, recipientPub, ttlMs);

          const savedMsg = await db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
          sendToUser(peerId, { type: 'NEW_ENCRYPTED_MESSAGE', senderName: me.display_name, message: savedMsg });

          await triggerPushToUser(peerId, {
            type: 'new-message',
            senderId: me.id,
            senderName: me.display_name,
            title: `💬 ${me.display_name}`,
            body: '🔒 Yeni uçtan uca şifreli mesajınız var'
          });

          return sendJson(res, 201, { message: savedMsg });
        }
      }
    }

    if (pathname.startsWith('/blobs/')) {
      const safeBlob = path.basename(pathname);
      const blobRow = await db.prepare('SELECT data FROM blobs WHERE id = ?').get(safeBlob);
      if (blobRow && blobRow.data) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Content-Length': String(blobRow.data.length) });
        return res.end(blobRow.data);
      }
      res.writeHead(404);
      return res.end('Blob Not Found');
    }

    const reqPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(reqPath).replace(/^(\.\.([/\\]))+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0' });
      return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    if (err && err.status) {
      if (!res.headersSent) sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error('Sunucu hatası:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Sunucu hatası. Lütfen tekrar deneyin.' });
  }
});

server.on('upgrade', async (req, socket) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = parsedUrl.searchParams.get('token') || '';
  const deviceType = parsedUrl.searchParams.get('deviceType') === 'desktop' ? 'desktop' : 'mobile';
  let me = null;
  try {
    me = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  } catch (e) {
    console.error('WS oturum hatası:', e.message);
  }

  if (!me) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }

  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const clientEntry = { socket, deviceType, isForeground: true };
  if (!onlineSockets.has(me.id)) onlineSockets.set(me.id, new Set());
  const wasOffline = onlineSockets.get(me.id).size === 0;
  onlineSockets.get(me.id).add(clientEntry);
  if (wasOffline) broadcastPresence(me.id, true);

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(buffer[1] & 0x80);
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (opcode === 0x08) return socket.end();
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (len > MAX_WS_FRAME) { socket.destroy(); return; }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;

      const payload = Buffer.alloc(len);
      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        for (let i = 0; i < len; i++) payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
      } else {
        buffer.copy(payload, 0, offset, offset + len);
      }
      buffer = buffer.slice(offset + maskLen + len);

      if (opcode === 0x09) {
        socket.write(Buffer.from([0x8a, 0x00]));
        continue;
      }

      if (opcode === 0x01) {
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          if (msg.type === 'PING') {
            sendWs(socket, { type: 'PONG' });
          } else if (msg.type === 'VISIBILITY') {
            clientEntry.isForeground = Boolean(msg.visible);
          } else if (['CALL_OFFER', 'CALL_ANSWER', 'ICE_CANDIDATE', 'CALL_REJECT', 'CALL_END', 'CALL_MISSED', 'CALL_MEDIA'].includes(msg.type)) {
            handleSignal(msg);
          }
        } catch {}
      }
    }
  });

  // Arama sinyallerini yetki kontrolüyle işler
  async function handleSignal(msg) {
    try {
            const targetId = String(msg.targetUserId || '');
            if (!targetId || targetId === me.id) return;
            if (msg.type === 'CALL_OFFER') {
              if (!(await areConnected(me.id, targetId))) {
                sendWs(socket, { type: 'CALL_ERROR', callId: msg.callId, error: 'Bu kişiyi arama yetkiniz yok. Önce rehbere ekleyin.' });
                return;
              }
              if (msg.callId && activeCalls.has(msg.callId) && activeCalls.get(msg.callId).callerId !== me.id) return;
            } else {
              // Diğer tüm sinyaller sadece iki taraf arasında aktif bir arama varsa iletilir
              if (!findCallBetween(me.id, targetId, msg.callId)) return;
            }
            const callId = msg.callId || ('call_' + crypto.randomBytes(6).toString('hex'));
            const packet = { ...msg, callId, fromUserId: me.id, fromDisplayName: me.display_name };

            if (msg.type === 'CALL_OFFER') {
              activeCalls.set(callId, {
                callId,
                callerId: me.id,
                fromUserId: me.id,
                callerName: me.display_name,
                fromDisplayName: me.display_name,
                targetUserId: msg.targetUserId,
                callType: msg.callType || 'audio',
                sdp: msg.sdp,
                iceCandidates: [],
                status: 'ringing',
                createdAt: Date.now()
              });

              if (msg.targetUserId) {
                sendToUser(msg.targetUserId, packet, { skipHiddenDesktop: true });
              }

              triggerPushToUser(msg.targetUserId, {
                type: 'incoming-call',
                callId,
                callerId: me.id,
                callerName: me.display_name,
                callType: msg.callType || 'audio',
                title: `📞 GELEN ARAMA: ${me.display_name}`,
                body: msg.callType === 'video' ? '📹 Görüntülü Arama Geliyor — Yanıtlamak için dokunun' : '📞 Sesli Arama Geliyor — Yanıtlamak için dokunun'
              });
              return;
            } else if (msg.type === 'CALL_ANSWER') {
              const ac = findCallBetween(me.id, targetId, callId);
              if (ac && ac.targetUserId === me.id) ac.status = 'answered';
            } else if (msg.type === 'CALL_MISSED') {
              activeCalls.delete(callId);
              if (msg.targetUserId) {
                db['prepare'](`
                  INSERT INTO call_logs (id, caller_id, callee_id, call_type, status, duration_sec)
                  VALUES (?, ?, ?, ?, 'missed', 0)
                  ON CONFLICT (id) DO NOTHING
                `).run(callId, me.id, msg.targetUserId, msg.callType || 'audio').catch((e) => console.error('Arama kaydı hatası:', e.message));

                sendToUser(msg.targetUserId, packet);
                triggerPushToUser(msg.targetUserId, {
                  type: 'missed-call',
                  senderId: me.id,
                  title: `📵 Cevapsız Arama: ${me.display_name}`,
                  body: `${me.display_name} sizi aradı (${msg.callType === 'video' ? 'Görüntülü' : 'Sesli'})`
                });
              }
              return;
            } else if (msg.type === 'ICE_CANDIDATE' && msg.candidate) {
              const c = findCallBetween(me.id, targetId, msg.callId);
              if (c && c.callerId === me.id && c.iceCandidates.length < 100) c.iceCandidates.push(msg.candidate);
            } else if (msg.type === 'CALL_REJECT' || msg.type === 'CALL_END') {
              activeCalls.delete(callId);
            }

            sendToUser(targetId, packet);
    } catch (e) {
      console.error('Sinyal hatası:', e.message);
    }
  }

  const cleanup = () => {
    const set = onlineSockets.get(me.id);
    if (set) {
      set.delete(clientEntry);
      if (set.size === 0) {
        onlineSockets.delete(me.id);
        broadcastPresence(me.id, false);
      }
    }
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

(async () => {
  try {
    await initDb();
    vapidKeys = await ensureVapidKeysDb(db);
  } catch (e) {
    console.error('[HATA] Veritabanına bağlanılamadı:', e.message);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 NexusChat v14 Ultimate Sunucusu Çalışıyor (PostgreSQL) -> Port: ${PORT}`);
  });
})();
