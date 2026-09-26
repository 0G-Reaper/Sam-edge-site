import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { addSignup, openDb, type Db } from '../server/db.js'
import { finalizeMemberDeletions, requestMemberDeletion } from '../server/member-deletion.js'
import { enqueueMail } from '../server/mail.js'
import { issueInvite, onMemberVerified } from '../server/membership-quests.js'
import { initializeMembershipSchema } from '../server/membership-schema.js'
import type { MemberRuntime } from '../server/members.js'

const NOW = 1_800_000_000_000
const databases: Db[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function fixture() {
  const db = openDb(':memory:'); databases.push(db)
  addSignup(db, { userId: 'Founder', email: 'founder@example.com' })
  let runtime!: MemberRuntime, sent = 0
  const app = createApp({ db, now: () => NOW, markets: async () => ({ asOf: new Date(NOW).toISOString(), items: [] }),
    adminToken: 'test-admin', membership: { enabled: true,
      mail: { enabled: true, apiKey: 'test-mail', from: 'sam@example.com', now: () => NOW,
        fetchImpl: (async () => { sent++; return Response.json({ id: `mail-${sent}` }) }) as typeof fetch },
    }, onMemberRuntime: value => { runtime = value },
  })
  db.prepare('UPDATE members SET verified_at=? WHERE id=1').run(new Date(NOW).toISOString())
  onMemberVerified(db, 1, NOW)
  const invite = issueInvite(db, 1, 'invitee@example.com', undefined, NOW)
  db.prepare('INSERT INTO membership_devices(id,member_id,public_key_hash,public_key_jwk,label,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)')
    .run('device-1', 1, 'key-hash', '{}', 'Private browser', NOW, NOW)
  db.prepare('INSERT INTO membership_sessions(id,member_id,device_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run('session-1', 1, 'device-1', NOW, NOW + 100_000)
  db.prepare('INSERT INTO membership_request_nonces(session_id,nonce,expires_at) VALUES(?,?,?)').run('session-1', 'used-nonce', NOW + 100_000)
  db.prepare(`INSERT INTO membership_challenges(id,member_id,email,public_key_jwk,public_key_hash,nonce,code_hash,device_label,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run('challenge-1', 1, 'founder@example.com', '{}', 'hash', 'nonce', 'code-hash', 'Private browser', NOW, NOW + 100_000)
  db.prepare('INSERT INTO discord_oauth_flows(state_hash,member_id,session_hash,expires_at,status) VALUES(?,?,?,?,?)')
    .run('flow-1', 1, 'session-1', NOW + 100_000, 'started')
  enqueueMail(db, { to: 'founder@example.com', subject: 'Code', text: 'Private verification code', kind: 'membership_code', dedupeKey: 'queued-member-code', memberId: 1 }, NOW)
  enqueueMail(db, { to: 'founder@example.com', subject: 'Welcome', text: 'Private welcome', kind: 'welcome', dedupeKey: 'mail-without-member-id' }, NOW)
  db.prepare(`INSERT INTO member_research(id,member_id,input_json,content_hash,client_key,status,reason,created_at,updated_at)
    VALUES(?,?,?,?,?,'received',?,?,?)`).run('research-1', 1, '{"private":"founder@example.com"}', 'content-hash', 'request-key', 'queued', new Date(NOW).toISOString(), new Date(NOW).toISOString())
  db.prepare('INSERT INTO member_research_events(submission_id,event,detail_json,created_at) VALUES(?,?,?,?)')
    .run('research-1', 'received', '{"private":"founder@example.com"}', new Date(NOW).toISOString())
  return { db, app, runtime, invite, sent: () => sent }
}
function linkDiscord(db: Db) {
  db.prepare(`INSERT INTO discord_member_links(member_id,discord_user_id,discord_username,state,confirmation_expires_at,access_token_expires_at,verified_at,updated_at)
    VALUES(?,?,?,'verified',?,?,?,?)`).run(1, '111111111111111111', 'private-discord-name', NOW + 100_000, NOW + 100_000, NOW, NOW)
}

describe('member deletion lifecycle', () => {
  it('requires exact member confirmation and the admin endpoint cannot be used by guests', async () => {
    const f = fixture()
    expect(requestMemberDeletion(f.db, 1, 'WrongUserId', NOW)).toBe(false)
    expect(requestMemberDeletion(f.db, 999, 'Founder', NOW)).toBe(false)
    const body = JSON.stringify({ confirmUserId: 'Founder', confirmDelete: 'DELETE THIS MEMBER' })
    expect((await f.app.request('/api/admin/members/1/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(404)
    expect(f.db.prepare('SELECT disabled_at FROM members WHERE id=1').get()!.disabled_at).toBeNull()
    const response = await f.app.request('/api/admin/members/1/delete', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin' }, body })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'completed', accessRevoked: true })
  })

  it('purges private state atomically while retaining an anonymous consumed collectible serial', () => {
    const f = fixture()
    expect(requestMemberDeletion(f.db, 1, 'Founder', NOW)).toBe(true)
    const member = f.db.prepare('SELECT * FROM members WHERE id=1').get()!
    expect(member.user_id).toMatch(/^deleted-/)
    expect(member.email).toMatch(/@deleted\.invalid$/)
    expect(member.verified_at).toBeNull()
    expect(member.disabled_at).toBeTruthy()
    for (const table of ['waitlist', 'membership_sessions', 'membership_devices', 'membership_request_nonces', 'membership_challenges', 'member_email_outbox', 'discord_oauth_flows', 'member_research', 'member_research_events']) {
      expect(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0)
    }
    expect(f.db.prepare('SELECT member_id,serial FROM member_collectibles').get()).toMatchObject({ member_id: 1, serial: 1 })
    initializeMembershipSchema(f.db, NOW)
    expect(f.db.prepare('SELECT user_id FROM members WHERE id=1').get()!.user_id).not.toBe('Founder')
    const next = f.db.prepare('INSERT INTO members(user_id,email,created_at,verified_at) VALUES(?,?,?,?)').run('NextMember', 'next@example.com', new Date(NOW + 1).toISOString(), new Date(NOW + 1).toISOString())
    onMemberVerified(f.db, Number(next.lastInsertRowid), NOW + 1)
    expect(f.db.prepare('SELECT serial FROM member_collectibles WHERE member_id=?').get(Number(next.lastInsertRowid))!.serial).toBe(2)
    expect(finalizeMemberDeletions(f.db, NOW + 2)).toBe(0)
  })

  it('immediately cancels access, email, verification and research while Discord revocation is pending', async () => {
    const f = fixture(); linkDiscord(f.db)
    // Simulate a leased email: deleting an account must stop automatic delivery retries too.
    f.db.prepare("UPDATE member_email_outbox SET state='sending',lease_id='mail-lease',lease_until=? WHERE dedupe_key='queued-member-code'").run(NOW + 100_000)
    expect(requestMemberDeletion(f.db, 1, 'Founder', NOW)).toBe(true)
    expect(f.db.prepare('SELECT state FROM member_deletions WHERE member_id=1').get()!.state).toBe('requested')
    expect(f.db.prepare('SELECT state FROM discord_member_links WHERE member_id=1').get()!.state).toBe('revocation_pending')
    expect(f.db.prepare('SELECT email FROM members WHERE id=1').get()!.email).toBe('founder@example.com')
    expect(f.db.prepare('SELECT revoked_at FROM membership_sessions WHERE member_id=1').get()!.revoked_at).toBe(NOW)
    expect(f.db.prepare('SELECT revoked_at FROM membership_devices WHERE member_id=1').get()!.revoked_at).toBe(NOW)
    expect(f.db.prepare('SELECT * FROM membership_challenges').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT * FROM discord_oauth_flows').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT * FROM member_research').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT * FROM member_research_events').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT token_hash FROM member_invites WHERE member_id=1 AND slot=?').get(f.invite.slot)!.token_hash).toBeNull()
    expect(f.db.prepare("SELECT COUNT(*) n FROM member_email_outbox WHERE state!='cancelled' OR body!='' OR lease_id IS NOT NULL").get()!.n).toBe(0)
    await f.runtime.tick()
    expect(f.sent()).toBe(0)
    expect(finalizeMemberDeletions(f.db, NOW)).toBe(0)
    // Only the Discord reconciler's confirmed revoked state permits identity purge.
    f.db.prepare("UPDATE discord_member_links SET state='revoked' WHERE member_id=1").run()
    expect(finalizeMemberDeletions(f.db, NOW + 1)).toBe(1)
    expect(f.db.prepare('SELECT * FROM discord_member_links').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT * FROM member_email_outbox').all()).toHaveLength(0)
  })

  it('keeps access revoked and retries an atomic purge after a database failure', () => {
    const f = fixture()
    f.db.exec("CREATE TRIGGER block_purge BEFORE DELETE ON member_email_outbox BEGIN SELECT RAISE(ABORT, 'test purge failure'); END")
    expect(() => requestMemberDeletion(f.db, 1, 'Founder', NOW)).toThrow('test purge failure')
    expect(f.db.prepare('SELECT disabled_at FROM members WHERE id=1').get()!.disabled_at).toBeTruthy()
    expect(f.db.prepare('SELECT email FROM waitlist WHERE id=1').get()!.email).toBe('founder@example.com')
    expect(f.db.prepare('SELECT email FROM members WHERE id=1').get()!.email).toBe('founder@example.com')
    expect(f.db.prepare('SELECT state FROM member_deletions WHERE member_id=1').get()!.state).toBe('requested')
    expect(f.db.prepare('SELECT revoked_at FROM membership_sessions WHERE member_id=1').get()!.revoked_at).toBe(NOW)
    f.db.exec('DROP TRIGGER block_purge')
    expect(finalizeMemberDeletions(f.db, NOW + 1)).toBe(1)
    expect(f.db.prepare('SELECT state FROM member_deletions WHERE member_id=1').get()!.state).toBe('completed')
    expect(f.db.prepare('SELECT * FROM waitlist').all()).toHaveLength(0)
  })
})
