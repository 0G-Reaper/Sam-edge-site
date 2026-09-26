import { createHash, randomBytes } from 'node:crypto'
import type { Hono, MiddlewareHandler } from 'hono'
import type { Db } from './db.js'
import { enqueueMail } from './mail.js'

const INVITE_LIMIT = 10
const DAY = 86_400_000
const CHOICES = ['stargazer', 'techhead', 'wolf'] as const
type Choice = typeof CHOICES[number]
type Member = { id: number; user_id: string; email: string; verified_at: string | null; disabled_at: string | null; created_at: string; inviter_id: number | null }
type Invite = { member_id: number; slot: number; token_hash: string | null; recipient_email: string | null; expires_at: number | null; reserved_until: number | null; consumed_at: number | null; redeemed_member_id: number | null }
type Allocation = { collection: string; serial: number; member_id: number; choice: Choice | null; allocated_at: number }

export class QuestError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}

/** SAVEPOINT remains atomic when called inside the authentication transaction. */
function atomic<T>(db: Db, work: () => T): T {
  const name = `q_${randomBytes(8).toString('hex')}`
  db.exec(`SAVEPOINT ${name}`)
  try { const result = work(); db.exec(`RELEASE ${name}`); return result }
  catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error }
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const normalizeEmail = (s: string) => s.trim().toLowerCase()

export function initMembershipQuests(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_invites (
      member_id INTEGER NOT NULL, slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10),
      token_hash TEXT UNIQUE, recipient_email TEXT, expires_at INTEGER, reserved_until INTEGER,
      consumed_at INTEGER, redeemed_member_id INTEGER UNIQUE,
      PRIMARY KEY(member_id,slot)
    );
    CREATE TABLE IF NOT EXISTS member_referrals (
      invited_member_id INTEGER PRIMARY KEY, inviter_member_id INTEGER NOT NULL,
      verified_at INTEGER NOT NULL, CHECK(invited_member_id <> inviter_member_id)
    );
    CREATE INDEX IF NOT EXISTS member_referrals_parent ON member_referrals(inviter_member_id);
    CREATE TABLE IF NOT EXISTS member_collectibles (
      collection TEXT NOT NULL CHECK(collection IN ('moon','discord-pioneer')),
      serial INTEGER NOT NULL, member_id INTEGER NOT NULL, choice TEXT,
      allocated_at INTEGER NOT NULL,
      PRIMARY KEY(collection,serial), UNIQUE(collection,member_id),
      CHECK((collection='moon' AND serial BETWEEN 1 AND 200 AND choice IS NULL)
        OR (collection='discord-pioneer' AND serial BETWEEN 1 AND 100 AND (choice IS NULL OR choice IN ('stargazer','techhead','wolf'))))
    );
    CREATE TABLE IF NOT EXISTS member_discord_quests (
      member_id INTEGER PRIMARY KEY, discord_id TEXT NOT NULL UNIQUE, verified_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_reviews (
      review_id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, member_id INTEGER NOT NULL,
      points INTEGER NOT NULL CHECK(points IN (0,1,3)), validation_receipt_ref TEXT NOT NULL,
      reviewer_id TEXT NOT NULL, reason TEXT NOT NULL, evidence_json TEXT NOT NULL, quality_json TEXT NOT NULL,
      supersedes_review_id TEXT UNIQUE, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS member_reviews_submission ON member_reviews(submission_id,created_at);
    CREATE TABLE IF NOT EXISTS member_points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, review_id TEXT NOT NULL UNIQUE,
      delta INTEGER NOT NULL CHECK(delta BETWEEN -3 AND 3), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS member_quest_events (
      event_key TEXT PRIMARY KEY, member_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, dispatched_at INTEGER
    );
  `)
}

function member(db: Db, id: number): Member {
  const row = db.prepare('SELECT * FROM members WHERE id=?').get(id) as Member | undefined
  if (!row || !row.verified_at || row.disabled_at) throw new QuestError('member_unavailable', 403)
  return row
}

function slots(db: Db, memberId: number): void {
  const insert = db.prepare('INSERT OR IGNORE INTO member_invites(member_id,slot) VALUES(?,?)')
  for (let slot = 1; slot <= INVITE_LIMIT; slot++) insert.run(memberId, slot)
}

function event(db: Db, memberId: number, eventType: string, now: number, payload: object = {}): void {
  const key = `${memberId}:${eventType}:v1`
  const inserted = db.prepare('INSERT OR IGNORE INTO member_quest_events(event_key,member_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?)').run(key, memberId, eventType, JSON.stringify(payload), now)
  if (!inserted.changes) return
  const m = member(db, memberId)
  const templates: Record<string, { subject: string; text: string }> = {
    first_referral_complete: { subject: 'Your next SAM quest: enter the observatory', text: `Your first verified invitation is complete, ${m.user_id}. Your next quest is to connect Discord from your SAM member profile and confirm the verification email. Never share a login or email verification link. The first 100 completed Discord verifications qualify to choose one collectible badge from the pioneer collection.` },
    discord_complete: { subject: 'Are you prepared for what comes next?', text: `Discord verification is complete, ${m.user_id}. Your next quest is to earn 500 research points. Submit research through the designated research inbox: unsupported or duplicate submissions receive 0, useful supported contributions can receive 1, and independently reviewed high-quality research can receive 3. Every 10 points advances your research rank. Your profile shows progress, review reasons, and available achievements.` },
    research_complete: { subject: 'SAM research quest complete — 500 points', text: `You have completed the 500-point research quest, ${m.user_id}. Your profile records the achievement and the evidence-backed contributions behind it. Further quests will appear only when their rules and availability are announced.` },
  }
  const template = templates[eventType]
  if (template) enqueueMail(db, { to: m.email, ...template, kind: 'quest_progression', dedupeKey: key, memberId }, now)
}

function allocate(db: Db, collection: 'moon' | 'discord-pioneer', memberId: number, now: number): void {
  if (db.prepare('SELECT 1 FROM member_collectibles WHERE collection=? AND member_id=?').get(collection, memberId)) return
  const count = Number((db.prepare('SELECT COUNT(*) n FROM member_collectibles WHERE collection=?').get(collection) as { n: number }).n)
  const cap = collection === 'moon' ? 200 : 100
  if (count < cap) db.prepare('INSERT INTO member_collectibles(collection,serial,member_id,allocated_at) VALUES(?,?,?,?)').run(collection, count + 1, memberId, now)
}

export function onMemberVerified(db: Db, memberId: number, now = Date.now()): void {
  atomic(db, () => {
    member(db, memberId)
    slots(db, memberId)
    // Existing verified members receive priority by their recorded verification order.
    const issued = Number((db.prepare("SELECT COUNT(*) n FROM member_collectibles WHERE collection='moon'").get() as { n: number }).n)
    if (issued < 200) {
      const verified = db.prepare("SELECT m.id,m.verified_at FROM members m WHERE m.verified_at IS NOT NULL AND m.disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM member_collectibles c WHERE c.collection='moon' AND c.member_id=m.id) ORDER BY m.verified_at,m.id LIMIT ?").all(200 - issued) as { id: number; verified_at: string }[]
      for (const m of verified) allocate(db, 'moon', m.id, Date.parse(m.verified_at) || now)
    }
    const edge = db.prepare('SELECT inviter_member_id FROM member_referrals WHERE invited_member_id=?').get(memberId) as { inviter_member_id: number } | undefined
    if (edge) {
      const inviter = db.prepare('SELECT verified_at,disabled_at FROM members WHERE id=?').get(edge.inviter_member_id) as { verified_at: string | null; disabled_at: string | null } | undefined
      if (inviter?.verified_at && !inviter.disabled_at) event(db, edge.inviter_member_id, 'first_referral_complete', now)
    }
  })
}

export function issueInvite(db: Db, memberId: number, email: string, requestedSlot?: number, now = Date.now()) {
  const recipient = normalizeEmail(email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.length > 254) throw new QuestError('invalid_recipient_email')
  return atomic(db, () => {
    const m = member(db, memberId)
    if (normalizeEmail(m.email) === recipient) throw new QuestError('self_invitation')
    // Do not reveal whether an arbitrary email belongs to an existing member.
    // Authentication prevents an existing account redeeming this as a new membership.
    slots(db, memberId)
    if (requestedSlot !== undefined && (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > 10)) throw new QuestError('invalid_slot')
    const row = requestedSlot === undefined
      ? db.prepare('SELECT * FROM member_invites WHERE member_id=? AND consumed_at IS NULL AND (token_hash IS NULL OR expires_at<=?) ORDER BY slot LIMIT 1').get(memberId, now) as Invite | undefined
      : db.prepare('SELECT * FROM member_invites WHERE member_id=? AND slot=?').get(memberId, requestedSlot) as Invite | undefined
    if (!row || row.consumed_at !== null) throw new QuestError('invite_slots_full', 409)
    if (row.reserved_until && row.reserved_until > now) throw new QuestError('invite_reserved', 409)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + 7 * DAY
    db.prepare('UPDATE member_invites SET token_hash=?,recipient_email=?,expires_at=?,reserved_until=NULL WHERE member_id=? AND slot=? AND consumed_at IS NULL').run(hash(token), recipient, expiresAt, memberId, row.slot)
    return { slot: row.slot, token, expiresAt: new Date(expiresAt).toISOString() }
  })
}

export function validateInvite(db: Db, token: string, email?: string, now = Date.now()): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false
  const row = db.prepare('SELECT i.* FROM member_invites i JOIN members m ON m.id=i.member_id WHERE token_hash=? AND consumed_at IS NULL AND expires_at>? AND m.verified_at IS NOT NULL AND m.disabled_at IS NULL').get(hash(token), now) as Invite | undefined
  return !!row && (email === undefined || row.recipient_email === normalizeEmail(email))
}

export function reserveInvite(db: Db, token: string, email: string, now = Date.now()): boolean {
  return atomic(db, () => {
    if (!validateInvite(db, token, email, now)) return false
    db.prepare('UPDATE member_invites SET reserved_until=? WHERE token_hash=? AND consumed_at IS NULL').run(now + 20 * 60_000, hash(token))
    return true
  })
}

export function redeemInvite(db: Db, memberId: number, token: string, now = Date.now()): void {
  atomic(db, () => {
    const m = db.prepare('SELECT * FROM members WHERE id=?').get(memberId) as Member | undefined
    if (!m || !validateInvite(db, token, m.email, now)) throw new QuestError('invalid_invitation', 403)
    const row = db.prepare('SELECT * FROM member_invites WHERE token_hash=?').get(hash(token)) as Invite
    if (row.member_id === memberId || m.inviter_id !== null || db.prepare('SELECT 1 FROM member_referrals WHERE invited_member_id=?').get(memberId)) throw new QuestError('invalid_referral', 409)
    const cycle = db.prepare('WITH RECURSIVE descendants(id) AS (SELECT invited_member_id FROM member_referrals WHERE inviter_member_id=? UNION SELECT r.invited_member_id FROM member_referrals r JOIN descendants d ON r.inviter_member_id=d.id) SELECT 1 FROM descendants WHERE id=?').get(memberId, row.member_id)
    if (cycle) throw new QuestError('referral_cycle', 409)
    const changed = db.prepare('UPDATE member_invites SET consumed_at=?,redeemed_member_id=?,reserved_until=NULL WHERE member_id=? AND slot=? AND consumed_at IS NULL AND expires_at>?').run(now, memberId, row.member_id, row.slot, now)
    if (!changed.changes) throw new QuestError('invalid_invitation', 403)
    db.prepare('INSERT INTO member_referrals(invited_member_id,inviter_member_id,verified_at) VALUES(?,?,?)').run(memberId, row.member_id, now)
    db.prepare('UPDATE members SET inviter_id=? WHERE id=?').run(row.member_id, memberId)
  })
}

export function revokeInvite(db: Db, memberId: number, slot: number): void {
  atomic(db, () => {
    member(db, memberId)
    const row = db.prepare('SELECT * FROM member_invites WHERE member_id=? AND slot=?').get(memberId, slot) as Invite | undefined
    if (!row || row.consumed_at !== null) throw new QuestError('invite_unavailable', 409)
    db.prepare('UPDATE member_invites SET token_hash=NULL,recipient_email=NULL,expires_at=NULL,reserved_until=NULL WHERE member_id=? AND slot=?').run(memberId, slot)
  })
}

function referralStats(db: Db, memberId: number) {
  const directVerified = Number((db.prepare('SELECT COUNT(*) n FROM member_referrals r JOIN members m ON m.id=r.invited_member_id WHERE r.inviter_member_id=? AND m.verified_at IS NOT NULL AND m.disabled_at IS NULL').get(memberId) as { n: number }).n)
  const networkReach = Number((db.prepare('WITH RECURSIVE descendants(id) AS (SELECT invited_member_id FROM member_referrals WHERE inviter_member_id=? UNION SELECT r.invited_member_id FROM member_referrals r JOIN descendants d ON r.inviter_member_id=d.id) SELECT COUNT(*) n FROM descendants d JOIN members m ON m.id=d.id WHERE m.verified_at IS NOT NULL AND m.disabled_at IS NULL').get(memberId) as { n: number }).n)
  const consumed = Number((db.prepare('SELECT COUNT(*) n FROM member_invites WHERE member_id=? AND consumed_at IS NOT NULL').get(memberId) as { n: number }).n)
  const communityTitles=['New Explorer','Pathfinder','Trail Guide','Connector','Circle Keeper','Community Guide','Orbit Builder','Bridge Maker','Constellation Scout','Community Architect','Constellation Builder']
  return { directVerified, networkReach, rank: networkReach, remainingInvites: INVITE_LIMIT - consumed, limit: INVITE_LIMIT, title: communityTitles[Math.min(10,directVerified)]! }
}

export function canStartDiscordQuest(db: Db, memberId: number): boolean {
  try { member(db, memberId); return referralStats(db, memberId).directVerified >= 1 || !!db.prepare("SELECT 1 FROM member_quest_events WHERE member_id=? AND event_type='first_referral_complete'").get(memberId) } catch { return false }
}

export function onDiscordVerified(db: Db, memberId: number, discordId: string, now = Date.now()): void {
  atomic(db, () => {
    member(db, memberId)
    if (!canStartDiscordQuest(db, memberId)) throw new QuestError('first_quest_incomplete', 409)
    if (!/^\d{17,22}$/.test(discordId)) throw new QuestError('invalid_discord_identity')
    const existing = db.prepare('SELECT discord_id FROM member_discord_quests WHERE member_id=?').get(memberId) as { discord_id: string } | undefined
    if (existing && existing.discord_id !== discordId) throw new QuestError('discord_already_linked', 409)
    db.prepare('INSERT OR IGNORE INTO member_discord_quests(member_id,discord_id,verified_at) VALUES(?,?,?)').run(memberId, discordId, now)
    // A duplicate Discord identity must never silently award a different member.
    const linked = db.prepare('SELECT discord_id FROM member_discord_quests WHERE member_id=?').get(memberId) as { discord_id: string } | undefined
    if (!linked || linked.discord_id !== discordId) throw new QuestError('discord_already_linked', 409)
    allocate(db, 'discord-pioneer', memberId, now)
    event(db, memberId, 'discord_complete', now)
  })
}

export function selectCollectible(db: Db, memberId: number, choice: string): void {
  if (!(CHOICES as readonly string[]).includes(choice)) throw new QuestError('invalid_collectible_choice')
  atomic(db, () => {
    member(db, memberId)
    const row = db.prepare("SELECT choice FROM member_collectibles WHERE collection='discord-pioneer' AND member_id=?").get(memberId) as { choice: string | null } | undefined
    if (!row) throw new QuestError('collectible_not_allocated', 409)
    if (row.choice && row.choice !== choice) throw new QuestError('collectible_choice_final', 409)
    db.prepare("UPDATE member_collectibles SET choice=? WHERE collection='discord-pioneer' AND member_id=? AND choice IS NULL").run(choice, memberId)
  })
}

export interface ReviewInput {
  submissionId: string; memberId: number; points: 0 | 1 | 3; reviewId: string; validationReceiptRef: string
  evidenceRefs: string[]; reviewerId: string; reason: string; supersedesReviewId?: string
  quality?: { independentPrimarySources?: number; substantiatedRebuttal?: boolean; eventAt?: string; submittedAt?: string; characters?: number }
}
export interface ReviewerAuthority { id: string; authorized: boolean }

/** Only call after the service callback and its validation receipt have been authenticated. */
export function awardReview(db: Db, input: ReviewInput, authority: ReviewerAuthority, now = Date.now()) {
  if (authority?.authorized !== true || authority.id !== input.reviewerId) throw new QuestError('reviewer_unauthorized', 403)
  if (![0, 1, 3].includes(input.points) || !input.submissionId || !input.reviewId || !input.validationReceiptRef || !input.reason || !input.reviewerId || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.some(s => typeof s !== 'string' || !s.trim()) || (input.points > 0 && input.evidenceRefs.length === 0)) throw new QuestError('invalid_review')
  const payloadHash = hash(JSON.stringify({ ...input, quality: input.quality ?? {} }))
  return atomic(db, () => {
    member(db, input.memberId)
    if (!db.prepare('SELECT 1 FROM member_discord_quests WHERE member_id=?').get(input.memberId)) throw new QuestError('research_quest_locked', 409)
    const duplicate = db.prepare('SELECT payload_hash FROM member_reviews WHERE review_id=?').get(input.reviewId) as { payload_hash: string } | undefined
    if (duplicate) {
      if (duplicate.payload_hash !== payloadHash) throw new QuestError('review_id_conflict', 409)
      return { ...researchStats(db, input.memberId), delta: 0, idempotent: true }
    }
    const previous = db.prepare('SELECT r.review_id,r.points,r.member_id FROM member_reviews r WHERE r.submission_id=? AND NOT EXISTS(SELECT 1 FROM member_reviews newer WHERE newer.supersedes_review_id=r.review_id)').all(input.submissionId) as { review_id: string; points: number; member_id: number }[]
    if (previous.length > 1 || (previous.length === 1 && (!input.supersedesReviewId || previous[0]!.review_id !== input.supersedesReviewId || previous[0]!.member_id !== input.memberId)) || (previous.length === 0 && input.supersedesReviewId)) throw new QuestError('review_supersession_conflict', 409)
    const delta = input.points - (previous[0]?.points ?? 0)
    db.prepare('INSERT INTO member_reviews(review_id,submission_id,member_id,points,validation_receipt_ref,reviewer_id,reason,evidence_json,quality_json,supersedes_review_id,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(input.reviewId, input.submissionId, input.memberId, input.points, input.validationReceiptRef, input.reviewerId, input.reason, JSON.stringify(input.evidenceRefs), JSON.stringify(input.quality ?? {}), input.supersedesReviewId ?? null, payloadHash, now)
    db.prepare('INSERT INTO member_points_ledger(member_id,review_id,delta,created_at) VALUES(?,?,?,?)').run(input.memberId, input.reviewId, delta, now)
    const stats = researchStats(db, input.memberId)
    if (stats.points >= 500) event(db, input.memberId, 'research_complete', now)
    return { ...stats, delta, idempotent: false }
  })
}

function researchStats(db: Db, memberId: number) {
  const points = Number((db.prepare('SELECT COALESCE(SUM(delta),0) points FROM member_points_ledger WHERE member_id=?').get(memberId) as { points: number }).points)
  const rank = Math.floor(Math.max(0, points) / 10)
  const tiers = ['Observer', 'Scout', 'Sourcekeeper', 'Investigator', 'Cartographer', 'Pattern Seeker', 'Evidence Curator', 'Research Navigator', 'Signal Architect', 'Research Fellow']
  const title = rank === 0 ? 'New Researcher' : rank >= 50 ? 'Observatory Fellow' : `${tiers[Math.floor((rank - 1) / 5)]} ${['I', 'II', 'III', 'IV', 'V'][(rank - 1) % 5]}`
  return { points, rank, title, goal: 500 }
}

function titles(db: Db, memberId: number) {
  const reviews = db.prepare('SELECT r.quality_json FROM member_reviews r WHERE r.member_id=? AND r.points=3 AND NOT EXISTS(SELECT 1 FROM member_reviews n WHERE n.supersedes_review_id=r.review_id)').all(memberId) as { quality_json: string }[]
  const quality = reviews.map(r => JSON.parse(r.quality_json) as NonNullable<ReviewInput['quality']>)
  const definitions = [
    { id: 'signal-scout', title: 'Signal Scout', target: 3, progress: reviews.length },
    { id: 'source-sleuth', title: 'Source Sleuth', target: 5, progress: quality.filter(q => (q.independentPrimarySources ?? 0) >= 2).length },
    { id: 'counterweight', title: 'Counterweight', target: 3, progress: quality.filter(q => q.substantiatedRebuttal === true).length },
    { id: 'first-response', title: 'First Response', target: 3, progress: quality.filter(q => { const d = Date.parse(q.submittedAt ?? '') - Date.parse(q.eventAt ?? ''); return Number.isFinite(d) && d >= 0 && d <= 30 * 60_000 }).length },
    { id: 'clear-thinker', title: 'Clear Thinker', target: 5, progress: quality.filter(q => Number.isInteger(q.characters) && q.characters! > 0 && q.characters! < 1_200).length },
  ]
  return definitions.map(d => ({ ...d, earned: d.progress >= d.target, remaining: null }))
}

export interface ProfileOptions { questDeadline?: string; readiness?: { email: boolean; discord: boolean; research: boolean }; now?: number }
export function getMemberProfile(db: Db, memberId: number, opts: ProfileOptions = {}) {
  const m = member(db, memberId)
  const referrals = referralStats(db, memberId)
  const research = researchStats(db, memberId)
  const firstComplete = canStartDiscordQuest(db, memberId)
  const discordComplete = !!db.prepare('SELECT 1 FROM member_discord_quests WHERE member_id=?').get(memberId)
  const allocations = db.prepare('SELECT * FROM member_collectibles WHERE member_id=? ORDER BY collection').all(memberId) as Allocation[]
  const catalog = [{ id: 'moon', title: 'First Man on the Moon', cap: 200 }, { id: 'discord-pioneer', title: 'Discord Pioneer Collection', cap: 100 }].map(c => {
    const issued = Number((db.prepare('SELECT COUNT(*) n FROM member_collectibles WHERE collection=?').get(c.id) as { n: number }).n)
    return { ...c, issued, remaining: c.cap - issued, kind: 'digital_collectible' }
  })
  const deadline = opts.questDeadline && /^\d{4}-\d{2}-\d{2}T/.test(opts.questDeadline) && Number.isFinite(Date.parse(opts.questDeadline)) ? new Date(opts.questDeadline).toISOString() : null
  return {
    userId: m.user_id, joinedAt: m.created_at, referrals, research,
    quests: [
      { id: 'trusted-invitation', title: 'Invite someone you trust', status: firstComplete ? 'complete' : 'active', progress: firstComplete ? 1 : Math.min(referrals.directVerified, 1), target: 1 },
      { id: 'discord-verification', title: 'Enter the observatory', status: discordComplete ? 'complete' : firstComplete ? 'active' : 'locked', progress: discordComplete ? 1 : 0, target: 1 },
      { id: 'research-500', title: 'Build an evidence record', status: research.points >= 500 ? 'complete' : discordComplete ? 'active' : 'locked', progress: research.points, target: 500 },
    ],
    collectibles: allocations.map(a => ({ collection: a.collection, title: a.collection === 'moon' ? 'First Man on the Moon' : 'Discord Pioneer', serial: a.serial, cap: a.collection === 'moon' ? 200 : 100, choice: a.choice, choices: a.collection === 'moon' ? [] : [...CHOICES], selectable: a.collection === 'discord-pioneer' && a.choice === null, kind: 'digital_collectible' })),
    titles: titles(db, memberId), catalog,
    countdown: { status: deadline ? Date.parse(deadline) > (opts.now ?? Date.now()) ? 'scheduled' : 'ended' : 'not_scheduled', deadline },
    readiness: opts.readiness ?? { email: false, discord: false, research: false },
  }
}

export interface QuestRouteOptions extends Omit<ProfileOptions, 'now'> { db: Db; requireMember: MiddlewareHandler; now?: () => number }
export function mountMembershipQuestRoutes(app: Hono, opts: QuestRouteOptions): void {
  const clock = opts.now ?? Date.now
  const current = (c: Parameters<MiddlewareHandler>[0]) => (c.get('member') as { id: number }).id
  app.get('/api/member/profile', opts.requireMember, c => c.json({ ok: true, profile: getMemberProfile(opts.db, current(c), { ...opts, now: clock() }) }))
  app.get('/api/member/directory', opts.requireMember, c => {
    const offset = Math.max(0, Math.min(100_000, Number.parseInt(c.req.query('offset') ?? '0') || 0))
    const rows = opts.db.prepare('SELECT id,user_id FROM members WHERE verified_at IS NOT NULL AND disabled_at IS NULL ORDER BY user_id COLLATE NOCASE LIMIT 51 OFFSET ?').all(offset) as { id: number; user_id: string }[]
    return c.json({ ok: true, members: rows.slice(0, 50).map(m => { const r = researchStats(opts.db, m.id); return { userId: m.user_id, rank: r.rank, title: r.title } }), nextOffset: rows.length > 50 ? offset + 50 : null })
  })
  app.get('/api/member/invites', opts.requireMember, c => {
    const memberId = current(c); member(opts.db, memberId); slots(opts.db, memberId)
    const rows = opts.db.prepare('SELECT * FROM member_invites WHERE member_id=? ORDER BY slot').all(memberId) as Invite[]
    return c.json({ ok: true, invites: rows.map(i => ({ slot: i.slot, status: i.consumed_at !== null ? 'consumed' : !i.token_hash || (i.expires_at ?? 0) <= clock() ? 'available' : (i.reserved_until ?? 0) > clock() ? 'reserved' : 'issued', expiresAt: i.expires_at ? new Date(i.expires_at).toISOString() : null, recipientEmail: i.recipient_email })) })
  })
  app.post('/api/member/invites', opts.requireMember, async c => {
    try {
      const b = await c.req.json<{ email?: unknown; slot?: unknown }>()
      if (typeof b.email !== 'string' || (b.slot !== undefined && typeof b.slot !== 'number')) throw new QuestError('invalid_invite')
      return c.json({ ok: true, invite: issueInvite(opts.db, current(c), b.email, b.slot, clock()) }, 201)
    } catch (e) { return routeError(c, e) }
  })
  app.post('/api/member/invites/:slot/revoke', opts.requireMember, c => { try { revokeInvite(opts.db, current(c), Number(c.req.param('slot'))); return c.json({ ok: true }) } catch (e) { return routeError(c, e) } })
  app.post('/api/member/collectibles/discord-pioneer', opts.requireMember, async c => { try { const b = await c.req.json<{ choice?: unknown }>(); if (typeof b.choice !== 'string') throw new QuestError('invalid_choice'); selectCollectible(opts.db, current(c), b.choice); return c.json({ ok: true }) } catch (e) { return routeError(c, e) } })
}

function routeError(c: Parameters<MiddlewareHandler>[0], error: unknown) {
  if (error instanceof QuestError) return c.json({ ok: false, error: error.code }, error.status as 400 | 403 | 409)
  if (error instanceof SyntaxError) return c.json({ ok: false, error: 'invalid_json' }, 400)
  throw error
}
