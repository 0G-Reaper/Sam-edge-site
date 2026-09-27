import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, linkSync, mkdtempSync, openSync, closeSync, fsyncSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'

// Versioned authenticated envelope: magic (8), random IV (12), ciphertext, tag (16).
const MAGIC = Buffer.from('SAMBAK01'), HEADER_SIZE = 20, TAG_SIZE = 16
const COUNT_TABLES = ['waitlist', 'members', 'membership_devices', 'member_invites', 'member_collectibles', 'member_research', 'member_research_deletions', 'member_deletions']

export function backupKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('MEMBER_BACKUP_KEY must be a protected, base64-encoded 32-byte random key.')
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('Invalid backup key.')
  return key
}

function verifyDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=5000')
    const checks = db.prepare('PRAGMA integrity_check').all()
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('Backup failed SQLite integrity verification.')
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='waitlist'").get())
      throw new Error('This is not a member-site database.')
    const counts: Record<string, number> = {}
    for (const name of COUNT_TABLES) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
        counts[name] = Number(db.prepare(`SELECT COUNT(*) count FROM ${name}`).get()!.count)
    }
    return { integrity: 'ok' as const, counts }
  } finally { db.close() }
}

function syncFile(path: string) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function publishNew(staged: string, destination: string) {
  // Same-filesystem hard link publishes atomically and refuses even a dangling symlink.
  // Neither backups nor restores ever overwrite an existing file.
  syncFile(staged)
  linkSync(staged, destination)
  syncFile(dirname(destination))
}

function workspace(destination: string) {
  if (existsSync(destination)) throw new Error('Destination exists; choose a new path.')
  const parent = dirname(destination)
  if (!statSync(parent).isDirectory()) throw new Error('Destination directory does not exist.')
  // mkdtemp uses 0700; plaintext never goes into the shared parent directory.
  return mkdtempSync(join(parent, '.sam-backup-'))
}

async function encryptedDigest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Consistent snapshot includes committed WAL pages; original DB remains untouched. */
export async function createMemberBackup(sourcePath: string, destinationPath: string, key: Buffer) {
  if (key.length !== 32) throw new Error('A 32-byte backup key is required.')
  const source = resolve(sourcePath), destination = resolve(destinationPath)
  if (source === destination || !statSync(source).isFile()) throw new Error('Select an existing database and a different backup path.')
  const temp = workspace(destination), snapshot = join(temp, 'snapshot.sqlite'), sealed = join(temp, 'backup.enc')
  try {
    const db = new DatabaseSync(source, { readOnly: true })
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL')
      // VACUUM INTO creates a consistent standalone copy and excludes deleted free pages.
      db.prepare('VACUUM INTO ?').run(snapshot)
    } finally { db.close() }
    const verified = verifyDatabase(snapshot)
    const iv = randomBytes(12), header = Buffer.concat([MAGIC, iv])
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(header)
    const fd = openSync(sealed, 'wx', 0o600)
    try { writeSync(fd, header) } finally { closeSync(fd) }
    await pipeline(createReadStream(snapshot), cipher, createWriteStream(sealed, { flags: 'a', mode: 0o600 }))
    const tagFd = openSync(sealed, 'a')
    try { writeSync(tagFd, cipher.getAuthTag()) } finally { closeSync(tagFd) }
    const sha256 = await encryptedDigest(sealed)
    publishNew(sealed, destination)
    return { ...verified, bytes: statSync(destination).size, sha256 }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

/** Authenticated restore to a NEW path only. Never opens or replaces a live DB. */
export async function restoreMemberBackup(backupPath: string, destinationPath: string, key: Buffer) {
  if (key.length !== 32) throw new Error('A 32-byte backup key is required.')
  const source = resolve(backupPath), destination = resolve(destinationPath), size = statSync(source).size
  if (source === destination || size <= HEADER_SIZE + TAG_SIZE) throw new Error('Invalid backup file.')
  const temp = workspace(destination), snapshot = join(temp, 'restored.sqlite')
  try {
    const fd = openSync(source, 'r'), header = Buffer.alloc(HEADER_SIZE), tag = Buffer.alloc(TAG_SIZE)
    try {
      if (readSync(fd, header, 0, HEADER_SIZE, 0) !== HEADER_SIZE || readSync(fd, tag, 0, TAG_SIZE, size - TAG_SIZE) !== TAG_SIZE)
        throw new Error('Incomplete backup file.')
    } finally { closeSync(fd) }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Unknown backup format.')
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length))
    decipher.setAAD(header); decipher.setAuthTag(tag)
    try {
      await pipeline(createReadStream(source, { start: HEADER_SIZE, end: size - TAG_SIZE - 1 }), decipher,
        createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }))
    } catch { throw new Error('Backup authentication failed; nothing was restored.') }
    const verified = verifyDatabase(snapshot)
    publishNew(snapshot, destination)
    return { ...verified, bytes: statSync(destination).size }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
