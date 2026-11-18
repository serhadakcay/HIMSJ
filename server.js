/**
 * Mesajlaşma Uygulaması - Ana Sunucu (HTTP + HTTPS + WebSocket + Telefon Rehberi + SMS/WhatsApp Davet + Otomatik Numara Entegrasyonu)
 * Windows 10/11 x64, Android, iOS ve Web Tarayıcıları ile Tam Uyumlu
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const dbModule = require('./db');
const db = dbModule.db;

function normalizePhone(rawPhone) {
  if (typeof dbModule.normalizePhone === 'function') {
    return dbModule.normalizePhone(rawPhone);
  }
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && !digits.startsWith('90')) digits = '90' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '90' + digits.slice(1);
  else if (digits.length === 13 && digits.startsWith('900')) digits = '90' + digits.slice(3);
  return '+' + digits;
}

function formatPhoneDisplay(rawPhone) {
  const cleanedRaw = String(rawPhone || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  if (typeof dbModule.formatPhoneDisplay === 'function') {
    return dbModule.formatPhoneDisplay(cleanedRaw);
  }
  const norm = normalizePhone(cleanedRaw);
  if (/^\+90\d{10}$/.test(norm)) {
    return `${norm.slice(0, 3)} ${norm.slice(3, 6)} ${norm.slice(6, 9)} ${norm.slice(9, 11)} ${norm.slice(11, 13)}`;
  }
  return String(cleanedRaw || norm).trim();
}

function buildInvitePayload(opts = {}) {
  if (typeof dbModule.buildInvitePayload === 'function') {
    return dbModule.buildInvitePayload(opts);
  }
  const { targetPhone, targetName, senderName, senderPhone, appUrl, allPhones } = opts;
  const norm = normalizePhone(targetPhone);
  const displayPhone = formatPhoneDisplay(targetPhone || norm);
  const waDigits = norm.replace(/\D/g, '');
  const phonesLabel = Array.isArray(allPhones) && allPhones.length > 0
    ? allPhones.map((p) => formatPhoneDisplay(p)).join(', ')
    : displayPhone;
  const senderLabel = senderName
    ? (senderPhone ? `${senderName} (${formatPhoneDisplay(senderPhone)})` : senderName)
    : (senderPhone ? formatPhoneDisplay(senderPhone) : 'Kullanıcı');
  const urlPart = appUrl ? ` Uygulama giriş adresi: ${appUrl}` : '';

  const messageText = `${phonesLabel} — ${senderLabel}: Bu numaraları kullanıcı sizi programı kullanmak için ekledi.${urlPart}`;
  const encodedText = encodeURIComponent(messageText);

  const whatsappUrl = waDigits
    ? `https://wa.me/${waDigits}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;
  const smsUrl = norm
    ? `sms:${norm}?body=${encodedText}`
    : `sms:?body=${encodedText}`;

  return {
    phone: displayPhone,
    phoneNormalized: norm,
    name: targetName || displayPhone,
    messageText,
    whatsappUrl,
    smsUrl
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof dbModule.hashPassword === 'function') {
    return dbModule.hashPassword(password, salt);
  }
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (typeof dbModule.verifyPassword === 'function') {
    return dbModule.verifyPassword(password, hash, salt);
  }
  const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function generateFingerprint(inputStr) {
  if (typeof dbModule.generateFingerprint === 'function') {
    return dbModule.generateFingerprint(inputStr);
  }
  const digest = crypto.createHash('sha256').update(String(inputStr || '')).digest();
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const num = digest.readUInt16BE(i * 2) % 100000;
    groups.push(String(num).padStart(5, '0'));
  }
  return groups.join(' ');
}

// Eski db.js sürümleriyle bile tam uyumluluk için eksik sütunları otomatik ekle ve demo kayıtları temizle
try {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");
  if (!userCols.includes('phone_normalized')) db.exec("ALTER TABLE users ADD COLUMN phone_normalized TEXT DEFAULT ''");
  if (!userCols.includes('is_registered')) db.exec('ALTER TABLE users ADD COLUMN is_registered INTEGER DEFAULT 1');

  const contactCols = db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name);
  if (!contactCols.includes('contact_name')) db.exec("ALTER TABLE contacts ADD COLUMN contact_name TEXT DEFAULT ''");
  if (!contactCols.includes('contact_phone')) db.exec("ALTER TABLE contacts ADD COLUMN contact_phone TEXT DEFAULT ''");
  if (!contactCols.includes('contact_phone_normalized')) db.exec("ALTER TABLE contacts ADD COLUMN contact_phone_normalized TEXT DEFAULT ''");
  if (!contactCols.includes('invited_via')) db.exec("ALTER TABLE contacts ADD COLUMN invited_via TEXT DEFAULT ''");
  if (!contactCols.includes('invited_at')) db.exec('ALTER TABLE contacts ADD COLUMN invited_at TEXT');

  db.exec(`
    DELETE FROM users WHERE id IN ('usr_serhad', 'usr_ayse', 'usr_mehmet', 'usr_zeynep', 'usr_can');
    DELETE FROM conversations WHERE id IN ('conv_proje_ekibi', 'conv_duyuru_kanali', 'conv_dm_ayse');
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_user_contact
    ON contacts(user_id, contact_user_id);
  `);

  const usersWithoutNorm = db.prepare("SELECT id, phone FROM users WHERE phone != '' AND (phone_normalized IS NULL OR phone_normalized = '')").all();
  for (const u of usersWithoutNorm) {
    db.prepare('UPDATE users SET phone_normalized = ? WHERE id = ?').run(normalizePhone(u.phone), u.id);
  }
} catch {}

let getLocalIPs, ensureTlsCertificate, generateQrSvg;
try {
  ({ getLocalIPs, ensureTlsCertificate, generateQrSvg } = require('./utils'));
} catch {
  const os = require('node:os');
  getLocalIPs = () => {
    const nets = os.networkInterfaces();
    const res = [];
    for (const [name, list] of Object.entries(nets)) {
      for (const i of list || []) {
        if (i.family === 'IPv4' && !i.internal) res.push({ name, address: i.address, isPrivate: true });
      }
    }
    return res;
  };
  ensureTlsCertificate = () => { throw new Error('Bulut modunda yerel sertifika gerekmez'); };
  generateQrSvg = (text, size = 240) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="11" fill="#0f172a">${text}</text></svg>`;
}

const HTTP_PORT = Number(process.env.PORT || 3080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CERTS_DIR = path.join(__dirname, 'certs');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Hız Sınırlama (Rate Limiter)
const rateBuckets = new Map();
function checkRateLimit(ip, limit = 360, windowMs = 60000) {
  const now = Date.now();
  let entry = rateBuckets.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(ip, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.vcf': 'text/vcard; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.exe': 'application/octet-stream'
};

// --- Aktif WebSocket Bağlantıları ve Arka Plan Heartbeat Takibi ---
const onlineClients = new Map();
const backgroundHeartbeats = new Map(); // userId -> timestamp (ms)
const activeIncomingCalls = new Map(); // callId -> { callId, callerId, callerName, callerAvatar, callType, conversationId, targetUserId, sdp, status, createdAt }

function isUserOnline(userId) {
  const set = onlineClients.get(userId);
  if (set && set.size > 0) return true;
  const lastHb = backgroundHeartbeats.get(userId);
  if (lastHb && Date.now() - lastHb < 45000) return true;
  return false;
}

function sendWsFrame(socket, payloadObj) {
  if (!socket || socket.destroyed || !socket.writable) return;
  try {
    const jsonBytes = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const len = jsonBytes.length;
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
    socket.write(Buffer.concat([header, jsonBytes]));
  } catch {}
}

function sendToUser(userId, payloadObj) {
  const set = onlineClients.get(userId);
  if (!set) return;
  for (const client of set) {
    sendWsFrame(client.socket, payloadObj);
  }
}

function broadcastToConversation(conversationId, payloadObj, excludeUserId = null) {
  const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  for (const m of members) {
    if (excludeUserId && m.user_id === excludeUserId) continue;
    sendToUser(m.user_id, payloadObj);
  }
}

function broadcastPresence(userId, online) {
  const nowIso = new Date().toISOString();
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso, userId);
  for (const [, set] of onlineClients.entries()) {
    for (const client of set) {
      sendWsFrame(client.socket, {
        type: 'presence',
        userId,
        online,
        lastSeenAt: nowIso
      });
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'contacts=(self), camera=(self), microphone=(self), speaker-selection=(self), geolocation=(self)',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Profile',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Gönderilen veri boyutu sınırı aşıldı (Maks 25MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Geçersiz JSON formatı.'));
      }
    });
    req.on('error', reject);
  });
}

function getPublicBaseUrl(req) {
  const ips = getLocalIPs();
  const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
  const hostHeader = req.headers.host || `${primaryIp}:${HTTP_PORT}`;
  const isCloud = !hostHeader.startsWith('localhost') && !hostHeader.startsWith('127.0.0.1') && !hostHeader.startsWith('192.168.');
  if (isCloud) {
    return `https://${hostHeader}`;
  }
  return `http://${primaryIp}:${HTTP_PORT}`;
}

function sanitizeUsername(rawUsername, displayName, normPhone) {
  const trMap = {
    ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
    ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u'
  };
  let base = String(rawUsername || '').trim();
  if (!base) {
    base = String(displayName || '').trim();
  }
  base = base.replace(/[çÇğĞıİöÖşŞüÜ]/g, (ch) => trMap[ch] || ch).toLowerCase();
  base = base.replace(/[^a-z0-9_.-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (base.length < 3) {
    const digits = String(normPhone || '').replace(/\D/g, '').slice(-6);
    base = (base || 'kullanici') + '_' + (digits || crypto.randomBytes(2).toString('hex'));
  }
  return base.slice(0, 24);
}

const revokedTokens = new Set();

function resolveOrRestoreSession(token, req) {
  if (!token || revokedTokens.has(token)) return null;

  const querySession = () =>
    db.prepare(`
      SELECT s.token, s.user_id, s.device_name, s.device_platform, s.bg_permission,
             u.id, u.username, u.display_name, u.phone, u.phone_normalized, u.is_registered,
             u.avatar_color, u.avatar_url,
             u.bio, u.public_key, u.key_fingerprint,
             u.privacy_last_seen, u.privacy_read_receipts, u.privacy_hide_notif_content,
             u.last_seen_at, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);

  let session = querySession();
  if (session) {
    db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
    return session;
  }

  // Render vb. bulut sunucularda konteyner yeniden başladığında (ephemeral disk)
  // telefonunda zaten giriş yapmış olan kullanıcının oturumunun kopmaması için otomatik onarım:
  if (!/^[0-9a-f]{32,128}$/i.test(token)) {
    return null;
  }

  try {
    let profile = null;
    const rawHeader = (req && req.headers && req.headers['x-user-profile']) || '';
    if (rawHeader) {
      try {
        const latin1Str = Buffer.from(String(rawHeader), 'base64').toString('latin1');
        const jsonStr = decodeURIComponent(escape(latin1Str));
        profile = JSON.parse(jsonStr);
      } catch {}
    }

    const tokenHash = crypto.createHash('sha1').update(token).digest('hex');
    if (!profile || (!profile.display_name && !profile.username && !profile.phone)) {
      const singleUser = db.prepare("SELECT * FROM users WHERE is_registered = 1 AND username != 'kullanici' ORDER BY created_at DESC LIMIT 1").get();
      if (!singleUser) return null;
      const clientIp = (req && req.socket && req.socket.remoteAddress) || 'unknown';
      db.prepare(`
        INSERT OR IGNORE INTO sessions (token, user_id, device_name, device_platform, ip_address)
        VALUES (?, ?, 'Mobil/Web Otomatik Oturum', 'Web', ?)
      `).run(token, singleUser.id, clientIp);
      return querySession() || null;
    }

    const rawPhone = String((profile && profile.phone) || '').trim();
    const normPhone = normalizePhone(rawPhone);
    const displayPhone = rawPhone ? formatPhoneDisplay(rawPhone) : '';
    const displayName = String((profile && profile.display_name) || 'Kullanıcı').trim() || 'Kullanıcı';
    const baseUsername = sanitizeUsername(
      (profile && profile.username) || '',
      displayName,
      normPhone || tokenHash.slice(0, 8)
    );

    let existingUser = null;
    if (profile && profile.id) {
      existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(String(profile.id));
    }
    if (!existingUser && normPhone && normPhone.length >= 7) {
      existingUser = db.prepare('SELECT * FROM users WHERE phone_normalized = ? LIMIT 1').get(normPhone);
    }
    if (!existingUser && baseUsername) {
      existingUser = db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1').get(baseUsername);
    }

    let userId = existingUser ? existingUser.id : String((profile && profile.id) || 'usr_' + tokenHash.slice(0, 12));

    if (!existingUser) {
      let finalUsername = baseUsername;
      const uClash = db.prepare('SELECT 1 FROM users WHERE username = ?').get(finalUsername);
      if (uClash) {
        finalUsername = `${baseUsername.slice(0, 18)}_${tokenHash.slice(0, 4)}`;
      }
      const { hash, salt } = hashPassword('123456');
      const avatarColor = String((profile && profile.avatar_color) || '#10b981');
      const pubKey = String((profile && profile.public_key) || '');
      const fp = String((profile && profile.key_fingerprint) || generateFingerprint(pubKey || userId));

      db.prepare(`
        INSERT OR IGNORE INTO users (id, username, display_name, phone, phone_normalized, is_registered, password_hash, password_salt, avatar_color, public_key, key_fingerprint)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(userId, finalUsername, displayName, displayPhone, normPhone, hash, salt, avatarColor, pubKey, fp);
    } else if (existingUser.is_registered === 0) {
      db.prepare('UPDATE users SET is_registered = 1, display_name = ? WHERE id = ?').run(displayName, userId);
    }

    const clientIp = (req && req.socket && req.socket.remoteAddress) || 'unknown';
    db.prepare(`
      INSERT OR IGNORE INTO sessions (token, user_id, device_name, device_platform, ip_address)
      VALUES (?, ?, 'Mobil/Web Otomatik Oturum', 'Web', ?)
    `).run(token, userId, clientIp);

    session = querySession();
    return session || null;
  } catch {
    return null;
  }
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }
  if (!token) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    token = parsedUrl.searchParams.get('token') || '';
  }
  if (!token) return null;

  return resolveOrRestoreSession(token, req);
}

/**
 * İki kullanıcı arasında bire bir (direct) sohbetin var olmasını garanti eder ve ID'sini döndürür.
 */
function ensureDirectConversation(userA, userB) {
  if (!userA || !userB) return null;

  if (userA === userB) {
    const existingSelf = db.prepare(`
      SELECT c.id
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
      WHERE c.type = 'direct'
        AND (SELECT COUNT(*) FROM conversation_members cm2 WHERE cm2.conversation_id = c.id) = 1
      LIMIT 1
    `).get(userA);
    if (existingSelf) return existingSelf.id;

    const convId = 'conv_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`
      INSERT INTO conversations (id, type, created_by)
      VALUES (?, 'direct', ?)
    `).run(convId, userA);
    db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, userA, 'member');
    return convId;
  }

  const existing = db.prepare(`
    SELECT c.id
    FROM conversations c
    JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
    JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
    WHERE c.type = 'direct'
      AND (SELECT COUNT(*) FROM conversation_members cm3 WHERE cm3.conversation_id = c.id) = 2
    LIMIT 1
  `).get(userA, userB);

  if (existing) {
    return existing.id;
  }

  const convId = 'conv_' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO conversations (id, type, created_by)
    VALUES (?, 'direct', ?)
  `).run(convId, userA);

  db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, userA, 'member');
  db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, userB, 'member');
  return convId;
}

/**
 * Kaydedilen kişiler programı kullandığında (kayıt olduğunda, giriş yaptığında veya numarasını güncellediğinde)
 * numaralar ile kaydedilen kişileri, sohbetleri ve rehber kayıtlarını otomatik entegre eder.
 */
function integrateSavedPhoneContacts(userId, rawPhone, userDisplayName) {
  const normPhone = normalizePhone(rawPhone);
  if (!normPhone || normPhone.length < 7) return { integratedUsers: [] };

  const displayPhone = formatPhoneDisplay(rawPhone || normPhone);
  db.prepare('UPDATE users SET phone = ?, phone_normalized = ?, is_registered = 1 WHERE id = ?').run(
    displayPhone,
    normPhone,
    userId
  );

  // 1. Aynı telefon numarasına sahip eski yer tutucu (tel_...) veya mükerrer kayıtları bu gerçek hesaba birleştir
  const duplicateUsers = db.prepare(`
    SELECT id, username, display_name, is_registered
    FROM users
    WHERE phone_normalized = ? AND id != ?
  `).all(normPhone, userId);

  for (const dup of duplicateUsers) {
    // a) Başkalarının rehberinde dup.id olarak kayıtlı olanları userId'ye taşı
    const contactsToPointHere = db.prepare('SELECT * FROM contacts WHERE contact_user_id = ?').all(dup.id);
    for (const c of contactsToPointHere) {
      if (c.user_id === userId) {
        db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(c.user_id, dup.id);
        continue;
      }
      db.prepare(`
        INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, invited_via, invited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
          contact_name = CASE WHEN contacts.contact_name = '' THEN excluded.contact_name ELSE contacts.contact_name END,
          contact_phone = CASE WHEN contacts.contact_phone = '' THEN excluded.contact_phone ELSE contacts.contact_phone END,
          contact_phone_normalized = excluded.contact_phone_normalized
      `).run(
        c.user_id,
        userId,
        c.contact_name,
        c.contact_phone || displayPhone,
        normPhone,
        c.invited_via || '',
        c.invited_at || null,
        c.created_at
      );
      db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(c.user_id, dup.id);
    }

    // b) dup.id'nin kendi rehberi varsa userId'ye aktar
    const ownContacts = db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(dup.id);
    for (const oc of ownContacts) {
      if (oc.contact_user_id === userId) continue;
      db.prepare(`
        INSERT OR IGNORE INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, invited_via, invited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        oc.contact_user_id,
        oc.contact_name,
        oc.contact_phone,
        oc.contact_phone_normalized || normalizePhone(oc.contact_phone),
        oc.invited_via || '',
        oc.invited_at || null,
        oc.created_at
      );
    }

    // c) dup.id'nin dahil olduğu sohbetleri ve mesajları userId'ye aktar
    const dupMemberships = db.prepare('SELECT * FROM conversation_members WHERE user_id = ?').all(dup.id);
    for (const dm of dupMemberships) {
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(dm.conversation_id);
      if (!conv) continue;

      if (conv.type === 'direct') {
        const otherMember = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').get(conv.id, dup.id);
        if (otherMember) {
          const existingConvWithReal = db.prepare(`
            SELECT c.id
            FROM conversations c
            JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
            JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
            WHERE c.type = 'direct' AND c.id != ?
            LIMIT 1
          `).get(userId, otherMember.user_id, conv.id);

          if (existingConvWithReal) {
            db.prepare('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?').run(existingConvWithReal.id, conv.id);
            db.prepare('UPDATE calls SET conversation_id = ? WHERE conversation_id = ?').run(existingConvWithReal.id, conv.id);
            db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
            continue;
          }
        }
      }

      db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, pinned, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        dm.conversation_id,
        userId,
        dm.role,
        dm.pinned,
        dm.muted,
        dm.joined_at
      );
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(dm.conversation_id, dup.id);
    }

    db.prepare('UPDATE messages SET sender_id = ? WHERE sender_id = ?').run(userId, dup.id);
    db.prepare('UPDATE calls SET caller_id = ? WHERE caller_id = ?').run(userId, dup.id);

    // Eğer yer tutucu (kayıtsız) hesapsa tamamen sil
    if (!dup.is_registered || String(dup.username).startsWith('tel_')) {
      db.prepare('DELETE FROM users WHERE id = ?').run(dup.id);
    }
  }

  // 2. contacts tablosunda numarası eşleşip farklı contact_user_id gösteren kayıtları güncelle
  const matchingContacts = db.prepare(`
    SELECT * FROM contacts
    WHERE contact_phone_normalized = ? AND contact_user_id != ? AND user_id != ?
  `).all(normPhone, userId, userId);

  for (const mc of matchingContacts) {
    db.prepare(`
      INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, invited_via, invited_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
        contact_phone_normalized = excluded.contact_phone_normalized
    `).run(
      mc.user_id,
      userId,
      mc.contact_name,
      mc.contact_phone,
      normPhone,
      mc.invited_via,
      mc.invited_at,
      mc.created_at
    );
    db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(mc.user_id, mc.contact_user_id);
  }

  // 3. Bu numarayı rehberine kaydetmiş olan tüm kullanıcılarla karşılıklı entegrasyon yap
  const savers = db.prepare(`
    SELECT c.user_id, c.contact_name, u.display_name as owner_name, u.phone as owner_phone, u.phone_normalized as owner_norm
    FROM contacts c
    JOIN users u ON u.id = c.user_id
    WHERE c.contact_user_id = ? OR c.contact_phone_normalized = ?
  `).all(userId, normPhone);

  const integratedUsers = [];
  for (const saver of savers) {
    if (saver.user_id === userId) continue;

    // Karşı tarafı da bu kullanıcının rehberine entegre et (böylece iki taraf da birbirini rehberinde ve sohbetlerinde görür)
    db.prepare(`
      INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, contact_user_id) DO NOTHING
    `).run(
      userId,
      saver.user_id,
      saver.owner_name,
      saver.owner_phone || '',
      saver.owner_norm || normalizePhone(saver.owner_phone)
    );

    const convId = ensureDirectConversation(saver.user_id, userId);
    if (convId) {
      const hasIntegrationMsg = db.prepare(`
        SELECT 1 FROM messages
        WHERE conversation_id = ? AND msg_type = 'system' AND content LIKE '%otomatik eşleştirildi%'
        LIMIT 1
      `).get(convId);

      if (!hasIntegrationMsg) {
        const sysMsgId = 'msg_' + crypto.randomBytes(6).toString('hex');
        const sysText = `🔗 Numara Entegrasyonu: ${userDisplayName} (${displayPhone}) programı kullanmaya başladı ve rehber kaydınızla otomatik eşleştirildi.`;
        db.prepare(`
          INSERT INTO messages (id, conversation_id, sender_id, msg_type, content, status)
          VALUES (?, ?, ?, 'system', ?, 'read')
        `).run(sysMsgId, convId, userId, sysText);
        db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(convId);
      }
    }

    integratedUsers.push(saver.user_id);
    sendToUser(saver.user_id, {
      type: 'contact_integrated',
      contactUserId: userId,
      displayName: userDisplayName,
      phone: displayPhone
    });
  }

  return { integratedUsers };
}

function formatConversationForUser(convId, userId) {
  const conv = db.prepare(`
    SELECT c.*, cm.role as my_role, cm.pinned, cm.muted, cm.last_read_message_id
    FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
    WHERE c.id = ?
  `).get(userId, convId);

  if (!conv) return null;

  const contactMap = new Map(
    db.prepare('SELECT contact_user_id, contact_name, contact_phone FROM contacts WHERE user_id = ?').all(userId).map((r) => [r.contact_user_id, r])
  );

  const members = db.prepare(`
    SELECT cm.user_id, cm.role, cm.joined_at,
           u.username, u.display_name, u.phone, u.is_registered, u.avatar_color, u.avatar_url,
           u.bio, u.public_key, u.key_fingerprint, u.last_seen_at, u.privacy_last_seen
    FROM conversation_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.conversation_id = ?
  `).all(convId).map((m) => {
    const saved = contactMap.get(m.user_id);
    return {
      ...m,
      real_display_name: m.display_name,
      display_name: (saved && saved.contact_name) ? saved.contact_name : m.display_name,
      phone: (saved && saved.contact_phone) ? saved.contact_phone : m.phone,
      isRegistered: Boolean(m.is_registered),
      online: isUserOnline(m.user_id)
    };
  });

  let peer = null;
  let title = conv.title;
  let avatarColor = conv.avatar_color;
  let description = conv.description;

  if (conv.type === 'direct') {
    peer = members.find((m) => m.user_id !== userId) || members[0];
    if (peer) {
      const saved = contactMap.get(peer.user_id);
      title = (saved && saved.contact_name) ? saved.contact_name : peer.display_name;
      avatarColor = peer.avatar_color;
      description = peer.phone ? `${peer.phone} • ${peer.bio || ''}` : peer.bio;
      const verified = db.prepare('SELECT verified_fingerprint FROM verified_keys WHERE user_id = ? AND peer_user_id = ?').get(userId, peer.user_id);
      peer.isVerified = Boolean(verified && verified.verified_fingerprint === peer.key_fingerprint);
      const blocked = db.prepare('SELECT 1 FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?').get(userId, peer.user_id);
      peer.isBlocked = Boolean(blocked);
    }
  }

  const lastMessage = db.prepare(`
    SELECT m.*, u.display_name as sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ?
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT 1
  `).get(convId);

  const unreadRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM messages m
    WHERE m.conversation_id = ?
      AND m.sender_id != ?
      AND m.deleted_at IS NULL
      AND m.status != 'read'
  `).get(convId, userId);

  return {
    id: conv.id,
    type: conv.type,
    title,
    description,
    avatarColor,
    myRole: conv.my_role,
    pinned: Boolean(conv.pinned),
    muted: Boolean(conv.muted),
    createdAt: conv.created_at,
    updatedAt: lastMessage ? lastMessage.created_at : conv.updated_at,
    unreadCount: unreadRow ? unreadRow.cnt : 0,
    peer,
    members,
    lastMessage: lastMessage
      ? {
          id: lastMessage.id,
          senderId: lastMessage.sender_id,
          senderName: lastMessage.sender_name,
          msgType: lastMessage.msg_type,
          content: lastMessage.deleted_at ? '🚫 Bu mesaj silindi' : lastMessage.content,
          ciphertext: lastMessage.deleted_at ? '' : lastMessage.ciphertext,
          iv: lastMessage.iv,
          senderPublicKey: lastMessage.sender_public_key,
          isEncrypted: Boolean(lastMessage.is_encrypted),
          status: lastMessage.status,
          createdAt: lastMessage.created_at
        }
      : null
  };
}

function enrichMessage(msgRow, currentUserId) {
  if (!msgRow) return null;
  let replyTo = null;
  if (msgRow.reply_to_id) {
    const r = db.prepare(`
      SELECT m.id, m.sender_id, m.msg_type, m.content, m.deleted_at, u.display_name as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `).get(msgRow.reply_to_id);
    if (r) {
      replyTo = {
        id: r.id,
        senderId: r.sender_id,
        senderName: r.sender_name,
        msgType: r.msg_type,
        content: r.deleted_at ? '🚫 Silinmiş mesaj' : r.content
      };
    }
  }

  let poll = null;
  if (msgRow.msg_type === 'poll') {
    const p = db.prepare('SELECT * FROM polls WHERE message_id = ?').get(msgRow.id);
    if (p) {
      const options = JSON.parse(p.options_json || '[]');
      const votes = db.prepare(`
        SELECT pv.option_index, pv.user_id, u.display_name
        FROM poll_votes pv
        JOIN users u ON u.id = pv.user_id
        WHERE pv.poll_id = ?
      `).all(p.id);

      const optionStats = options.map((text, idx) => {
        const voters = votes.filter((v) => v.option_index === idx);
        return {
          index: idx,
          text,
          count: voters.length,
          voters: voters.map((v) => v.display_name),
          votedByMe: voters.some((v) => v.user_id === currentUserId)
        };
      });

      poll = {
        id: p.id,
        question: p.question,
        totalVotes: votes.length,
        options: optionStats
      };
    }
  }

  return {
    id: msgRow.id,
    conversationId: msgRow.conversation_id,
    senderId: msgRow.sender_id,
    senderName: msgRow.sender_name,
    senderAvatarColor: msgRow.sender_avatar_color,
    msgType: msgRow.msg_type,
    content: msgRow.deleted_at ? '🚫 Bu mesaj silindi' : msgRow.content,
    ciphertext: msgRow.deleted_at ? '' : msgRow.ciphertext,
    iv: msgRow.iv,
    senderPublicKey: msgRow.sender_public_key,
    isEncrypted: Boolean(msgRow.is_encrypted),
    attachmentUrl: msgRow.deleted_at ? '' : msgRow.attachment_url,
    attachmentName: msgRow.attachment_name,
    attachmentSize: msgRow.attachment_size,
    attachmentMime: msgRow.attachment_mime,
    audioDuration: msgRow.audio_duration,
    replyTo,
    forwardedFromName: msgRow.forwarded_from_name,
    pinned: Boolean(msgRow.pinned),
    editedAt: msgRow.edited_at,
    deletedAt: msgRow.deleted_at,
    status: msgRow.status,
    createdAt: msgRow.created_at,
    poll
  };
}

/**
 * Telefon rehberinden gelen bir numarayı veya kişiyi mevcut aktif kullanıcılarla eşleştirir
 * ya da henüz kayıtlı değilse rehber profili oluşturur.
 */
function ensureContactUserByPhone(rawName, rawPhone) {
  const rawPhoneVal = Array.isArray(rawPhone) ? String(rawPhone[0] || '') : String(rawPhone || '');
  const phoneStr = rawPhoneVal.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  const rawNameVal = Array.isArray(rawName) ? String(rawName[0] || '') : String(rawName || '');
  const nameStr = rawNameVal.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  let normPhone = normalizePhone(phoneStr);

  // Eğer numara boşsa ama rehberden isim seçilmişse veya kısa numara girilmişse yine de kabul et
  if (!normPhone && !nameStr) {
    return null;
  }
  if (!normPhone) {
    const hashBuf = crypto.createHash('sha1').update(nameStr.toLowerCase()).digest();
    const numericSuffix = String(hashBuf.readUInt32BE(0) % 100000000).padStart(8, '0');
    normPhone = '+9000' + numericSuffix;
  }

  const displayPhone = phoneStr ? formatPhoneDisplay(phoneStr) : normPhone;

  // Önce bu numarayı kullanan gerçek kayıtlı kullanıcı var mı kontrol et
  let targetUser = db.prepare('SELECT * FROM users WHERE phone_normalized = ? ORDER BY is_registered DESC LIMIT 1').get(normPhone);
  const cleanName = String(nameStr || (targetUser ? targetUser.display_name : '') || displayPhone).trim();

  if (!targetUser) {
    const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#14b8a6'];
    const avatarColor = colors[Math.floor(Math.random() * colors.length)];
    const userId = 'usr_' + crypto.randomBytes(6).toString('hex');
    const cleanDigits = normPhone.replace(/\D/g, '') || '0000';
    const username = 'tel_' + cleanDigits.slice(-10) + '_' + crypto.randomBytes(2).toString('hex');
    const { hash, salt } = hashPassword('123456');
    const fp = generateFingerprint(userId + normPhone);

    db.prepare(`
      INSERT INTO users (id, username, display_name, phone, phone_normalized, is_registered, password_hash, password_salt, avatar_color, bio, key_fingerprint)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(userId, username, cleanName, displayPhone, normPhone, hash, salt, avatarColor, 'Rehberden eklendi • Henüz programa katılmadı 📱', fp);

    targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  }
  return { targetUser, cleanName, displayPhone, normPhone };
}

function decodeVcardValue(linePrefix, rawVal) {
  let val = String(rawVal || '').trim();
  if (/ENCODING=QUOTED-PRINTABLE/i.test(linePrefix)) {
    try {
      const bytes = [];
      for (let i = 0; i < val.length; i++) {
        if (val[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(val.slice(i + 1, i + 3))) {
          bytes.push(parseInt(val.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(val.charCodeAt(i));
        }
      }
      val = Buffer.from(bytes).toString('utf8').trim();
    } catch {}
  }
  return val;
}

/**
 * Serbest metin veya vCard (.vcf) içeriğinden kişi adı ve telefon numaralarını ayrıştırır.
 */
function parseContactsFromRawText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  const results = [];

  if (/BEGIN:VCARD/i.test(text)) {
    // Quoted-Printable satır katlamalarını birleştir
    const unfolded = text.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '');
    const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      let name = '';
      const lines = card.split(/\r?\n/);
      const phones = [];
      for (const line of lines) {
        if (/^(?:item\d+\.)?FN(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const rawVal = decodeVcardValue(line.slice(0, idx), line.slice(idx + 1));
            if (rawVal) name = rawVal;
          }
        } else if (!name && /^(?:item\d+\.)?N(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const decoded = decodeVcardValue(line.slice(0, idx), line.slice(idx + 1));
            const parts = decoded.split(';').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 0) name = parts.reverse().join(' ');
          }
        } else if (/^(?:item\d+\.)?TEL(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const rawTel = decodeVcardValue(line.slice(0, idx), line.slice(idx + 1)).replace(/^tel:/i, '').trim();
            if (rawTel) phones.push(rawTel);
          }
        }
      }
      if (phones.length > 0) {
        for (const p of phones) {
          results.push({ name: name || formatPhoneDisplay(p), phone: p });
        }
      } else if (name) {
        results.push({ name, phone: '' });
      }
    }
    return results;
  }

  // Satır satır serbest metin ("Ahmet Yılmaz 0532 123 45 67", "05321234567", "Ali: +90533...")
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const phoneMatch = trimmed.match(/(?:\+|00)?\d[\d\s().-]{2,20}\d/);
    if (phoneMatch) {
      const phoneStr = phoneMatch[0].trim();
      const namePart = trimmed
        .replace(phoneMatch[0], '')
        .replace(/^[\s,:;-]+|[\s,:;-]+$/g, '')
        .trim();
      results.push({
        name: namePart || formatPhoneDisplay(phoneStr),
        phone: phoneStr
      });
    }
  }
  return results;
}

// --- Ana İstek Yönlendirici ---
async function handleRequest(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return sendJson(res, 429, { error: 'Çok fazla istek gönderildi. Lütfen biraz bekleyin.' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Profile',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  try {
    // 1. Masaüstü Kurulum Paketi İndirme Uç Noktası
    if (pathname === '/download/MesajlasmaSetup.exe' || pathname === '/download/MesajlasmaServer.exe') {
      const setupFile = path.join(__dirname, 'MesajlasmaSetup.exe');
      const serverExe = path.join(__dirname, 'MesajlasmaServer.exe');
      const targetFile = fs.existsSync(setupFile) ? setupFile : serverExe;
      if (fs.existsSync(targetFile)) {
        const downloadName = path.basename(pathname);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${downloadName}"`,
          'Content-Length': fs.statSync(targetFile).size
        });
        return fs.createReadStream(targetFile).pipe(res);
      }
      return sendJson(res, 404, { error: 'Kurulum dosyası bulunamadı.' });
    }

    // 2. Sunucu ve QR Bilgisi
    if (pathname === '/api/server-info' && req.method === 'GET') {
      const ips = getLocalIPs();
      const primaryIp = ips.length > 0 ? ips[0].address : 'localhost';
      const hostHeader = req.headers.host || `${primaryIp}:${HTTP_PORT}`;
      const isCloud = !hostHeader.startsWith('localhost') && !hostHeader.startsWith('127.0.0.1') && !hostHeader.startsWith('192.168.');
      const httpUrl = isCloud ? `https://${hostHeader}` : `http://${primaryIp}:${HTTP_PORT}`;
      const httpsUrl = isCloud ? `https://${hostHeader}` : `https://${primaryIp}:${HTTPS_PORT}`;
      const targetUrl = parsedUrl.searchParams.get('url') || httpsUrl;
      return sendJson(res, 200, {
        status: 'ok',
        platform: `${process.platform} (${process.arch})`,
        nodeVersion: process.version,
        httpPort: HTTP_PORT,
        httpsPort: HTTPS_PORT,
        primaryIp,
        localIps: ips,
        httpUrl,
        httpsUrl,
        qrSvg: generateQrSvg(targetUrl, 240)
      });
    }

    if (pathname === '/api/qr' && req.method === 'GET') {
      const text = parsedUrl.searchParams.get('text') || `http://localhost:${HTTP_PORT}`;
      const svg = generateQrSvg(text, 240);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      return res.end(svg);
    }

    // 3. Kayıt ve Giriş (Kullanıcı Adı VEYA Telefon Numarası ile + Otomatik Rehber Entegrasyonu)
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const displayName = String(body.displayName || '').trim();
      const password = String(body.password || '');
      const rawPhone = String(body.phone || '').trim();
      const normPhone = normalizePhone(rawPhone);
      const displayPhone = formatPhoneDisplay(rawPhone);
      const publicKey = String(body.publicKey || '');
      let username = sanitizeUsername(body.username, displayName, normPhone);

      if (displayName.length < 2) {
        return sendJson(res, 400, { error: 'Ad Soyad en az 2 karakter olmalıdır.' });
      }
      if (!normPhone || normPhone.length < 7) {
        return sendJson(res, 400, { error: 'Lütfen geçerli bir cep telefonu numarası girin.' });
      }
      if (password.length < 4) {
        return sendJson(res, 400, { error: 'Parola en az 4 karakter olmalıdır.' });
      }

      // Bu telefon numarası zaten gerçek bir kullanıcı tarafından kayıtlı mı kontrol et
      const existingRealByPhone = db.prepare('SELECT * FROM users WHERE phone_normalized = ? AND is_registered = 1').get(normPhone);
      if (existingRealByPhone) {
        return sendJson(res, 409, { error: 'Bu telefon numarası zaten kayıtlı. Giriş Yap sekmesinden telefon numaranızla giriş yapabilirsiniz.' });
      }

      // Kullanıcı adı çakışmasını kontrol et, gerekirse sonuna numara ekle
      const existingByUsername = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (existingByUsername && existingByUsername.phone_normalized !== normPhone) {
        if (body.username && String(body.username).trim()) {
          return sendJson(res, 409, { error: 'Bu kullanıcı adı zaten kullanılıyor.' });
        }
        username = `${username.slice(0, 18)}_${crypto.randomBytes(2).toString('hex')}`;
      }

      // Eğer bu telefon numarası daha önce birisinin rehberinden eklendiyse (is_registered = 0 veya tel_...) o hesabı devral!
      let userId = '';
      const existingPlaceholder = db.prepare("SELECT * FROM users WHERE phone_normalized = ? AND (is_registered = 0 OR username LIKE 'tel_%')").get(normPhone);

      if (existingPlaceholder) {
        userId = existingPlaceholder.id;
        const { hash, salt } = hashPassword(password);
        const fingerprint = generateFingerprint(publicKey || userId);
        db.prepare(`
          UPDATE users
          SET username = ?, display_name = ?, phone = ?, phone_normalized = ?, is_registered = 1,
              password_hash = ?, password_salt = ?, public_key = ?, key_fingerprint = ?,
              bio = 'Mesajlaşma kullanıyorum'
          WHERE id = ?
        `).run(username, displayName, displayPhone, normPhone, hash, salt, publicKey, fingerprint, userId);
      } else {
        const colors = ['#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4', '#14b8a6'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];
        userId = 'usr_' + crypto.randomBytes(6).toString('hex');
        const { hash, salt } = hashPassword(password);
        const fingerprint = generateFingerprint(publicKey || userId);

        db.prepare(`
          INSERT INTO users (id, username, display_name, phone, phone_normalized, is_registered, password_hash, password_salt, avatar_color, public_key, key_fingerprint)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(userId, username, displayName, displayPhone, normPhone, hash, salt, avatarColor, publicKey, fingerprint);
      }

      // Kaydedilen kişilerle bu numarayı otomatik entegre et!
      const integration = integrateSavedPhoneContacts(userId, normPhone, displayName);

      const token = crypto.randomBytes(32).toString('hex');
      const deviceName = String(body.deviceName || 'Web İstemcisi').slice(0, 60);
      const devicePlatform = String(body.devicePlatform || 'Masaüstü/Mobil').slice(0, 40);
      db.prepare(`
        INSERT INTO sessions (token, user_id, device_name, device_platform, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, userId, deviceName, devicePlatform, clientIp);

      const user = db.prepare('SELECT id, username, display_name, phone, is_registered, avatar_color, bio, public_key, key_fingerprint, privacy_last_seen, privacy_read_receipts, privacy_hide_notif_content FROM users WHERE id = ?').get(userId);
      return sendJson(res, 201, {
        token,
        user,
        integratedCount: integration.integratedUsers.length
      });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const rawIdentifier = String(body.username || '').trim();
      const password = String(body.password || '');
      const publicKey = String(body.publicKey || '');

      const normPhone = normalizePhone(rawIdentifier);
      let userRow = db.prepare('SELECT * FROM users WHERE username = ?').get(rawIdentifier.toLowerCase());
      if (!userRow && normPhone.length >= 7) {
        userRow = db.prepare('SELECT * FROM users WHERE phone_normalized = ? ORDER BY is_registered DESC LIMIT 1').get(normPhone);
      }

      if (!userRow || !verifyPassword(password, userRow.password_hash, userRow.password_salt)) {
        return sendJson(res, 401, { error: 'Kullanıcı adı / telefon numarası veya parola hatalı.' });
      }

      if (publicKey && publicKey !== userRow.public_key) {
        const fp = generateFingerprint(publicKey);
        db.prepare('UPDATE users SET public_key = ?, key_fingerprint = ? WHERE id = ?').run(publicKey, fp, userRow.id);
        userRow.public_key = publicKey;
        userRow.key_fingerprint = fp;
      }

      // Giriş yapan kullanıcının numarası varsa rehber kayıtlarıyla entegre et
      if (userRow.phone_normalized || userRow.phone) {
        integrateSavedPhoneContacts(userRow.id, userRow.phone_normalized || userRow.phone, userRow.display_name);
      }

      const token = crypto.randomBytes(32).toString('hex');
      const deviceName = String(body.deviceName || 'Web İstemcisi').slice(0, 60);
      const devicePlatform = String(body.devicePlatform || 'Masaüstü/Mobil').slice(0, 40);
      db.prepare(`
        INSERT INTO sessions (token, user_id, device_name, device_platform, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, userRow.id, deviceName, devicePlatform, clientIp);

      return sendJson(res, 200, {
        token,
        user: {
          id: userRow.id,
          username: userRow.username,
          display_name: userRow.display_name,
          phone: userRow.phone,
          is_registered: 1,
          avatar_color: userRow.avatar_color,
          bio: userRow.bio,
          public_key: userRow.public_key,
          key_fingerprint: userRow.key_fingerprint,
          privacy_last_seen: userRow.privacy_last_seen,
          privacy_read_receipts: userRow.privacy_read_receipts,
          privacy_hide_notif_content: userRow.privacy_hide_notif_content
        }
      });
    }

    // --- Kimlik Doğrulama Gerektiren Uç Noktalar ---
    if (pathname.startsWith('/api/')) {
      const auth = getAuthUser(req);
      if (!auth) {
        return sendJson(res, 401, { error: 'Oturum süresi doldu veya giriş yapılmadı.' });
      }

      // Arka Plan Bildirim Yoklama ve Canlı Tutma (Service Worker Kapalı Sekme Desteği)
      if (pathname === '/api/notifications/poll' && req.method === 'GET') {
        const wasOnline = isUserOnline(auth.id);
        backgroundHeartbeats.set(auth.id, Date.now());
        if (!wasOnline) {
          broadcastPresence(auth.id, true);
        }

        // 1. Okunmamış mesajlar (Saat farkı ve gecikmeleri önlemek için doğrudan okunmamış kayıtlar kontrol edilir)
        const unreadMessages = db.prepare(`
          SELECT m.id, m.conversation_id, m.msg_type, m.content, m.created_at,
                 u.display_name as sender_name
          FROM messages m
          JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
          JOIN users u ON u.id = m.sender_id
          WHERE m.sender_id != ?
            AND m.status != 'read'
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC
          LIMIT 10
        `).all(auth.id, auth.id);

        // 2. Aktif çalan gelen aramalar
        const now = Date.now();
        const incomingCalls = [];
        for (const [cId, call] of activeIncomingCalls.entries()) {
          if (now - call.createdAt > 45000) {
            activeIncomingCalls.delete(cId);
            continue;
          }
          if (call.targetUserId === auth.id && call.status === 'ringing') {
            incomingCalls.push({
              callId: call.callId,
              callerId: call.callerId,
              callerName: call.callerName,
              callerAvatar: call.callerAvatar,
              callType: call.callType,
              conversationId: call.conversationId,
              sdp: call.sdp,
              createdAt: call.createdAt
            });
          }
        }

        return sendJson(res, 200, {
          ok: true,
          serverTime: new Date().toISOString(),
          unreadMessages,
          incomingCalls
        });
      }

      // Arka plandaki arama reddetme uç noktası
      if (pathname === '/api/calls/reject' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const callId = body.callId;
        if (callId && activeIncomingCalls.has(callId)) {
          const call = activeIncomingCalls.get(callId);
          activeIncomingCalls.delete(callId);
          sendToUser(call.callerId, {
            type: 'call-reject',
            callId,
            fromUserId: auth.id,
            fromDisplayName: auth.display_name
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      // Aktif arama sorgulama
      if (pathname === '/api/calls/active' && req.method === 'GET') {
        const callId = parsedUrl.searchParams.get('callId');
        if (callId && activeIncomingCalls.has(callId)) {
          return sendJson(res, 200, { ok: true, call: activeIncomingCalls.get(callId) });
        }
        return sendJson(res, 404, { error: 'Arama bulunamadı veya sona erdi.' });
      }

      if (pathname === '/api/auth/background-permission' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const enabled = body.enabled ? 1 : 0;
        db.prepare('UPDATE sessions SET bg_permission = ? WHERE token = ?').run(enabled, auth.token);
        backgroundHeartbeats.set(auth.id, Date.now());
        return sendJson(res, 200, { ok: true, bgPermission: Boolean(enabled) });
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        revokedTokens.add(auth.token);
        db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.token);
        backgroundHeartbeats.delete(auth.id);
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const sessions = db.prepare(`
          SELECT substr(token, 1, 10) as token_id, device_name, device_platform, ip_address, bg_permission, created_at, last_active_at,
                 (token = ?) as is_current
          FROM sessions
          WHERE user_id = ?
          ORDER BY last_active_at DESC
        `).all(auth.token, auth.id);

        return sendJson(res, 200, {
          user: {
            id: auth.id,
            username: auth.username,
            display_name: auth.display_name,
            phone: auth.phone,
            is_registered: auth.is_registered,
            avatar_color: auth.avatar_color,
            bio: auth.bio,
            public_key: auth.public_key,
            key_fingerprint: auth.key_fingerprint,
            privacy_last_seen: auth.privacy_last_seen,
            privacy_read_receipts: auth.privacy_read_receipts,
            privacy_hide_notif_content: auth.privacy_hide_notif_content
          },
          sessions
        });
      }

      if (pathname === '/api/auth/profile' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const displayName = String(body.display_name || auth.display_name).trim();
        const bio = String(body.bio ?? auth.bio).trim();
        const rawPhone = String(body.phone ?? auth.phone).trim();
        const displayPhone = formatPhoneDisplay(rawPhone);
        const normPhone = normalizePhone(rawPhone);
        const avatarColor = String(body.avatar_color || auth.avatar_color);
        const privacyLastSeen = String(body.privacy_last_seen || auth.privacy_last_seen);
        const privacyReadReceipts = body.privacy_read_receipts !== undefined ? (body.privacy_read_receipts ? 1 : 0) : auth.privacy_read_receipts;
        const privacyHideNotif = body.privacy_hide_notif_content !== undefined ? (body.privacy_hide_notif_content ? 1 : 0) : auth.privacy_hide_notif_content;

        let pubKey = auth.public_key;
        let fp = auth.key_fingerprint;
        if (body.public_key && body.public_key !== auth.public_key) {
          pubKey = String(body.public_key);
          fp = generateFingerprint(pubKey);
        }

        db.prepare(`
          UPDATE users
          SET display_name = ?, bio = ?, phone = ?, phone_normalized = ?, is_registered = 1, avatar_color = ?,
              privacy_last_seen = ?, privacy_read_receipts = ?, privacy_hide_notif_content = ?,
              public_key = ?, key_fingerprint = ?
          WHERE id = ?
        `).run(displayName, bio, displayPhone, normPhone, avatarColor, privacyLastSeen, privacyReadReceipts, privacyHideNotif, pubKey, fp, auth.id);

        if (normPhone) {
          integrateSavedPhoneContacts(auth.id, normPhone, displayName);
        }

        const updated = db.prepare('SELECT id, username, display_name, phone, is_registered, avatar_color, bio, public_key, key_fingerprint, privacy_last_seen, privacy_read_receipts, privacy_hide_notif_content FROM users WHERE id = ?').get(auth.id);
        return sendJson(res, 200, { user: updated });
      }

      if (pathname.startsWith('/api/auth/sessions/') && req.method === 'DELETE') {
        const prefix = pathname.split('/').pop();
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND substr(token, 1, 10) = ?').run(auth.id, prefix);
        return sendJson(res, 200, { ok: true });
      }

      // --- WHATSAPP / TELEGRAM TARZI CANLI TELEFON NUMARASI SORGULAMA VE REHBER KAYDI ---
      if (pathname === '/api/contacts/lookup' && req.method === 'GET') {
        const rawPhone = String(parsedUrl.searchParams.get('phone') || '').trim();
        const normPhone = normalizePhone(rawPhone);
        const displayPhone = formatPhoneDisplay(rawPhone);
        if (!normPhone || normPhone.replace(/\D/g, '').length < 7) {
          return sendJson(res, 200, { valid: false, normPhone: '', displayPhone: '' });
        }
        const registeredUser = db.prepare('SELECT id, username, display_name, phone, avatar_color, is_registered FROM users WHERE phone_normalized = ? AND is_registered = 1 LIMIT 1').get(normPhone);
        return sendJson(res, 200, {
          valid: true,
          normPhone,
          displayPhone,
          isRegistered: Boolean(registeredUser),
          user: registeredUser
            ? {
                id: registeredUser.id,
                display_name: registeredUser.display_name,
                phone: registeredUser.phone,
                online: isUserOnline(registeredUser.id)
              }
            : null
        });
      }

      // --- TELEFON REHBERİ KAYIT, SENKRONİZASYON VE SMS/WHATSAPP DAVET UÇ NOKTALARI ---
      if (pathname === '/api/contacts/sync' && req.method === 'POST') {
        const body = await readJsonBody(req);
        let rawList = Array.isArray(body.contacts) ? body.contacts.slice() : [];
        if (body.rawText) {
          rawList.push(...parseContactsFromRawText(body.rawText));
        }
        if (rawList.length === 0 && (body.name || body.phone)) {
          rawList.push({ name: body.name, phone: body.phone });
        }

        const inviteChannel = String(body.inviteChannel || 'auto'); // 'whatsapp', 'sms', 'both', 'auto'
        const appUrl = String(body.appUrl || getPublicBaseUrl(req));

        const upsertContact = db.prepare(`
          INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, invited_via, invited_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, contact_user_id) DO UPDATE SET
            contact_name = excluded.contact_name,
            contact_phone = excluded.contact_phone,
            contact_phone_normalized = excluded.contact_phone_normalized,
            invited_via = excluded.invited_via,
            invited_at = CURRENT_TIMESTAMP
        `);

        const validItems = [];
        const seenTargetIds = new Set();
        for (const item of rawList) {
          if (!item) continue;
          const itemName = Array.isArray(item.name)
            ? String(item.name[0] || '').trim()
            : String(item.name || item.displayName || '').trim();

          const phoneCandidates = [];
          if (Array.isArray(item.tel)) phoneCandidates.push(...item.tel);
          else if (item.tel) phoneCandidates.push(item.tel);
          if (Array.isArray(item.phone)) phoneCandidates.push(...item.phone);
          else if (item.phone) phoneCandidates.push(item.phone);
          if (Array.isArray(item.phones)) phoneCandidates.push(...item.phones);

          const nonEmptyPhones = phoneCandidates.map((p) => String(p || '').trim()).filter(Boolean);
          if (nonEmptyPhones.length > 0) {
            for (const p of nonEmptyPhones) {
              const resObj = ensureContactUserByPhone(itemName, p);
              if (resObj && !seenTargetIds.has(resObj.targetUser.id)) {
                seenTargetIds.add(resObj.targetUser.id);
                validItems.push(resObj);
              }
            }
          } else if (itemName) {
            const resObj = ensureContactUserByPhone(itemName, '');
            if (resObj && !seenTargetIds.has(resObj.targetUser.id)) {
              seenTargetIds.add(resObj.targetUser.id);
              validItems.push(resObj);
            }
          }
        }

        const allPhonesDisplay = validItems.map((v) => v.displayPhone);
        const imported = [];

        for (const resObj of validItems) {
          upsertContact.run(
            auth.id,
            resObj.targetUser.id,
            resObj.cleanName,
            resObj.displayPhone,
            resObj.normPhone,
            inviteChannel
          );

          // Eğer eklenen kişi zaten programı kullanıyorsa karşılıklı entegre et
          if (resObj.targetUser.is_registered) {
            db.prepare(`
              INSERT INTO contacts (user_id, contact_user_id, contact_name, contact_phone, contact_phone_normalized, created_at)
              VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, contact_user_id) DO NOTHING
            `).run(
              resObj.targetUser.id,
              auth.id,
              auth.display_name,
              auth.phone || '',
              auth.phone_normalized || normalizePhone(auth.phone)
            );
          }

          // Sohbeti otomatik başlat ve davet/ekleme bilgi mesajını kaydet
          const convId = ensureDirectConversation(auth.id, resObj.targetUser.id);
          const inviteInfo = buildInvitePayload({
            targetPhone: resObj.displayPhone,
            targetName: resObj.cleanName,
            senderName: auth.display_name,
            senderPhone: auth.phone,
            appUrl,
            allPhones: allPhonesDisplay
          });

          if (convId) {
            const existingInviteMsg = db.prepare(`
              SELECT 1 FROM messages
              WHERE conversation_id = ? AND content LIKE '%Bu numaraları kullanıcı sizi programı kullanmak için ekledi%'
              LIMIT 1
            `).get(convId);

            if (!existingInviteMsg) {
              const msgId = 'msg_' + crypto.randomBytes(6).toString('hex');
              db.prepare(`
                INSERT INTO messages (id, conversation_id, sender_id, msg_type, content, status)
                VALUES (?, ?, ?, 'text', ?, ?)
              `).run(
                msgId,
                convId,
                auth.id,
                inviteInfo.messageText,
                isUserOnline(resObj.targetUser.id) ? 'delivered' : 'sent'
              );
              db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(convId);

              const inserted = db.prepare(`
                SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.id = ?
              `).get(msgId);
              broadcastToConversation(convId, {
                type: 'new_message',
                conversationId: convId,
                message: enrichMessage(inserted, auth.id)
              });
            }
          }

          imported.push({
            id: resObj.targetUser.id,
            conversationId: convId,
            display_name: resObj.cleanName,
            real_display_name: resObj.targetUser.display_name,
            phone: resObj.displayPhone,
            phoneNormalized: resObj.normPhone,
            isRegistered: Boolean(resObj.targetUser.is_registered),
            online: isUserOnline(resObj.targetUser.id),
            inviteText: inviteInfo.messageText,
            whatsappUrl: inviteInfo.whatsappUrl,
            smsUrl: inviteInfo.smsUrl
          });
        }

        // Toplu SMS bağlantısı (Birden fazla kişi rehberden eklendiğinde tek seferde SMS atabilmek için)
        const allNormPhones = imported.map((c) => c.phoneNormalized).filter(Boolean);
        const bulkInvite = buildInvitePayload({
          targetPhone: allNormPhones[0] || '',
          targetName: imported.map((c) => c.display_name).join(', '),
          senderName: auth.display_name,
          senderPhone: auth.phone,
          appUrl,
          allPhones: allPhonesDisplay
        });
        const bulkSmsUrl = allNormPhones.length > 0
          ? `sms:${allNormPhones.join(',')}?body=${encodeURIComponent(bulkInvite.messageText)}`
          : bulkInvite.smsUrl;

        return sendJson(res, 200, {
          ok: true,
          importedCount: imported.length,
          contacts: imported,
          inviteMessage: bulkInvite.messageText,
          bulkSmsUrl,
          primaryWhatsappUrl: imported[0] ? imported[0].whatsappUrl : bulkInvite.whatsappUrl,
          primarySmsUrl: imported[0] ? imported[0].smsUrl : bulkInvite.smsUrl
        });
      }

      if (pathname.startsWith('/api/contacts/') && req.method === 'DELETE') {
        const targetId = pathname.split('/').pop();
        db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?').run(auth.id, targetId);
        return sendJson(res, 200, { ok: true });
      }

      // Kullanıcı ve Telefon Rehberi Listesi
      if (pathname === '/api/users' && req.method === 'GET') {
        const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
        const appUrl = getPublicBaseUrl(req);
        const rows = db.prepare(`
          SELECT id, username, display_name, phone, phone_normalized, is_registered, avatar_color, bio, public_key, key_fingerprint, last_seen_at, privacy_last_seen
          FROM users
          WHERE id != ? OR id IN (SELECT contact_user_id FROM contacts WHERE user_id = ?)
        `).all(auth.id, auth.id);

        const myContactsMap = new Map(
          db.prepare('SELECT contact_user_id, contact_name, contact_phone, invited_via, invited_at FROM contacts WHERE user_id = ?').all(auth.id).map((r) => [r.contact_user_id, r])
        );
        const blockedSet = new Set(
          db.prepare('SELECT blocked_user_id FROM blocked_users WHERE user_id = ?').all(auth.id).map((r) => r.blocked_user_id)
        );
        const verifiedMap = new Map(
          db.prepare('SELECT peer_user_id, verified_fingerprint FROM verified_keys WHERE user_id = ?').all(auth.id).map((r) => [r.peer_user_id, r.verified_fingerprint])
        );

        const enriched = rows
          .filter((u) => {
            // Kayıtsız (tel_...) yer tutucu kişileri yalnızca kendi rehberine ekleyen kullanıcı görsün
            if (!u.is_registered && !myContactsMap.has(u.id)) {
              return false;
            }
            return true;
          })
          .map((u) => {
            const cEntry = myContactsMap.get(u.id);
            const savedName = cEntry && cEntry.contact_name ? cEntry.contact_name : u.display_name;
            const savedPhone = cEntry && cEntry.contact_phone ? cEntry.contact_phone : u.phone;
            const invite = buildInvitePayload({
              targetPhone: savedPhone,
              targetName: savedName,
              senderName: auth.display_name,
              senderPhone: auth.phone,
              appUrl,
              allPhones: [savedPhone]
            });
            return {
              ...u,
              real_display_name: u.display_name,
              display_name: savedName,
              phone: savedPhone,
              isSavedContact: Boolean(cEntry),
              isRegistered: Boolean(u.is_registered),
              online: isUserOnline(u.id),
              isBlocked: blockedSet.has(u.id),
              isVerified: verifiedMap.get(u.id) === u.key_fingerprint,
              inviteText: invite.messageText,
              whatsappUrl: invite.whatsappUrl,
              smsUrl: invite.smsUrl
            };
          })
          .filter((u) => {
            if (!q) return true;
            return (
              u.display_name.toLowerCase().includes(q) ||
              (u.real_display_name && u.real_display_name.toLowerCase().includes(q)) ||
              u.username.toLowerCase().includes(q) ||
              (u.phone && u.phone.toLowerCase().includes(q))
            );
          })
          .sort((a, b) => {
            if (a.online !== b.online) return a.online ? -1 : 1;
            if (a.isSavedContact !== b.isSavedContact) return a.isSavedContact ? -1 : 1;
            if (a.isRegistered !== b.isRegistered) return a.isRegistered ? -1 : 1;
            return a.display_name.localeCompare(b.display_name, 'tr');
          });

        return sendJson(res, 200, { users: enriched });
      }

      // Kullanıcı Engelle / Engeli Kaldır
      if (pathname === '/api/users/block' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const targetId = String(body.userId || '');
        const existing = db.prepare('SELECT 1 FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?').get(auth.id, targetId);
        if (existing) {
          db.prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?').run(auth.id, targetId);
          return sendJson(res, 200, { blocked: false });
        } else {
          db.prepare('INSERT INTO blocked_users (user_id, blocked_user_id) VALUES (?, ?)').run(auth.id, targetId);
          return sendJson(res, 200, { blocked: true });
        }
      }

      // Kullanıcı Şikâyet Et
      if (pathname === '/api/users/report' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const reportId = 'rep_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
          INSERT INTO reports (id, reporter_id, reported_user_id, reason, details)
          VALUES (?, ?, ?, ?, ?)
        `).run(reportId, auth.id, String(body.userId || ''), String(body.reason || 'Uygunsuz içerik'), String(body.details || ''));
        return sendJson(res, 201, { ok: true, reportId });
      }

      // E2EE Anahtar Doğrulama
      if (pathname === '/api/keys/verify' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const peerId = String(body.peerUserId || '');
        const peer = db.prepare('SELECT id, key_fingerprint FROM users WHERE id = ?').get(peerId);
        if (!peer) return sendJson(res, 404, { error: 'Kullanıcı bulunamadı.' });

        db.prepare(`
          INSERT INTO verified_keys (user_id, peer_user_id, verified_fingerprint, verified_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, peer_user_id) DO UPDATE SET
            verified_fingerprint = excluded.verified_fingerprint,
            verified_at = CURRENT_TIMESTAMP
        `).run(auth.id, peer.id, peer.key_fingerprint);

        return sendJson(res, 200, { verified: true, fingerprint: peer.key_fingerprint });
      }

      // Sohbet Listesi
      if (pathname === '/api/conversations' && req.method === 'GET') {
        const convIds = db.prepare(`
          SELECT conversation_id FROM conversation_members WHERE user_id = ?
        `).all(auth.id);

        const list = convIds
          .map((r) => formatConversationForUser(r.conversation_id, auth.id))
          .filter(Boolean)
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
          });

        return sendJson(res, 200, { conversations: list });
      }

      // Bire bir sohbet başlat veya getir
      if (pathname === '/api/conversations/direct' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const peerId = String(body.peerUserId || '');
        if (!peerId) {
          return sendJson(res, 400, { error: 'Geçersiz kişi seçimi.' });
        }

        const convId = ensureDirectConversation(auth.id, peerId);
        const formattedForMe = formatConversationForUser(convId, auth.id);
        if (peerId !== auth.id) {
          const formattedForPeer = formatConversationForUser(convId, peerId);
          sendToUser(peerId, { type: 'conversation_created', conversation: formattedForPeer });
        }

        return sendJson(res, 200, { conversation: formattedForMe });
      }

      // Grup veya Duyuru Kanalı Oluştur
      if (pathname === '/api/conversations/group' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const type = body.type === 'channel' ? 'channel' : 'group';
        const title = String(body.title || '').trim();
        const description = String(body.description || '').trim();
        const memberIds = Array.isArray(body.memberIds) ? body.memberIds : [];

        if (title.length < 2) {
          return sendJson(res, 400, { error: 'Grup veya kanal adı en az 2 karakter olmalıdır.' });
        }

        const convId = 'conv_' + crypto.randomBytes(6).toString('hex');
        const colors = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899'];
        const avatarColor = colors[Math.floor(Math.random() * colors.length)];

        db.prepare(`
          INSERT INTO conversations (id, type, title, description, avatar_color, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(convId, type, title, description, avatarColor, auth.id);

        db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, auth.id, 'owner');

        const uniqueMembers = [...new Set(memberIds.filter((id) => id && id !== auth.id))];
        for (const mId of uniqueMembers) {
          const role = type === 'channel' ? 'subscriber' : 'member';
          db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, mId, role);
        }

        const sysMsgId = 'msg_' + crypto.randomBytes(6).toString('hex');
        const sysText = type === 'channel'
          ? `${auth.display_name} "${title}" duyuru kanalını oluşturdu.`
          : `${auth.display_name} "${title}" grubunu oluşturdu.`;
        db.prepare(`
          INSERT INTO messages (id, conversation_id, sender_id, msg_type, content, status)
          VALUES (?, ?, ?, 'system', ?, 'read')
        `).run(sysMsgId, convId, auth.id, sysText);

        for (const mId of uniqueMembers) {
          sendToUser(mId, {
            type: 'conversation_created',
            conversation: formatConversationForUser(convId, mId)
          });
        }

        return sendJson(res, 201, { conversation: formatConversationForUser(convId, auth.id) });
      }

      // Sohbet Sabitleme (Pin)
      const pinMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/pin$/);
      if (pinMatch && req.method === 'POST') {
        const convId = pinMatch[1];
        const row = db.prepare('SELECT pinned FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, auth.id);
        if (!row) return sendJson(res, 404, { error: 'Sohbet bulunamadı.' });
        const nextPinned = row.pinned ? 0 : 1;
        db.prepare('UPDATE conversation_members SET pinned = ? WHERE conversation_id = ? AND user_id = ?').run(nextPinned, convId, auth.id);
        return sendJson(res, 200, { pinned: Boolean(nextPinned) });
      }

      // Grup Üyeliği ve Yönetici Rolleri Yönetimi
      const membersMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/members$/);
      if (membersMatch && req.method === 'POST') {
        const convId = membersMatch[1];
        const body = await readJsonBody(req);
        const action = String(body.action || '');
        const targetUserId = String(body.userId || '');

        const myMember = db.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convId, auth.id);
        if (!myMember) return sendJson(res, 403, { error: 'Bu sohbette yetkiniz yok.' });

        if (action === 'leave') {
          db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(convId, auth.id);
          return sendJson(res, 200, { ok: true });
        }

        if (myMember.role !== 'owner' && myMember.role !== 'admin') {
          return sendJson(res, 403, { error: 'Bu işlem için grup yöneticisi olmalısınız.' });
        }

        if (action === 'add') {
          db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(convId, targetUserId, 'member');
        } else if (action === 'remove') {
          db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(convId, targetUserId);
        } else if (action === 'promote') {
          db.prepare('UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?').run('admin', convId, targetUserId);
        }

        const updatedConv = formatConversationForUser(convId, auth.id);
        broadcastToConversation(convId, { type: 'conversation_updated', conversationId: convId });
        return sendJson(res, 200, { conversation: updatedConv });
      }

      // Sohbet Mesajlarını Getir veya Gönder
      const msgMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (msgMatch) {
        const convId = msgMatch[1];
        const membership = db.prepare(`
          SELECT cm.role, c.type
          FROM conversation_members cm
          JOIN conversations c ON c.id = cm.conversation_id
          WHERE cm.conversation_id = ? AND cm.user_id = ?
        `).get(convId, auth.id);

        if (!membership) {
          return sendJson(res, 403, { error: 'Bu sohbete erişim yetkiniz yok.' });
        }

        if (req.method === 'GET') {
          const rows = db.prepare(`
            SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.conversation_id = ?
            ORDER BY m.created_at ASC, m.rowid ASC
            LIMIT 300
          `).all(convId);

          return sendJson(res, 200, {
            messages: rows.map((r) => enrichMessage(r, auth.id))
          });
        }

        if (req.method === 'POST') {
          if (membership.type === 'channel' && membership.role === 'subscriber') {
            return sendJson(res, 403, { error: 'Duyuru kanallarında yalnızca yöneticiler paylaşım yapabilir.' });
          }

          if (membership.type === 'direct') {
            const peerRow = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').get(convId, auth.id);
            if (peerRow) {
              const isBlocked = db.prepare(`
                SELECT 1 FROM blocked_users
                WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)
              `).get(auth.id, peerRow.user_id, peerRow.user_id, auth.id);
              if (isBlocked) {
                return sendJson(res, 403, { error: 'Engellenmiş kullanıcı ile mesajlaşılamaz.' });
              }
            }
          }

          const body = await readJsonBody(req);
          const msgType = ['text', 'image', 'video', 'audio', 'file', 'poll'].includes(body.msgType) ? body.msgType : 'text';
          const content = String(body.content || '').trim();
          const ciphertext = String(body.ciphertext || '');
          const iv = String(body.iv || '');
          const senderPublicKey = String(body.senderPublicKey || auth.public_key || '');
          const isEncrypted = body.isEncrypted ? 1 : 0;
          const attachmentUrl = String(body.attachmentUrl || '');
          const attachmentName = String(body.attachmentName || '');
          const attachmentSize = Number(body.attachmentSize || 0);
          const attachmentMime = String(body.attachmentMime || '');
          const audioDuration = Number(body.audioDuration || 0);
          const replyToId = body.replyToId ? String(body.replyToId) : null;
          const forwardedFromName = String(body.forwardedFromName || '');

          const msgId = 'msg_' + crypto.randomBytes(8).toString('hex');

          const otherMembers = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?').all(convId, auth.id);
          const anyOnline = otherMembers.some((m) => isUserOnline(m.user_id));
          const initialStatus = anyOnline ? 'delivered' : 'sent';

          db.prepare(`
            INSERT INTO messages (
              id, conversation_id, sender_id, msg_type, content,
              ciphertext, iv, sender_public_key, is_encrypted,
              attachment_url, attachment_name, attachment_size, attachment_mime, audio_duration,
              reply_to_id, forwarded_from_name, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            msgId, convId, auth.id, msgType, content,
            ciphertext, iv, senderPublicKey, isEncrypted,
            attachmentUrl, attachmentName, attachmentSize, attachmentMime, audioDuration,
            replyToId, forwardedFromName, initialStatus
          );

          if (msgType === 'poll' && body.poll) {
            const pollId = 'poll_' + crypto.randomBytes(6).toString('hex');
            const question = String(body.poll.question || content || 'Anket');
            const options = Array.isArray(body.poll.options) ? body.poll.options.map((o) => String(o).trim()).filter(Boolean) : [];
            db.prepare(`
              INSERT INTO polls (id, message_id, conversation_id, question, options_json, created_by)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(pollId, msgId, convId, question, JSON.stringify(options), auth.id);
          }

          db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(convId);

          const inserted = db.prepare(`
            SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?
          `).get(msgId);

          const fullMsg = enrichMessage(inserted, auth.id);
          broadcastToConversation(convId, {
            type: 'new_message',
            conversationId: convId,
            message: fullMsg
          });

          return sendJson(res, 201, { message: fullMsg });
        }
      }

      // Mesajları Okundu İşaretle
      const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
      if (readMatch && req.method === 'POST') {
        const convId = readMatch[1];
        const unreadMsgs = db.prepare(`
          SELECT id, sender_id FROM messages
          WHERE conversation_id = ? AND sender_id != ? AND status != 'read'
        `).all(convId, auth.id);

        if (unreadMsgs.length > 0) {
          const updateMsg = db.prepare("UPDATE messages SET status = 'read' WHERE id = ?");
          const upsertReceipt = db.prepare(`
            INSERT INTO message_receipts (message_id, user_id, read_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(message_id, user_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
          `);

          for (const m of unreadMsgs) {
            updateMsg.run(m.id);
            upsertReceipt.run(m.id, auth.id);
          }

          if (auth.privacy_read_receipts) {
            broadcastToConversation(convId, {
              type: 'messages_read',
              conversationId: convId,
              readerId: auth.id,
              messageIds: unreadMsgs.map((m) => m.id)
            });
          }
        }
        return sendJson(res, 200, { ok: true, count: unreadMsgs.length });
      }

      // Mesaj Düzenle / Sabitle / Sil
      const singleMsgMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
      if (singleMsgMatch) {
        const msgId = singleMsgMatch[1];
        const msgRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
        if (!msgRow) return sendJson(res, 404, { error: 'Mesaj bulunamadı.' });

        if (req.method === 'PUT') {
          const body = await readJsonBody(req);
          if (body.togglePin) {
            const nextPin = msgRow.pinned ? 0 : 1;
            db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(nextPin, msgId);
          } else {
            if (msgRow.sender_id !== auth.id) {
              return sendJson(res, 403, { error: 'Yalnızca kendi mesajınızı düzenleyebilirsiniz.' });
            }
            const newContent = String(body.content || '').trim();
            const newCiphertext = String(body.ciphertext || msgRow.ciphertext);
            const newIv = String(body.iv || msgRow.iv);
            db.prepare(`
              UPDATE messages
              SET content = ?, ciphertext = ?, iv = ?, edited_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(newContent, newCiphertext, newIv, msgId);
          }

          const updated = db.prepare(`
            SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?
          `).get(msgId);
          const enriched = enrichMessage(updated, auth.id);
          broadcastToConversation(msgRow.conversation_id, {
            type: 'message_updated',
            conversationId: msgRow.conversation_id,
            message: enriched
          });
          return sendJson(res, 200, { message: enriched });
        }

        if (req.method === 'DELETE') {
          if (msgRow.sender_id !== auth.id) {
            return sendJson(res, 403, { error: 'Yalnızca kendi mesajınızı silebilirsiniz.' });
          }
          db.prepare(`
            UPDATE messages
            SET content = '', ciphertext = '', attachment_url = '', deleted_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(msgId);

          const updated = db.prepare(`
            SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
            FROM messages m
            JOIN users u ON u.id = m.sender_id
            WHERE m.id = ?
          `).get(msgId);
          const enriched = enrichMessage(updated, auth.id);
          broadcastToConversation(msgRow.conversation_id, {
            type: 'message_updated',
            conversationId: msgRow.conversation_id,
            message: enriched
          });
          return sendJson(res, 200, { message: enriched });
        }
      }

      // Dosya Yükleme
      if (pathname === '/api/uploads' && req.method === 'POST') {
        const body = await readJsonBody(req, 25 * 1024 * 1024);
        const fileName = String(body.fileName || 'dosya.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
        const mimeType = String(body.mimeType || 'application/octet-stream');
        const base64Data = String(body.dataBase64 || '');

        if (!base64Data) {
          return sendJson(res, 400, { error: 'Dosya verisi boş.' });
        }

        const cleaned = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
        const buf = Buffer.from(cleaned, 'base64');
        const ext = path.extname(fileName) || '.bin';
        const storedName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
        const filePath = path.join(UPLOADS_DIR, storedName);
        fs.writeFileSync(filePath, buf);

        return sendJson(res, 201, {
          url: `/uploads/${storedName}`,
          name: fileName,
          size: buf.length,
          mime: mimeType
        });
      }

      // Anket Oylama
      const pollVoteMatch = pathname.match(/^\/api\/polls\/([^/]+)\/vote$/);
      if (pollVoteMatch && req.method === 'POST') {
        const pollId = pollVoteMatch[1];
        const body = await readJsonBody(req);
        const optionIndex = Number(body.optionIndex || 0);

        const pollRow = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
        if (!pollRow) return sendJson(res, 404, { error: 'Anket bulunamadı.' });

        db.prepare(`
          INSERT INTO poll_votes (poll_id, user_id, option_index, voted_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index, voted_at = CURRENT_TIMESTAMP
        `).run(pollId, auth.id, optionIndex);

        const msgRow = db.prepare(`
          SELECT m.*, u.display_name as sender_name, u.avatar_color as sender_avatar_color
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.id = ?
        `).get(pollRow.message_id);

        const enriched = enrichMessage(msgRow, auth.id);
        broadcastToConversation(pollRow.conversation_id, {
          type: 'message_updated',
          conversationId: pollRow.conversation_id,
          message: enriched
        });

        return sendJson(res, 200, { message: enriched });
      }

      // Hikâye / Durum Paylaşımları
      if (pathname === '/api/stories' && req.method === 'GET') {
        const rows = db.prepare(`
          SELECT s.*, u.display_name, u.username, u.avatar_color
          FROM stories s
          JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > datetime('now')
          ORDER BY s.created_at DESC
        `).all();

        const stories = rows.map((s) => {
          const views = db.prepare(`
            SELECT sv.viewer_id, u.display_name, sv.viewed_at
            FROM story_views sv
            JOIN users u ON u.id = sv.viewer_id
            WHERE sv.story_id = ?
          `).all(s.id);
          return {
            ...s,
            viewCount: views.length,
            views,
            viewedByMe: views.some((v) => v.viewer_id === auth.id)
          };
        });

        return sendJson(res, 200, { stories });
      }

      if (pathname === '/api/stories' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const textContent = String(body.textContent || '').trim();
        const mediaUrl = String(body.mediaUrl || '');
        const bgColor = String(body.bgColor || '#0f766e');

        if (!textContent && !mediaUrl) {
          return sendJson(res, 400, { error: 'Durum metni veya görsel gereklidir.' });
        }

        const storyId = 'story_' + crypto.randomBytes(6).toString('hex');
        db.prepare(`
          INSERT INTO stories (id, user_id, text_content, media_url, bg_color, expires_at)
          VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
        `).run(storyId, auth.id, textContent, mediaUrl, bgColor);

        return sendJson(res, 201, { ok: true, storyId });
      }

      const storyViewMatch = pathname.match(/^\/api\/stories\/([^/]+)\/view$/);
      if (storyViewMatch && req.method === 'POST') {
        const storyId = storyViewMatch[1];
        db.prepare('INSERT OR IGNORE INTO story_views (story_id, viewer_id) VALUES (?, ?)').run(storyId, auth.id);
        return sendJson(res, 200, { ok: true });
      }

      // Sesli ve Görüntülü Arama Kayıtları
      if (pathname === '/api/calls' && req.method === 'GET') {
        const rows = db.prepare(`
          SELECT cl.*, c.type as conv_type, c.title as conv_title,
                 u.display_name as caller_name, u.avatar_color as caller_color
          FROM calls cl
          JOIN conversations c ON c.id = cl.conversation_id
          JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
          JOIN users u ON u.id = cl.caller_id
          ORDER BY cl.started_at DESC
          LIMIT 50
        `).all(auth.id);

        return sendJson(res, 200, { calls: rows });
      }

      if (pathname === '/api/calls' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const callId = 'call_' + crypto.randomBytes(6).toString('hex');
        const convId = String(body.conversationId || '');
        const callType = body.callType === 'video' ? 'video' : 'audio';
        const status = ['ringing', 'ongoing', 'completed', 'missed', 'rejected'].includes(body.status) ? body.status : 'completed';
        const durationSec = Number(body.durationSec || 0);

        db.prepare(`
          INSERT INTO calls (id, conversation_id, caller_id, call_type, status, duration_sec, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(callId, convId, auth.id, callType, status, durationSec);

        return sendJson(res, 201, { callId });
      }

      return sendJson(res, 404, { error: 'API uç noktası bulunamadı.' });
    }

    // Yüklenen Medya Dosyaları
    if (pathname.startsWith('/uploads/')) {
      const safeName = path.basename(pathname);
      const fullPath = path.join(UPLOADS_DIR, safeName);
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404);
        return res.end('Dosya bulunamadi');
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(fullPath).pipe(res);
    }

    // Statik Web / PWA Dosyaları (Hem kök dizin hem public/ dizini desteklenir; en güncel BUILD_VER seçilir)
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safeFile = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');

    const getBuildVer = (p) => {
      try {
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return -1;
        const head = fs.readFileSync(p, 'utf8').slice(0, 200);
        const m = head.match(/BUILD_VER:\s*(\d+)/);
        return m ? Number(m[1]) : 0;
      } catch {
        return -1;
      }
    };

    const pickNewestFile = (relName) => {
      const pubCandidate = path.join(PUBLIC_DIR, relName);
      const rootCandidate = path.join(__dirname, relName);
      const pubVer = getBuildVer(pubCandidate);
      const rootVer = getBuildVer(rootCandidate);
      if (rootVer > pubVer) return rootCandidate;
      if (pubVer >= 0) return pubCandidate;
      if (rootVer >= 0) return rootCandidate;
      return null;
    };

    let filePath = pickNewestFile(safeFile) || pickNewestFile('index.html') || path.join(PUBLIC_DIR, 'index.html');

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Permissions-Policy': 'contacts=(self), camera=(self), microphone=(self), speaker-selection=(self), geolocation=(self)'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[SUNUCU HATASI]', err);
    sendJson(res, 500, { error: err.message || 'Sunucu hatası oluştu.' });
  }
}

// --- RFC 6455 WebSocket Protokolü ---
function setupWebSocketUpgrade(server) {
  server.on('upgrade', (req, socket) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const token = parsedUrl.searchParams.get('token') || '';
      const session = resolveOrRestoreSession(token, req);

      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
      );

      const userId = session.user_id;
      const clientObj = { socket, userId, displayName: session.display_name };

      if (!onlineClients.has(userId)) {
        onlineClients.set(userId, new Set());
      }
      const wasOffline = onlineClients.get(userId).size === 0;
      onlineClients.get(userId).add(clientObj);

      if (wasOffline) {
        broadcastPresence(userId, true);
      }

      let buffer = Buffer.alloc(0);

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const firstByte = buffer[0];
          const opcode = firstByte & 0x0f;
          const secondByte = buffer[1];
          const isMasked = Boolean(secondByte & 0x80);
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (opcode === 0x08) {
            socket.end();
            return;
          }

          if (payloadLen === 126) {
            if (buffer.length < 4) return;
            payloadLen = buffer.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buffer.length < 10) return;
            payloadLen = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskLen = isMasked ? 4 : 0;
          if (buffer.length < offset + maskLen + payloadLen) return;

          const payload = Buffer.alloc(payloadLen);
          if (isMasked) {
            const mask = buffer.slice(offset, offset + 4);
            const dataStart = offset + 4;
            for (let i = 0; i < payloadLen; i++) {
              payload[i] = buffer[dataStart + i] ^ mask[i % 4];
            }
          } else {
            buffer.copy(payload, 0, offset, offset + payloadLen);
          }

          buffer = buffer.slice(offset + maskLen + payloadLen);

          if (opcode === 0x09) {
            socket.write(Buffer.from([0x8a, 0x00]));
            continue;
          }

          if (opcode === 0x01) {
            try {
              const msg = JSON.parse(payload.toString('utf8'));
              handleWsMessage(clientObj, msg);
            } catch {}
          }
        }
      });

      const cleanup = () => {
        const set = onlineClients.get(userId);
        if (set) {
          set.delete(clientObj);
          if (set.size === 0) {
            onlineClients.delete(userId);
            if (!isUserOnline(userId)) {
              broadcastPresence(userId, false);
            }
          }
        }
      };

      socket.on('close', cleanup);
      socket.on('error', cleanup);
    } catch {
      socket.destroy();
    }
  });
}

function handleWsMessage(client, msg) {
  if (!msg || !msg.type) return;

  if (msg.type === 'ping') {
    backgroundHeartbeats.set(client.userId, Date.now());
    sendWsFrame(client.socket, { type: 'pong', ts: Date.now() });
    return;
  }

  if (msg.type === 'typing' && msg.conversationId) {
    broadcastToConversation(
      msg.conversationId,
      {
        type: 'typing',
        conversationId: msg.conversationId,
        userId: client.userId,
        displayName: client.displayName,
        isTyping: Boolean(msg.isTyping)
      },
      client.userId
    );
    return;
  }

  if (
    [
      'call-offer',
      'call-answer',
      'ice-candidate',
      'call-reject',
      'call-end',
      'call-busy',
      'call-connected',
      'call-media'
    ].includes(msg.type)
  ) {
    const callId = msg.callId || ('call_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'));
    const payload = {
      ...msg,
      callId,
      fromUserId: client.userId,
      fromDisplayName: client.displayName
    };

    const targetSet = new Set();
    if (msg.targetUserId) {
      targetSet.add(msg.targetUserId);
    }
    if (msg.conversationId) {
      const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(msg.conversationId);
      for (const m of members) {
        if (m.user_id !== client.userId) {
          targetSet.add(m.user_id);
        }
      }
    }

    if (msg.type === 'call-offer') {
      for (const uid of targetSet) {
        activeIncomingCalls.set(callId, {
          callId,
          callerId: client.userId,
          callerName: client.displayName,
          callerAvatar: client.avatarColor || '#10b981',
          callType: msg.callType || 'audio',
          conversationId: msg.conversationId,
          targetUserId: uid,
          sdp: msg.sdp,
          status: 'ringing',
          createdAt: Date.now()
        });
      }
    } else if (msg.type === 'call-answer') {
      const rec = activeIncomingCalls.get(msg.callId || callId);
      if (rec) rec.status = 'answered';
    } else if (['call-reject', 'call-end', 'call-busy'].includes(msg.type)) {
      activeIncomingCalls.delete(msg.callId || callId);
    }

    for (const uid of targetSet) {
      sendToUser(uid, payload);
    }
  }
}

function startServers() {
  const httpServer = http.createServer(handleRequest);
  setupWebSocketUpgrade(httpServer);

  let httpsServer = null;
  try {
    const creds = ensureTlsCertificate(CERTS_DIR);
    httpsServer = https.createServer(creds, handleRequest);
    setupWebSocketUpgrade(httpsServer);
  } catch (err) {
    console.warn('[UYARI] HTTPS sertifikası başlatılamadı:', err.message);
  }

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    const lanIp = ips.length > 0 ? ips[0].address : 'localhost';
    console.log('==============================================================');
    console.log('  MESAJLASMA SUNUCUSU AKTIF (Windows x64 & Mobil PWA Uyumlu)  ');
    console.log('==============================================================');
    console.log(`  Bilgisayar (Yerel) : http://localhost:${HTTP_PORT}`);
    console.log(`  Cep Telefonu (LAN) : http://${lanIp}:${HTTP_PORT}`);
    if (httpsServer) {
      console.log(`  Guvenli HTTPS (LAN): https://${lanIp}:${HTTPS_PORT}`);
    }
    console.log('==============================================================');
  });

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0');
  }

  return { httpServer, httpsServer };
}

if (require.main === module) {
  startServers();
}

module.exports = {
  startServers,
  HTTP_PORT,
  HTTPS_PORT
};
