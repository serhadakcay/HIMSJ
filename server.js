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
  parseRawContactsText
} = require('./db');
const { ensureVapidKeys, sendWebPush } = require('./push-utils');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERTS_DIR = path.join(__dirname, 'certs');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const vapidKeys = ensureVapidKeys(CERTS_DIR);

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

function isUserOnline(userId) {
  const set = onlineSockets.get(userId);
  return Boolean(set && set.size > 0);
}

function broadcastPresence(userId, online) {
  db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
  for (const set of onlineSockets.values()) {
    for (const client of set) sendWs(client.socket, { type: 'PRESENCE', userId, online });
  }
}

async function triggerPushToUser(userId, payloadObj) {
  const set = onlineSockets.get(userId) || new Set();
  const hasForegroundDesktop = Array.from(set).some((c) => c.deviceType === 'desktop' && c.isForeground);

  const subs = db.prepare('SELECT endpoint, device_type, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    if (s.device_type === 'desktop' && !hasForegroundDesktop) {
      continue;
    }
    const res = await sendWebPush(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      payloadObj,
      vapidKeys
    );
    if (res.status === 404 || res.status === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
    }
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
        reject(new Error('Dosya boyutu 25MB sınırını aşıyor.'));
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
        reject(new Error('Geçersiz JSON verisi.'));
      }
    });
    req.on('error', reject);
  });
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return null;
  return db.prepare(`
    SELECT u.*, s.device_type as session_device_type FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(token) || null;
}

function getPublicUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

function integratePhoneContacts(userId, normPhone, displayName, displayPhone) {
  const savers = db.prepare(`
    SELECT c.user_id, u.display_name as saver_name, u.phone as saver_phone, u.phone_normalized as saver_norm
    FROM contacts c
    JOIN users u ON u.id = c.user_id
    WHERE c.contact_phone_normalized = ? AND c.user_id != ?
  `).all(normPhone, userId);

  for (const s of savers) {
    db.prepare(`
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
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    if (pathname === '/api/push/vapid-key' && req.method === 'GET') {
      return sendJson(res, 200, { publicKey: vapidKeys.publicKey });
    }

    // 1. KAYIT OLMA
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
      if (password.length < 4) return sendJson(res, 400, { error: 'Şifre en az 4 karakter olmalıdır.' });

      const existing = db.prepare('SELECT * FROM users WHERE phone_normalized = ?').get(normPhone);
      if (existing && existing.is_registered === 1) {
        return sendJson(res, 409, { error: 'Bu telefon numarası zaten kayıtlı. Giriş Yap sekmesinden giriş yapın.' });
      }

      const { hash, salt } = hashPassword(password);
      const fingerprint = generateFingerprint(publicKeyJwk || normPhone);
      let userId;

      if (existing && existing.is_registered === 0) {
        userId = existing.id;
        db.prepare(`
          UPDATE users
          SET display_name = ?, phone = ?, password_hash = ?, password_salt = ?,
              is_registered = 1, public_key_jwk = ?, key_fingerprint = ?
          WHERE id = ?
        `).run(displayName, displayPhone, hash, salt, publicKeyJwk, fingerprint, userId);
      } else {
        userId = 'usr_' + crypto.randomBytes(6).toString('hex');
        const colors = ['#00a884', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899'];
        const color = colors[Math.floor(Math.random() * colors.length)];
        db.prepare(`
          INSERT INTO users (id, display_name, phone, phone_normalized, password_hash, password_salt, is_registered, public_key_jwk, key_fingerprint, avatar_color)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(userId, displayName, displayPhone, normPhone, hash, salt, publicKeyJwk, fingerprint, color);
      }

      integratePhoneContacts(userId, normPhone, displayName, displayPhone);

      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token, user_id, device_name, device_type) VALUES (?, ?, ?, ?)').run(token, userId, deviceType === 'desktop' ? 'Bilgisayar' : 'Cep Telefonu', deviceType);
      const user = db.prepare('SELECT id, display_name, phone, phone_normalized, public_key_jwk, key_fingerprint, avatar_color, avatar_url, bio FROM users WHERE id = ?').get(userId);
      return sendJson(res, 201, { token, user });
    }

    // 2. ŞİFRE İLE GİRİŞ YAPMA
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const normPhone = normalizePhone(body.phone);
      const password = String(body.password || '');
      const publicKeyJwk = String(body.publicKeyJwk || '');
      const deviceType = body.deviceType === 'desktop' ? 'desktop' : 'mobile';

      const userRow = db.prepare('SELECT * FROM users WHERE phone_normalized = ? AND is_registered = 1').get(normPhone);
      if (!userRow) {
        return sendJson(res, 404, { error: 'Bu numaraya ait kayıtlı hesap bulunamadı. Önce Kayıt Olun.' });
      }
      if (!verifyPassword(password, userRow.password_hash, userRow.password_salt)) {
        return sendJson(res, 401, { error: 'Hatalı şifre girdiniz!' });
      }

      if (publicKeyJwk && publicKeyJwk !== userRow.public_key_jwk) {
        const fp = generateFingerprint(publicKeyJwk);
        db.prepare('UPDATE users SET public_key_jwk = ?, key_fingerprint = ? WHERE id = ?').run(publicKeyJwk, fp, userRow.id);
        userRow.public_key_jwk = publicKeyJwk;
        userRow.key_fingerprint = fp;
      }

      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions (token, user_id, device_name, device_type) VALUES (?, ?, ?, ?)').run(token, userRow.id, deviceType === 'desktop' ? 'Bilgisayar' : 'Cep Telefonu', deviceType);

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
          bio: userRow.bio || ''
        }
      });
    }

    // --- KİMLİK DOĞRULAMA GEREKTİREN UÇ NOKTALAR ---
    if (pathname.startsWith('/api/')) {
      const me = getAuthUser(req);
      if (!me) return sendJson(res, 401, { error: 'Oturum geçersiz.' });

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

      if (pathname === '/api/auth/profile' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const displayName = String(body.displayName || me.display_name).trim();
        const bio = String(body.bio ?? me.bio).trim();
        const avatarUrl = body.avatarUrl !== undefined ? String(body.avatarUrl) : (me.avatar_url || '');

        db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar_url = ? WHERE id = ?').run(
          displayName, bio, avatarUrl, me.id
        );
        const updated = db.prepare('SELECT id, display_name, phone, phone_normalized, public_key_jwk, key_fingerprint, avatar_color, avatar_url, bio FROM users WHERE id = ?').get(me.id);
        return sendJson(res, 200, { user: updated });
      }

      if (pathname === '/api/blobs' && req.method === 'POST') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        const b64 = String(body.encryptedBase64 || '');
        if (!b64) return sendJson(res, 400, { error: 'Boş şifreli veri.' });
        const buf = Buffer.from(b64, 'base64');
        const blobId = crypto.randomUUID() + '.bin';
        fs.writeFileSync(path.join(UPLOADS_DIR, blobId), buf);
        return sendJson(res, 201, { blobUrl: `/blobs/${blobId}`, size: buf.length });
      }

      if (pathname === '/api/push/subscribe' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const sub = body.subscription;
        const deviceType = body.deviceType === 'desktop' ? 'desktop' : 'mobile';
        if (sub && sub.endpoint && sub.keys) {
          db.prepare(`
            INSERT INTO push_subscriptions (endpoint, user_id, device_type, p256dh, auth, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, device_type = excluded.device_type, p256dh = excluded.p256dh, auth = excluded.auth, updated_at = CURRENT_TIMESTAMP
          `).run(sub.endpoint, me.id, deviceType, sub.keys.p256dh, sub.keys.auth);
        }
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body.endpoint) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(body.endpoint);
        } else if (body.deviceType === 'desktop') {
          db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND device_type = 'desktop'").run(me.id);
        }
        return sendJson(res, 200, { ok: true });
      }

      // REHBERE KİŞİ EKLEME
      if (pathname === '/api/contacts/add' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let list = Array.isArray(body.contacts) ? body.contacts.slice() : [];
        if (body.rawText) {
          list.push(...parseRawContactsText(body.rawText));
        }
        if (list.length === 0 && (body.name || body.phone)) {
          list.push({ name: body.name, phone: body.phone });
        }

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

            if (norm === me.phone_normalized) {
              skippedSelf = true;
              continue;
            }

            const dispPhone = formatPhoneDisplay(rawP);
            const cleanName = String(rawName || dispPhone).trim();

            let target = db.prepare('SELECT * FROM users WHERE phone_normalized = ?').get(norm);
            if (!target) {
              const newId = 'usr_' + crypto.randomBytes(6).toString('hex');
              const { hash, salt } = hashPassword(crypto.randomBytes(12).toString('hex'));
              db.prepare(`
                INSERT INTO users (id, display_name, phone, phone_normalized, password_hash, password_salt, is_registered, avatar_color)
                VALUES (?, ?, ?, ?, ?, ?, 0, '#64748b')
              `).run(newId, cleanName, dispPhone, norm, hash, salt);
              target = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
            }

            db.prepare(`
              INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
                contact_name = excluded.contact_name,
                contact_phone = excluded.contact_phone,
                contact_phone_normalized = excluded.contact_phone_normalized
            `).run(me.id, target.id, cleanName, dispPhone, norm);

            if (target.is_registered === 1) {
              db.prepare(`
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
        const rows = db.prepare(`
          SELECT c.contact_name, c.contact_phone, c.contact_phone_normalized,
                 u.id, u.is_registered, u.public_key_jwk, u.key_fingerprint, u.avatar_color, u.avatar_url, u.bio
          FROM contacts c
          JOIN users u ON u.id = c.contact_user_id
          WHERE c.user_id = ?
          ORDER BY u.is_registered DESC, c.contact_name ASC
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

        const allRegistered = db.prepare('SELECT id, display_name, phone, avatar_color, avatar_url, bio FROM users WHERE is_registered = 1').all();
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

      // ARAMA GEÇMİŞİ VE CEVAPSIZ ARAMA KAYITLARI
      if (pathname === '/api/calls' && req.method === 'GET') {
        const rows = db.prepare(`
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
        const durationSec = Number(body.durationSec || 0);

        if (calleeId) {
          db.prepare(`
            INSERT OR REPLACE INTO call_logs (id, caller_id, callee_id, call_type, status, duration_sec)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(callId, callerId, calleeId, callType, status, durationSec);
        }
        return sendJson(res, 201, { ok: true });
      }

      // DURUM GÜNCELLEMELERİ
      if (pathname === '/api/stories' && req.method === 'GET') {
        const allowedIds = new Set([me.id]);
        const myContacts = db.prepare('SELECT contact_user_id FROM contacts WHERE user_id = ?').all(me.id);
        for (const c of myContacts) allowedIds.add(c.contact_user_id);

        const rows = db.prepare(`
          SELECT s.*, u.display_name, u.avatar_color, u.avatar_url
          FROM stories s
          JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > datetime('now')
          ORDER BY s.created_at DESC
        `).all().filter((s) => allowedIds.has(s.user_id));

        const stories = rows.map((s) => {
          const views = db.prepare(`
            SELECT sv.viewer_id, u.display_name, sv.viewed_at
            FROM story_views sv JOIN users u ON u.id = sv.viewer_id
            WHERE sv.story_id = ?
          `).all(s.id);
          return {
            ...s,
            viewCount: views.length,
            views,
            viewedByMe: views.some((v) => v.viewer_id === me.id)
          };
        });

        return sendJson(res, 200, { stories });
      }

      if (pathname === '/api/stories' && req.method === 'POST') {
        const body = await readJsonBody(req, 15 * 1024 * 1024);
        const caption = String(body.caption || '').trim();
        const mediaUrl = String(body.mediaUrl || '');
        const bgColor = String(body.bgColor || '#0f766e');
        if (!caption && !mediaUrl) return sendJson(res, 400, { error: 'Durum metni veya fotoğrafı seçin.' });

        const storyId = 'st_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
          INSERT INTO stories (id, user_id, caption, media_url, bg_color, expires_at)
          VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
        `).run(storyId, me.id, caption, mediaUrl, bgColor);

        return sendJson(res, 201, { ok: true, storyId });
      }

      const storyViewMatch = pathname.match(/^\/api\/stories\/([^/]+)\/view$/);
      if (storyViewMatch && req.method === 'POST') {
        db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)').run(storyViewMatch[1], me.id);
        return sendJson(res, 200, { ok: true });
      }

      // ŞİFRELİ MESAJLAŞMA
      const msgMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (msgMatch) {
        const peerId = msgMatch[1];

        if (req.method === 'GET') {
          const rows = db.prepare(`
            SELECT * FROM messages
            WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
            ORDER BY created_at ASC, rowid ASC
            LIMIT 250
          `).all(me.id, peerId, peerId, me.id);
          return sendJson(res, 200, { messages: rows });
        }

        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');
          const msgType = String(body.msgType || 'text');
          const ciphertext = String(body.ciphertext || '');
          const iv = String(body.iv || '');
          const msgNum = Number(body.msgNum || 0);
          const ttlMs = Number(body.ttlMs || 0);

          db.prepare(`
            INSERT INTO messages (id, sender_id, recipient_id, msg_type, ciphertext, iv, msg_num, sender_public_key_jwk, ttl_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(msgId, me.id, peerId, msgType, ciphertext, iv, msgNum, me.public_key_jwk, ttlMs);

          const savedMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
          sendToUser(peerId, { type: 'NEW_ENCRYPTED_MESSAGE', senderName: me.display_name, message: savedMsg });

          triggerPushToUser(peerId, {
            type: 'new-message',
            senderId: me.id,
            senderName: me.display_name,
            title: `💬 ${me.display_name}`,
            body: '🔒 Yeni uçtan uca şifreli mesajınız var'
          });

          return sendJson(res, 201, { message: savedMsg });
        }
      }

      if (pathname === '/api/calls/active' && req.method === 'GET') {
        const callId = parsedUrl.searchParams.get('callId');
        if (callId && activeCalls.has(callId)) return sendJson(res, 200, { call: activeCalls.get(callId) });
        for (const call of activeCalls.values()) {
          if (call.targetUserId === me.id) return sendJson(res, 200, { call });
        }
        return sendJson(res, 404, { error: 'Aktif çağrı yok.' });
      }
    }

    if (pathname.startsWith('/blobs/')) {
      const safeBlob = path.basename(pathname);
      const blobPath = path.join(UPLOADS_DIR, safeBlob);
      if (fs.existsSync(blobPath)) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(blobPath).pipe(res);
      }
      res.writeHead(404);
      return res.end('Blob Not Found');
    }

    const reqPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(reqPath).replace(/^(\.\.([/\\]))+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Sunucu hatası' });
  }
});

server.on('upgrade', (req, socket) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const token = parsedUrl.searchParams.get('token') || '';
  const deviceType = parsedUrl.searchParams.get('deviceType') === 'desktop' ? 'desktop' : 'mobile';
  const me = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);

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
            const callId = msg.callId || ('call_' + crypto.randomBytes(6).toString('hex'));
            const packet = { ...msg, callId, fromUserId: me.id, fromDisplayName: me.display_name };

            if (msg.type === 'CALL_OFFER') {
              activeCalls.set(callId, {
                callId,
                callerId: me.id,
                callerName: me.display_name,
                targetUserId: msg.targetUserId,
                callType: msg.callType || 'audio',
                sdp: msg.sdp,
                iceCandidates: [],
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
              continue;
            } else if (msg.type === 'CALL_MISSED') {
              activeCalls.delete(callId);
              if (msg.targetUserId) {
                db.prepare(`
                  INSERT OR REPLACE INTO call_logs (id, caller_id, callee_id, call_type, status, duration_sec)
                  VALUES (?, ?, ?, ?, 'missed', 0)
                `).run(callId, me.id, msg.targetUserId, msg.callType || 'audio');

                sendToUser(msg.targetUserId, packet);
                triggerPushToUser(msg.targetUserId, {
                  type: 'missed-call',
                  senderId: me.id,
                  title: `📵 Cevapsız Arama: ${me.display_name}`,
                  body: `${me.display_name} sizi aradı (${msg.callType === 'video' ? 'Görüntülü' : 'Sesli'})`
                });
              }
              continue;
            } else if (msg.type === 'ICE_CANDIDATE' && msg.candidate) {
              for (const c of activeCalls.values()) {
                if (c.callerId === me.id) c.iceCandidates.push(msg.candidate);
              }
            } else if (msg.type === 'CALL_REJECT' || msg.type === 'CALL_END') {
              activeCalls.delete(callId);
            }

            if (msg.targetUserId) sendToUser(msg.targetUserId, packet);
          }
        } catch {}
      }
    }
  });

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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 NexusChat v7 Ultimate Sunucusu Çalışıyor -> Port: ${PORT}`);
});
