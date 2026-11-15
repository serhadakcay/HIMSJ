/**
 * Mesajlaşma Uygulaması - Veritabanı Katmanı (Node.js Yerleşik SQLite - x64 Uyumlu)
 * - Telefon rehberi (numara kaydetme, VCF, metin ve mobil rehber senkronizasyonu)
 * - Numara ile kaydedilen kişilerin programı kullandığında otomatik hesap entegrasyonu
 * - SMS ve WhatsApp davet bağlantısı üretimi
 * - Aktif (Yeşil) / Aktif Olmayan (Kırmızı) durum takibi
 * - Arka plan bildirim yoklama desteği
 * - Uçtan uca şifreleme (E2EE), grup/kanal, anket, hikâye ve sesli/görüntülü arama kayıtları
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'mesajlasma.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
`);

/**
 * Telefon numaralarını karşılaştırma ve eşleştirme için standartlaştırır.
 * Örn: "0532 100 10 01", "+90 (532) 100-1001", "5321001001" -> "+905321001001"
 */
function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  let digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.length === 10 && !digits.startsWith('90')) {
    digits = '90' + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = '90' + digits.slice(1);
  } else if (digits.length === 13 && digits.startsWith('900')) {
    digits = '90' + digits.slice(3);
  }
  return '+' + digits;
}

function formatPhoneDisplay(rawPhone) {
  const cleanedRaw = String(rawPhone || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  const norm = normalizePhone(cleanedRaw);
  if (/^\+90\d{10}$/.test(norm)) {
    return `${norm.slice(0, 3)} ${norm.slice(3, 6)} ${norm.slice(6, 9)} ${norm.slice(9, 11)} ${norm.slice(11, 13)}`;
  }
  return String(cleanedRaw || norm).trim();
}

/**
 * Numara veya rehberden eklenen kişiler için SMS ve WhatsApp mesaj metni ve bağlantılarını üretir.
 * Şablon: "(............ Bu numaraları kullanıcı sizi programı kullanmak için ekledi)"
 */
function buildInvitePayload({ targetPhone, targetName, senderName, senderPhone, appUrl, allPhones }) {
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

function initSchema() {
  db.exec(`
    -- 1. Kullanıcılar ve Profiller
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      phone_normalized TEXT DEFAULT '',
      is_registered INTEGER DEFAULT 1,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#10b981',
      avatar_url TEXT DEFAULT '',
      bio TEXT DEFAULT 'Mesajlaşma kullanıyorum',
      public_key TEXT DEFAULT '',
      key_fingerprint TEXT DEFAULT '',
      privacy_last_seen TEXT DEFAULT 'everyone',
      privacy_read_receipts INTEGER DEFAULT 1,
      privacy_hide_notif_content INTEGER DEFAULT 0,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Oturumlar ve Cihazlar (Çoklu Cihaz ve Arka Plan Yönetimi)
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_name TEXT DEFAULT 'Bilinmeyen Cihaz',
      device_platform TEXT DEFAULT 'Web',
      ip_address TEXT DEFAULT '',
      bg_permission INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 3. Cihaz / Anahtar Doğrulama Kayıtları (E2EE Güvenlik)
    CREATE TABLE IF NOT EXISTS verified_keys (
      user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      verified_fingerprint TEXT NOT NULL,
      verified_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, peer_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (peer_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 4. Sohbetler (direct, group, channel)
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('direct', 'group', 'channel')),
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      avatar_color TEXT DEFAULT '#3b82f6',
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    -- 5. Sohbet Üyeleri ve Roller
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'subscriber')),
      pinned INTEGER DEFAULT 0,
      muted INTEGER DEFAULT 0,
      last_read_message_id TEXT DEFAULT '',
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 6. Mesajlar
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text' CHECK (msg_type IN ('text', 'image', 'video', 'audio', 'file', 'poll', 'system')),
      content TEXT DEFAULT '',
      ciphertext TEXT DEFAULT '',
      iv TEXT DEFAULT '',
      sender_public_key TEXT DEFAULT '',
      is_encrypted INTEGER DEFAULT 0,
      attachment_url TEXT DEFAULT '',
      attachment_name TEXT DEFAULT '',
      attachment_size INTEGER DEFAULT 0,
      attachment_mime TEXT DEFAULT '',
      audio_duration INTEGER DEFAULT 0,
      reply_to_id TEXT DEFAULT NULL,
      forwarded_from_name TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0,
      edited_at TEXT DEFAULT NULL,
      deleted_at TEXT DEFAULT NULL,
      status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 7. Mesaj Teslim ve Okundu Bilgileri
    CREATE TABLE IF NOT EXISTS message_receipts (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      delivered_at TEXT DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT DEFAULT NULL,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 8. Anketler (Polls)
    CREATE TABLE IF NOT EXISTS polls (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      voted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (poll_id, user_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 9. Hikâye / Durum Paylaşımları (24 Saatlik Durumlar)
    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text_content TEXT DEFAULT '',
      media_url TEXT DEFAULT '',
      bg_color TEXT DEFAULT '#0f766e',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
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

    -- 10. Kişiler (Telefon Rehberi Kayıtları), Engellenenler ve Şikâyetler
    CREATE TABLE IF NOT EXISTS contacts (
      user_id TEXT NOT NULL,
      contact_user_id TEXT NOT NULL,
      contact_name TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      contact_phone_normalized TEXT DEFAULT '',
      invited_via TEXT DEFAULT '',
      invited_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, contact_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
      user_id TEXT NOT NULL,
      blocked_user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, blocked_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      reported_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- 11. Sesli ve Görüntülü Arama Geçmişi
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      caller_id TEXT NOT NULL,
      call_type TEXT NOT NULL CHECK (call_type IN ('audio', 'video')),
      status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'ongoing', 'completed', 'missed', 'rejected')),
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT DEFAULT NULL,
      duration_sec INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Mevcut tabloda eksik sütun varsa güvenli migrasyon yap
  try { db.exec("ALTER TABLE users ADD COLUMN phone_normalized TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE users ADD COLUMN is_registered INTEGER DEFAULT 1"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN contact_name TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN contact_phone TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN contact_phone_normalized TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN invited_via TEXT DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE contacts ADD COLUMN invited_at TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN bg_permission INTEGER DEFAULT 0"); } catch {}

  // Eskiden kalan deneme (demo) hesaplarını ve sohbetlerini otomatik temizle
  db.exec(`
    DELETE FROM conversations WHERE id IN ('conv_ahmet_zeynep', 'conv_proje_ekibi', 'conv_duyuru_kanali');
    DELETE FROM users WHERE id IN ('usr_ahmet', 'usr_zeynep', 'usr_mehmet', 'usr_elif');
  `);

  // Mevcut kullanıcıların normalize telefonlarını ve kayıt durumlarını güncelle
  const allUsers = db.prepare('SELECT id, username, phone, is_registered FROM users').all();
  const updPhone = db.prepare('UPDATE users SET phone_normalized = ?, is_registered = ? WHERE id = ?');
  for (const u of allUsers) {
    const isReg = u.username && u.username.startsWith('tel_') && u.is_registered === null ? 0 : (u.is_registered ?? 1);
    updPhone.run(normalizePhone(u.phone), isReg, u.id);
  }

  const allContacts = db.prepare('SELECT user_id, contact_user_id, contact_phone FROM contacts').all();
  const updContactPhone = db.prepare('UPDATE contacts SET contact_phone_normalized = ? WHERE user_id = ? AND contact_user_id = ?');
  for (const c of allContacts) {
    updContactPhone.run(normalizePhone(c.contact_phone), c.user_id, c.contact_user_id);
  }
}

function clearAllDatabaseData() {
  db.exec(`
    DELETE FROM calls;
    DELETE FROM reports;
    DELETE FROM blocked_users;
    DELETE FROM contacts;
    DELETE FROM story_views;
    DELETE FROM stories;
    DELETE FROM poll_votes;
    DELETE FROM polls;
    DELETE FROM message_receipts;
    DELETE FROM messages;
    DELETE FROM conversation_members;
    DELETE FROM conversations;
    DELETE FROM verified_keys;
    DELETE FROM sessions;
    DELETE FROM users;
    VACUUM;
  `);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const computed = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

function generateFingerprint(inputStr) {
  const digest = crypto.createHash('sha256').update(inputStr).digest();
  const groups = [];
  for (let i = 0; i < 12; i++) {
    const num = digest.readUInt16BE(i * 2) % 100000;
    groups.push(String(num).padStart(5, '0'));
  }
  return groups.join(' ');
}

initSchema();

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  hashPassword,
  verifyPassword,
  generateFingerprint,
  normalizePhone,
  formatPhoneDisplay,
  buildInvitePayload,
  clearAllDatabaseData
};
