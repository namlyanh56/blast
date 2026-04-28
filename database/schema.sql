-- ============================================================
-- USERS (admin & clients)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  telegram_id     BIGINT UNIQUE NOT NULL,
  username        VARCHAR(100) DEFAULT '',
  full_name       VARCHAR(200) DEFAULT '',
  role            VARCHAR(10)  DEFAULT 'client' CHECK (role IN ('admin','client')),
  balance         DECIMAL(15,2) DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- WHATSAPP SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS wa_sessions (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_name    VARCHAR(100) NOT NULL,
  phone_number    VARCHAR(25)  DEFAULT '',
  status          VARCHAR(20)  DEFAULT 'disconnected'
                  CHECK (status IN ('connected','disconnected','banned','connecting')),
  delay_ms        INTEGER DEFAULT 3000,
  last_connected  TIMESTAMP,
  last_msg_index  INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- GLOBAL SETTINGS (key-value)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key             VARCHAR(100) PRIMARY KEY,
  value           TEXT,
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- BLAST TARGETS
-- ============================================================
CREATE TABLE IF NOT EXISTS targets (
  id              SERIAL PRIMARY KEY,
  phone_number    VARCHAR(25) UNIQUE NOT NULL,
  status          VARCHAR(10) DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','failed')),
  sent_at         TIMESTAMP,
  sent_by_session INTEGER REFERENCES wa_sessions(id) ON DELETE SET NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- SEND LOGS
-- ============================================================
CREATE TABLE IF NOT EXISTS send_logs (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER REFERENCES wa_sessions(id) ON DELETE SET NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone_number    VARCHAR(25) NOT NULL,
  status          VARCHAR(10) DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  cost            DECIMAL(10,2) DEFAULT 0,
  sent_at         TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- WALLETS (client payment info for withdrawal)
-- ============================================================
CREATE TABLE IF NOT EXISTS wallets (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  method          VARCHAR(50),
  account_number  VARCHAR(60),
  account_name    VARCHAR(100),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- WITHDRAWALS
-- ============================================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id),
  amount          DECIMAL(15,2) NOT NULL,
  method          VARCHAR(50),
  account_number  VARCHAR(60),
  account_name    VARCHAR(100),
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','success','failed')),
  duitku_ref      VARCHAR(120),
  note            TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- DEFAULT SETTINGS
-- ============================================================
INSERT INTO settings (key, value) VALUES
  ('message_text',       'Halo! Ini adalah pesan promosi dari kami. Terima kasih.'),
  ('message_image',      ''),
  ('button_name',        'Kunjungi Kami'),
  ('button_url',         'https://example.com'),
  ('price_per_message',  '100'),
  ('min_withdraw',       '10000')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_targets_status      ON targets(status);
CREATE INDEX IF NOT EXISTS idx_targets_phone       ON targets(phone_number);
CREATE INDEX IF NOT EXISTS idx_send_logs_session   ON send_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_send_logs_user      ON send_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_user    ON wa_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_sessions_status  ON wa_sessions(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user    ON withdrawals(user_id);

-- FIX 3: Universal profile settings (one-time admin config, auto-applied to all sessions)
INSERT INTO settings (key, value) VALUES
  ('profile_name', ''),
  ('profile_pic',  '')
ON CONFLICT (key) DO NOTHING;
