const crypto = require('node:crypto');
const { Pool, types } = require('pg');

// BIGINT (int8) değerlerini string yerine Number olarak döndür
types.setTypeParser(20, (v) => Number(v));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[HATA] DATABASE_URL ortam değişkeni tanımlı değil! (.env dosyasına veya Render > Environment bölümüne ekleyin)');
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});
pool.on('error', (err) => console.error('PostgreSQL bağlantı hatası:', err.message));

// SQLite ile aynı formatta (UTC, "YYYY-MM-DD HH:MM:SS") zaman damgası
const NOW_TXT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
const NOW_PLUS_24H_TXT = `to_char((now() + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// SQLite tarzı sorguları PostgreSQL'e çevirir (? -> $1, datetime('now') -> NOW_TXT)
function translateSql(sql) {
  let s = String(sql)
    .replace(/datetime\('now',\s*'\+24 hours'\)/g, NOW_PLUS_24H_TXT)
    .replace(/datetime\('now'\)/g, NOW_TXT)
    .replace(/\bCURRENT_TIMESTAMP\b/g, NOW_TXT);
  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);
  return s;
}

// Eski db.prepare(sql).get/all/run kullanımını koruyan asenkron uyumluluk katmanı
const db = {
  prepare(sql) {
    const text = translateSql(sql);
    return {
      async get(...params) {
        const r = await pool.query(text, params);
        return r.rows[0];
      },
      async all(...params) {
        const r = await pool.query(text, params);
        return r.rows;
      },
      async run(...params) {
        const r = await pool.query(text, params);
        return { changes: r.rowCount };
      }
    };
  },
  query: (text, params) => pool.query(text, params)
};

async function initDb() {
  const D = `DEFAULT (${NOW_TXT})`;
  await pool.query(`
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
    last_seen_at TEXT ${D},
    created_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT DEFAULT 'Cihaz',
    device_type TEXT DEFAULT 'mobile',
    created_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_name TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_phone_normalized TEXT NOT NULL,
    created_at TEXT ${D},
    PRIMARY KEY (user_id, contact_user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    msg_type TEXT DEFAULT 'text',
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    msg_num BIGINT DEFAULT 0,
    sender_public_key_jwk TEXT DEFAULT '',
    recipient_public_key_jwk TEXT DEFAULT '',
    ttl_ms BIGINT DEFAULT 0,
    status TEXT DEFAULT 'sent',
    created_at TEXT ${D}
  );
  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id, seq);

  CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_type TEXT DEFAULT 'audio',
    status TEXT DEFAULT 'missed',
    duration_sec INTEGER DEFAULT 0,
    created_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    caption TEXT DEFAULT '',
    media_url TEXT DEFAULT '',
    bg_color TEXT DEFAULT '#0f766e',
    expires_at TEXT NOT NULL,
    created_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at TEXT ${D},
    PRIMARY KEY (story_id, viewer_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type TEXT DEFAULT 'mobile',
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    updated_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    data BYTEA NOT NULL,
    created_at TEXT ${D}
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS key_backup TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE blobs ADD COLUMN IF NOT EXISTS owner_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (${NOW_TXT})
    )
  `);
  await pool.query(`DELETE FROM invites WHERE expires_at < ${NOW_TXT}`);
  // Geçerli bir AES-GCM şifreli dosya en az 16 bayttır; daha küçükler bozuk/deneme kaydıdır
  await pool.query(`DELETE FROM blobs WHERE octet_length(data) < 16`);
  console.log('✅ PostgreSQL tabloları hazır.');
}

function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const cleaned = String(rawPhone).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
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
    const unfolded = text.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '');
    const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      let name = '';
      const phones = [];
      for (const line of card.split(/\r?\n/)) {
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

  for (const line of text.split(/\r?\n/)) {
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
  pool,
  initDb,
  normalizePhone,
  formatPhoneDisplay,
  hashPassword,
  verifyPassword,
  generateFingerprint,
  buildInviteLinks,
  parseRawContactsText
};
