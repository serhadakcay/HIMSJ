const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'nexuschat_v8.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    phone_normalized TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    is_registered INTEGER DEFAULT 1,
    public_key_jwk TEXT DEFAULT '',
    key_fingerprint TEXT DEFAULT '',
    avatar_color TEXT DEFAULT '#00a884',
    avatar_url TEXT DEFAULT '',
    bio TEXT DEFAULT 'Merhaba! NexusChat E2EE kullanıyorum.',
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_name TEXT DEFAULT 'Cihaz',
    device_type TEXT DEFAULT 'mobile',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id TEXT NOT NULL,
    contact_user_id TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_phone_normalized TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, contact_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    msg_type TEXT DEFAULT 'text',
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    msg_num INTEGER DEFAULT 0,
    sender_public_key_jwk TEXT DEFAULT '',
    ttl_ms INTEGER DEFAULT 0,
    status TEXT DEFAULT 'sent',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL,
    callee_id TEXT NOT NULL,
    call_type TEXT DEFAULT 'audio',
    status TEXT DEFAULT 'missed',
    duration_sec INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (callee_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    caption TEXT DEFAULT '',
    media_url TEXT DEFAULT '',
    bg_color TEXT DEFAULT '#0f766e',
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    viewed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (story_id, viewer_id),
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
    FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    device_type TEXT DEFAULT 'mobile',
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const cleaned = String(rawPhone).replace(/[​-‏‪-‮⁠-⁯﻿]/g, '').trim();
  let digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && !digits.startsWith('90')) digits = '90' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '90' + digits.slice(1);
  else if (digits.length === 13 && digits.startsWith('900')) digits = '90' + digits.slice(3);
  return '+' + digits;
}

function formatPhoneDisplay(rawPhone) {
  const norm = normalizePhone(rawPhone);
  if (/^\+90\d{10}$/.test(norm)) {
    return `${norm.slice(0, 3)} ${norm.slice(3, 6)} ${norm.slice(6, 9)} ${norm.slice(9, 11)} ${norm.slice(11, 13)}`;
  }
  return norm || String(rawPhone || '').trim();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  try {
    const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function generateFingerprint(inputStr) {
  const digest = crypto.createHash('sha256').update(String(inputStr || '')).digest();
  const blocks = [];
  for (let i = 0; i < 10; i++) {
    const num = digest.readUInt16BE(i * 2) % 100000;
    blocks.push(String(num).padStart(5, '0'));
  }
  return blocks.join(' ');
}

function buildInviteLinks({ targetPhone, targetName, senderName, senderPhone, appUrl }) {
  const norm = normalizePhone(targetPhone);
  const displayPhone = formatPhoneDisplay(targetPhone || norm);
  const waDigits = norm.replace(/\D/g, '');
  const senderLabel = senderPhone ? `${senderName} (${formatPhoneDisplay(senderPhone)})` : senderName;
  const urlPart = appUrl ? ` Uygulama adresi: ${appUrl}` : '';
  const text = `${senderLabel} sizi NexusChat E2EE güvenli mesajlaşma ve görüntülü arama programını kullanmaya davet ediyor.${urlPart}`;
  const encoded = encodeURIComponent(text);

  return {
    phone: displayPhone,
    phoneNormalized: norm,
    name: targetName || displayPhone,
    inviteText: text,
    whatsappUrl: waDigits ? `https://wa.me/${waDigits}?text=${encoded}` : `https://wa.me/?text=${encoded}`,
    smsUrl: norm ? `sms:${norm}?body=${encoded}` : `sms:?body=${encoded}`
  };
}

function decodeQuotedPrintable(linePrefix, rawVal) {
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

function parseRawContactsText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  const results = [];

  if (/BEGIN:VCARD/i.test(text)) {
    const unfolded = text.replace(/=?
/g, '').replace(/?
[ 	]/g, '');
    const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      let name = '';
      const phones = [];
      for (const line of card.split(/?
/)) {
        if (/^(?:item\d+\.)?FN(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) name = decodeQuotedPrintable(line.slice(0, idx), line.slice(idx + 1)) || name;
        } else if (!name && /^(?:item\d+\.)?N(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const parts = decodeQuotedPrintable(line.slice(0, idx), line.slice(idx + 1)).split(';').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 0) name = parts.reverse().join(' ');
          }
        } else if (/^(?:item\d+\.)?TEL(?:;|:)/i.test(line)) {
          const idx = line.indexOf(':');
          if (idx !== -1) {
            const tel = decodeQuotedPrintable(line.slice(0, idx), line.slice(idx + 1)).replace(/^tel:/i, '').trim();
            if (tel) phones.push(tel);
          }
        }
      }
      for (const p of phones) {
        results.push({ name: name || formatPhoneDisplay(p), phone: p });
      }
    }
    return results;
  }

  for (const line of text.split(/?
/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/(?:\+|00)?\d[\d\s().-]{5,20}\d/);
    if (match) {
      const phoneStr = match[0].trim();
      const namePart = trimmed.replace(match[0], '').replace(/^[\s,:;-]+|[\s,:;-]+$/g, '').trim();
      results.push({ name: namePart || formatPhoneDisplay(phoneStr), phone: phoneStr });
    }
  }
  return results;
}

module.exports = {
  db,
  normalizePhone,
  formatPhoneDisplay,
  hashPassword,
  verifyPassword,
  generateFingerprint,
  buildInviteLinks,
  parseRawContactsText
};
