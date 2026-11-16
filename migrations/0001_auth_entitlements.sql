-- CIVIL AI account and entitlement foundation.
-- Apply this migration to the production D1 database before binding it to the Worker.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS premium_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'pending')),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  provider TEXT,
  provider_reference TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, provider_reference)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user_status ON premium_entitlements(user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY(provider, event_id)
);
