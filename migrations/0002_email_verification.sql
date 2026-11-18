-- One-time email verification tokens. Store only SHA-256 token hashes.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_verification_user
  ON email_verification_tokens(user_id, used_at, expires_at);
