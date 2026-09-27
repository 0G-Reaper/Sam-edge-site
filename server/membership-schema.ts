import { randomBytes } from 'node:crypto'
import type { Db } from './db.js'

/** Additive migration: the original waitlist and its private member keys are untouched. */
export function initializeMembershipSchema(db: Db, now = Date.now(), importWaitlist = true): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS membership_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      inviter_id INTEGER REFERENCES members(id),
      disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS membership_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS membership_devices (
      id TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
      public_key_hash TEXT NOT NULL, public_key_jwk TEXT NOT NULL,
      label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      revoked_at INTEGER, UNIQUE(member_id, public_key_hash)
    );
    CREATE INDEX IF NOT EXISTS membership_devices_member ON membership_devices(member_id, revoked_at);
    CREATE TABLE IF NOT EXISTS membership_challenges (
      id TEXT PRIMARY KEY, member_id INTEGER, email TEXT NOT NULL, user_id TEXT,
      invite_token TEXT, public_key_jwk TEXT NOT NULL, public_key_hash TEXT NOT NULL,
      nonce TEXT NOT NULL, code_hash TEXT NOT NULL, device_label TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS membership_sessions (
      id TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
      device_id TEXT NOT NULL REFERENCES membership_devices(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS membership_request_nonces (
      session_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS membership_request_nonce_expiry ON membership_request_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS membership_auth_limits (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS membership_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER,
      event TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (importWaitlist && !db.prepare('SELECT 1 FROM membership_migrations WHERE name = ?').get('waitlist-bootstrap-v1')) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='waitlist'").get()
      if (exists) {
        // No INSERT OR IGNORE: identity collisions must stop rollout rather than silently lose a member.
        db.exec(`INSERT INTO members (id, user_id, email, created_at)
          SELECT id, user_id, email, created_at FROM waitlist ORDER BY id`)
      }
      db.prepare('INSERT INTO membership_migrations(name, applied_at) VALUES (?, ?)').run('waitlist-bootstrap-v1', new Date(now).toISOString())
    }
    db.prepare('INSERT OR IGNORE INTO membership_secrets(name, value) VALUES (?, ?)').run('otp-hmac-v1', randomBytes(32).toString('hex'))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
