import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { memberKey } from './keys.js'

export type Db = DatabaseSync

export interface Signup {
  userId: string
  email: string
}

export type SignupResult =
  | { status: 'created'; key: string }
  | { status: 'existing' }
  | { status: 'taken' }

export interface SignupRow {
  user_id: string
  email: string
  user_key: string
  created_at: string
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      user_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email ON waitlist (email);
    CREATE UNIQUE INDEX IF NOT EXISTS waitlist_user_id ON waitlist (user_id COLLATE NOCASE);
  `)
  return db
}

function emailExists(db: Db, email: string): boolean {
  return db.prepare('SELECT 1 AS one FROM waitlist WHERE email = ?').get(email) !== undefined
}

function userIdExists(db: Db, userId: string): boolean {
  return db.prepare('SELECT 1 AS one FROM waitlist WHERE user_id = ? COLLATE NOCASE').get(userId) !== undefined
}

/** Records a signup. Emails are unique: a repeat submission never mints a second key. */
export function addSignup(db: Db, s: Signup): SignupResult {
  if (emailExists(db, s.email)) return { status: 'existing' }
  if (userIdExists(db, s.userId)) return { status: 'taken' }
  const insert = db.prepare('INSERT INTO waitlist (user_id, email, user_key) VALUES (?, ?, ?)')
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = memberKey()
    try {
      insert.run(s.userId, s.email, key)
      return { status: 'created', key }
    } catch {
      // A unique constraint fired: work out which one, or retry on the (astronomically rare) key collision.
      if (emailExists(db, s.email)) return { status: 'existing' }
      if (userIdExists(db, s.userId)) return { status: 'taken' }
    }
  }
  throw new Error('could not allocate a member key')
}

export function allSignups(db: Db): SignupRow[] {
  return db
    .prepare('SELECT user_id, email, user_key, created_at FROM waitlist ORDER BY id')
    .all() as unknown as SignupRow[]
}

export function countSignups(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as { n: number } | undefined
  return row ? Number(row.n) : 0
}
