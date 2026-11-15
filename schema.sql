-- Mesajlaşma Uygulaması - PostgreSQL Veri Modeli Şeması (Doküman Bölüm 4 & 6)
-- Özel sunucu (Ubuntu Server LTS / Docker) üzerinde PostgreSQL dağıtımı için referans şema

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) DEFAULT '',
  phone_normalized VARCHAR(40) DEFAULT '',
  is_registered BOOLEAN DEFAULT TRUE,
  password_hash TEXT NOT NULL,
  password_salt VARCHAR(64) NOT NULL,
  avatar_color VARCHAR(16) DEFAULT '#10b981',
  avatar_url TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  public_key TEXT DEFAULT '',
  key_fingerprint VARCHAR(128) DEFAULT '',
  privacy_last_seen VARCHAR(24) DEFAULT 'everyone',
  privacy_read_receipts BOOLEAN DEFAULT TRUE,
  privacy_hide_notif_content BOOLEAN DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name VARCHAR(120) DEFAULT 'Web',
  device_platform VARCHAR(64) DEFAULT 'Desktop',
  ip_address VARCHAR(64) DEFAULT '',
  bg_permission BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verified_keys (
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_fingerprint VARCHAR(128) NOT NULL,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, peer_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id VARCHAR(64) PRIMARY KEY,
  type VARCHAR(16) NOT NULL CHECK (type IN ('direct', 'group', 'channel')),
  title VARCHAR(160) DEFAULT '',
  description TEXT DEFAULT '',
  avatar_color VARCHAR(16) DEFAULT '#3b82f6',
  created_by VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL DEFAULT 'member',
  pinned BOOLEAN DEFAULT FALSE,
  muted BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id VARCHAR(64) PRIMARY KEY,
  conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg_type VARCHAR(24) NOT NULL DEFAULT 'text',
  content TEXT DEFAULT '',
  ciphertext TEXT DEFAULT '',
  iv VARCHAR(64) DEFAULT '',
  sender_public_key TEXT DEFAULT '',
  is_encrypted BOOLEAN DEFAULT FALSE,
  attachment_url TEXT DEFAULT '',
  attachment_name VARCHAR(255) DEFAULT '',
  attachment_size BIGINT DEFAULT 0,
  attachment_mime VARCHAR(120) DEFAULT '',
  audio_duration INTEGER DEFAULT 0,
  reply_to_id VARCHAR(64) DEFAULT NULL,
  forwarded_from_name VARCHAR(120) DEFAULT '',
  pinned BOOLEAN DEFAULT FALSE,
  edited_at TIMESTAMPTZ DEFAULT NULL,
  deleted_at TIMESTAMPTZ DEFAULT NULL,
  status VARCHAR(24) DEFAULT 'sent',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_name VARCHAR(120) DEFAULT '',
  contact_phone VARCHAR(40) DEFAULT '',
  contact_phone_normalized VARCHAR(40) DEFAULT '',
  invited_via VARCHAR(32) DEFAULT '',
  invited_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_user_id)
);
