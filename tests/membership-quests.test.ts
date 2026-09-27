import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { openDb, type Db } from '../server/db.js'
import { initializeMembershipSchema } from '../server/membership-schema.js'
import { awardReview, canStartDiscordQuest, getMemberProfile, initMembershipQuests, issueInvite, mountMembershipQuestRoutes, onDiscordVerified, onMemberVerified, redeemInvite, reserveInvite, revokeInvite, selectCollectible, validateInvite, type ReviewInput } from '../server/membership-quests.js'

const NOW = Date.parse('2026-09-26T12:00:00.000Z')
let db: Db
let serial = 0
function addMember(verified = true): number {
  const n = ++serial
  return Number(db.prepare('INSERT INTO members(user_id,email,created_at,verified_at) VALUES(?,?,?,?)').run(`person${n}`, `person${n}@example.com`, new Date(NOW + n).toISOString(), verified ? new Date(NOW + n).toISOString() : null).lastInsertRowid)
}
function recruit(inviter: number) {
  const n = serial + 1
  const invite = issueInvite(db, inviter, `person${n}@example.com`, undefined, NOW)
  const invited = addMember()
  redeemInvite(db, invited, invite.token, NOW)
  onMemberVerified(db, invited, NOW)
  return invited
}
function researcher(): number {
  const id = addMember(); onMemberVerified(db, id, NOW); recruit(id)
  onDiscordVerified(db, id, String(100000000000000000n + BigInt(id)), NOW)
  return id
}
function review(memberId: number, n: number, points: 0 | 1 | 3 = 3): ReviewInput {
  return { memberId, submissionId: `submission-${n}`, reviewId: `review-${n}`, points, validationReceiptRef: `samv2-receipt-${n}`, evidenceRefs: [`filing-${n}`], reviewerId: 'independent-review', reason: 'Primary evidence checked; uncertainty disclosed.' }
}
const AUTHORITY = { id: 'independent-review', authorized: true }

beforeEach(() => { db = openDb(':memory:'); initializeMembershipSchema(db); initMembershipQuests(db); serial = 0 })
afterEach(() => db.close())

describe('invitations and referral accounting', () => {
  it('binds an opaque hashed one-use invitation to email and rejects expiry, replay and substitution', () => {
    const root = addMember(); onMemberVerified(db, root, NOW)
    const invite = issueInvite(db, root, 'Person2@example.com', undefined, NOW)
    const stored = db.prepare('SELECT token_hash FROM member_invites WHERE member_id=? AND slot=1').get(root) as { token_hash: string }
    expect(stored.token_hash).not.toBe(invite.token)
    expect(reserveInvite(db, invite.token, 'attacker@example.com', NOW)).toBe(false)
    expect(reserveInvite(db, invite.token, 'person2@example.com', NOW)).toBe(true)
    expect(() => issueInvite(db, root, 'replacement@example.com', 1, NOW)).toThrow('invite_reserved')
    const invited = addMember()
    db.exec('BEGIN IMMEDIATE')
    redeemInvite(db, invited, invite.token, NOW)
    onMemberVerified(db, invited, NOW)
    db.exec('COMMIT')
    expect(() => redeemInvite(db, invited, invite.token, NOW)).toThrow('invalid_invitation')
    const expired = issueInvite(db, root, 'later@example.com', undefined, NOW)
    expect(validateInvite(db, expired.token, 'later@example.com', NOW + 8 * 86_400_000)).toBe(false)
  })

  it('has exactly ten lifetime successful joins and cannot refund a consumed slot by deleting a member', () => {
    const root = addMember(); onMemberVerified(db, root, NOW)
    const recruits = Array.from({ length: 10 }, () => recruit(root))
    expect(getMemberProfile(db, root).referrals).toMatchObject({ directVerified: 10, remainingInvites: 0 })
    expect(() => issueInvite(db, root, 'eleventh@example.com', undefined, NOW)).toThrow('invite_slots_full')
    db.prepare('DELETE FROM members WHERE id=?').run(recruits[0]!)
    expect(getMemberProfile(db, root).referrals.remainingInvites).toBe(0)
    expect(() => revokeInvite(db, root, 1)).toThrow('invite_unavailable')
  })

  it('counts deep descendants without awarding any research points and advances quest/email once', () => {
    const root = addMember(); onMemberVerified(db, root, NOW)
    const child = recruit(root); recruit(child)
    onMemberVerified(db, child, NOW)
    const profile = getMemberProfile(db, root)
    expect(profile.referrals).toMatchObject({ directVerified: 1, networkReach: 2 })
    expect(profile.research).toMatchObject({ points: 0, rank: 0 })
    expect(canStartDiscordQuest(db, root)).toBe(true)
    expect((db.prepare("SELECT COUNT(*) n FROM member_email_outbox WHERE member_id=? AND kind='quest_progression'").get(root) as { n: number }).n).toBe(1)
    expect(JSON.stringify(profile)).not.toContain('@example.com')
  })

  it('rejects a cycle and rolls all redemption changes back', () => {
    const root = addMember(); onMemberVerified(db, root, NOW)
    const child = recruit(root)
    const invite = issueInvite(db, child, 'cycle@example.com', undefined, NOW)
    db.prepare('UPDATE members SET email=? WHERE id=?').run('cycle@example.com', root)
    expect(() => redeemInvite(db, root, invite.token, NOW)).toThrow('referral_cycle')
    expect(validateInvite(db, invite.token, 'cycle@example.com', NOW)).toBe(true)
  })
})

describe('scarce collectible allocation', () => {
  it('caps founder collectibles at 200, preserves serials and never recycles deleted allocations', () => {
    const members = Array.from({ length: 201 }, () => addMember())
    onMemberVerified(db, members[200]!, NOW)
    expect((db.prepare("SELECT COUNT(*) n FROM member_collectibles WHERE collection='moon'").get() as { n: number }).n).toBe(200)
    expect(getMemberProfile(db, members[0]!).collectibles[0]!.serial).toBe(1)
    expect(getMemberProfile(db, members[200]!).collectibles).toHaveLength(0)
    db.prepare('DELETE FROM members WHERE id=?').run(members[0]!)
    onMemberVerified(db, members[200]!, NOW)
    expect(getMemberProfile(db, members[200]!).collectibles).toHaveLength(0)
    expect(getMemberProfile(db, members[200]!).catalog[0]!.remaining).toBe(0)
  })

  it('reserves 100 total Discord choices and makes a chosen design immutable', () => {
    const members = Array.from({ length: 101 }, () => researcher())
    expect(getMemberProfile(db, members[100]!).collectibles.find(c => c.collection === 'discord-pioneer')).toBeUndefined()
    expect(getMemberProfile(db, members[0]!).catalog[1]).toMatchObject({ cap: 100, issued: 100, remaining: 0 })
    selectCollectible(db, members[0]!, 'stargazer')
    selectCollectible(db, members[0]!, 'stargazer')
    expect(() => selectCollectible(db, members[0]!, 'wolf')).toThrow('collectible_choice_final')
    expect(() => selectCollectible(db, members[100]!, 'techhead')).toThrow('collectible_not_allocated')
    onDiscordVerified(db, members[0]!, String(100000000000000000n + BigInt(members[0]!)), NOW)
    expect(getMemberProfile(db, members[0]!).catalog[1]!.issued).toBe(100)
  })
})

describe('evidence-backed research ledger', () => {
  it('rejects unauthorized awards, unsupported positive awards, arbitrary points and locked quests', () => {
    const id = researcher()
    expect(() => awardReview(db, review(id, 1), { ...AUTHORITY, authorized: false }, NOW)).toThrow('reviewer_unauthorized')
    expect(() => awardReview(db, { ...review(id, 1), evidenceRefs: [] }, AUTHORITY, NOW)).toThrow('invalid_review')
    expect(() => awardReview(db, { ...review(id, 1), points: 2 as 3 }, AUTHORITY, NOW)).toThrow('invalid_review')
    const locked = addMember()
    expect(() => awardReview(db, review(locked, 1), AUTHORITY, NOW)).toThrow('research_quest_locked')
  })

  it('is idempotent and applies upgrades/downgrades as visible append-only adjustments', () => {
    const id = researcher()
    const first = review(id, 1, 1)
    expect(awardReview(db, first, AUTHORITY, NOW)).toMatchObject({ points: 1, delta: 1 })
    expect(awardReview(db, first, AUTHORITY, NOW)).toMatchObject({ points: 1, delta: 0, idempotent: true })
    expect(() => awardReview(db, { ...first, points: 3 }, AUTHORITY, NOW)).toThrow('review_id_conflict')
    const upgraded = { ...first, reviewId: 'upgrade', points: 3 as const, supersedesReviewId: first.reviewId }
    expect(awardReview(db, upgraded, AUTHORITY, NOW)).toMatchObject({ points: 3, delta: 2 })
    expect(awardReview(db, { ...upgraded, reviewId: 'correction', points: 0, supersedesReviewId: 'upgrade' }, AUTHORITY, NOW)).toMatchObject({ points: 0, delta: -3 })
    expect((db.prepare('SELECT COUNT(*) n FROM member_points_ledger WHERE member_id=?').get(id) as { n: number }).n).toBe(3)
  })

  it('awards titles only from approved research and supports rank changes, corrections and real countdowns', () => {
    const id = researcher()
    for (let i = 0; i < 5; i++) awardReview(db, { ...review(id, i), quality: { independentPrimarySources: 2, substantiatedRebuttal: true, eventAt: new Date(NOW).toISOString(), submittedAt: new Date(NOW + 1_000).toISOString(), characters: 700 } }, AUTHORITY, NOW)
    const profile = getMemberProfile(db, id, { now: NOW, questDeadline: new Date(NOW + 10_000).toISOString() })
    expect(profile.research).toMatchObject({ points: 15, rank: 1 })
    expect(profile.titles.every(t => t.earned)).toBe(true)
    expect(profile.titles.every(t => t.remaining === null)).toBe(true)
    expect(profile.countdown.status).toBe('scheduled')
    expect(getMemberProfile(db, id).countdown).toEqual({ status: 'not_scheduled', deadline: null })
    expect(getMemberProfile(db, id, { questDeadline: 'fictional' }).countdown.deadline).toBeNull()
    for (let i = 0; i < 3; i++) awardReview(db, { ...review(id, i, 0), reviewId: `correction-${i}`, supersedesReviewId: `review-${i}` }, AUTHORITY, NOW)
    expect(getMemberProfile(db, id).titles.find(t => t.id === 'signal-scout')!.earned).toBe(false)
  })

  it('completes 500 points and only sends the quest completion email once', () => {
    const id = researcher()
    for (let i = 0; i < 166; i++) awardReview(db, review(id, i), AUTHORITY, NOW)
    awardReview(db, review(id, 166, 1), AUTHORITY, NOW)
    expect(getMemberProfile(db, id).quests[2]!.status).toBe('active')
    awardReview(db, review(id, 167, 1), AUTHORITY, NOW)
    awardReview(db, review(id, 168, 3), AUTHORITY, NOW)
    expect(getMemberProfile(db, id).research).toMatchObject({ points: 503, rank: 50 })
    expect(getMemberProfile(db, id).quests[2]!.status).toBe('complete')
    expect((db.prepare("SELECT COUNT(*) n FROM member_email_outbox WHERE dedupe_key=?").get(`${id}:research_complete:v1`) as { n: number }).n).toBe(1)
  })

  it('protects member routes and exposes only public directory fields', async () => {
    const id = researcher(); const app = new Hono()
    mountMembershipQuestRoutes(app, { db, now: () => NOW, requireMember: async (c, next) => { if (c.req.header('x-test-member') !== String(id)) return c.json({ error: 'unauthorized' }, 401); c.set('member', { id }); await next() } })
    expect((await app.request('/api/member/profile')).status).toBe(401)
    const response = await app.request('/api/member/directory', { headers: { 'x-test-member': String(id) } })
    const body = await response.json() as { members: Record<string, unknown>[] }
    expect(response.status).toBe(200)
    expect(Object.keys(body.members[0]).sort()).toEqual(['rank', 'title', 'userId'])
    expect(JSON.stringify(body)).not.toContain('@example.com')
  })
})
