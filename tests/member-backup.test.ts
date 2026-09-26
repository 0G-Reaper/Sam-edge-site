import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemberBackup, restoreMemberBackup, backupKey } from '../server/member-backup.js'
import { addSignup, openDb } from '../server/db.js'
import { initializeMembershipSchema } from '../server/membership-schema.js'
import { initMembershipQuests, onMemberVerified } from '../server/membership-quests.js'

const dirs: string[] = [], dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}) })
function setup() {
  const dir = mkdtempSync(join(tmpdir(),'sam-recovery-test-')); dirs.push(dir)
  const source = join(dir,'live.sqlite'), encrypted = join(dir,'saved.enc'), restored = join(dir,'restored.sqlite')
  const db = openDb(source); dbs.push(db)
  db.exec('PRAGMA wal_autocheckpoint=0')
  addSignup(db,{userId:'OriginalFounder',email:'private-founder@example.com'})
  initializeMembershipSchema(db); initMembershipQuests(db)
  db.prepare('UPDATE members SET verified_at=? WHERE id=1').run(new Date().toISOString())
  onMemberVerified(db,1)
  return { dir, source, encrypted, restored, db, key: randomBytes(32) }
}

describe('encrypted member database recovery', () => {
  it('restores committed WAL data and exact member/collectible state while the source stays open', async () => {
    const f = setup()
    const saved = await createMemberBackup(f.source,f.encrypted,f.key)
    expect(saved.integrity).toBe('ok'); expect(saved.counts.members).toBe(1)
    expect(saved.counts.member_collectibles).toBe(1)
    expect(readFileSync(f.encrypted).includes(Buffer.from('private-founder@example.com'))).toBe(false)
    addSignup(f.db,{userId:'AfterBackup',email:'after@example.com'})
    const result = await restoreMemberBackup(f.encrypted,f.restored,f.key)
    expect(result.counts).toEqual(saved.counts)
    const restored = new DatabaseSync(f.restored); dbs.push(restored)
    expect(restored.prepare('SELECT user_id,email FROM members').get()).toEqual({user_id:'OriginalFounder',email:'private-founder@example.com'})
    expect(restored.prepare('SELECT * FROM member_collectibles').all()).toEqual(f.db.prepare('SELECT * FROM member_collectibles').all())
    expect(restored.prepare('SELECT COUNT(*) n FROM waitlist').get()!.n).toBe(1)
    expect(f.db.prepare('SELECT COUNT(*) n FROM waitlist').get()!.n).toBe(2)
    expect(statSync(f.encrypted).mode & 0o777).toBe(0o600)
    expect(statSync(f.restored).mode & 0o777).toBe(0o600)
    expect(readdirSync(f.dir).some(name=>name.startsWith('.sam-backup-'))).toBe(false)
  })

  it('refuses wrong keys, altered ciphertext, altered IVs and truncation without publishing plaintext', async () => {
    const f = setup(); await createMemberBackup(f.source,f.encrypted,f.key)
    await expect(restoreMemberBackup(f.encrypted,f.restored,randomBytes(32))).rejects.toThrow('authentication')
    const original = readFileSync(f.encrypted)
    for (const position of [10,40,original.length-1]) {
      const changed = Buffer.from(original); changed[position] ^= 1; writeFileSync(f.encrypted,changed)
      await expect(restoreMemberBackup(f.encrypted,f.restored,f.key)).rejects.toThrow('authentication')
      expect(existsSync(f.restored)).toBe(false)
    }
    writeFileSync(f.encrypted,original.subarray(0,original.length-5))
    await expect(restoreMemberBackup(f.encrypted,f.restored,f.key)).rejects.toThrow('authentication')
    expect(readdirSync(f.dir).some(name=>name.startsWith('.sam-backup-'))).toBe(false)
  })

  it('never overwrites an existing backup or database and validates the key format', async () => {
    const f = setup(); await createMemberBackup(f.source,f.encrypted,f.key)
    const sealed = readFileSync(f.encrypted), live = readFileSync(f.source)
    await expect(createMemberBackup(f.source,f.encrypted,f.key)).rejects.toThrow('Destination exists')
    await expect(restoreMemberBackup(f.encrypted,f.source,f.key)).rejects.toThrow('Destination exists')
    expect(readFileSync(f.encrypted)).toEqual(sealed); expect(readFileSync(f.source)).toEqual(live)
    for (const key of [undefined,'password',Buffer.alloc(31).toString('base64')]) expect(()=>backupKey(key)).toThrow()
    expect(backupKey(f.key.toString('base64'))).toEqual(f.key)
  })
})
