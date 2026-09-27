import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteMemberResearch, isPublicHttpsHint, mountMemberResearch, researchSignature, type MemberResearchOptions } from '../server/member-research.js'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function setup(overrides: Partial<MemberResearchOptions> = {}) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec('CREATE TABLE test_awards(review_id TEXT PRIMARY KEY, member_id INTEGER,points INTEGER)')
  let clock = Date.parse('2026-09-26T04:00:00Z')
  const options: MemberResearchOptions = {
    db, now: () => clock, sharedKey: 's'.repeat(48), reviewSharedKey: 'r'.repeat(48),
    allowedProviders: ['sec-edgar'], allowedReviewModels: ['independent-test-v1'],
    canSubmitResearch: () => true,
    auth: async (c, next) => {
      const id = c.req.header('x-test-member')
      if (!id) return c.json({ error: 'unauthorized' }, 401)
      c.set('member', { id: Number(id) }); await next()
    },
    awardReview: (input, authority) => {
      expect(authority.id).toBe(input.reviewerId)
      expect(authority.authorized).toBe(true)
      db.prepare('INSERT INTO test_awards VALUES(?,?,?)').run(input.reviewId, input.memberId, input.points)
    }, ...overrides,
  }
  const app = new Hono(); mountMemberResearch(app, options)
  const member = async (path: string, body?: unknown, id = 1, key?: string) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-test-member': String(id), 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const worker = async (path: string, body: unknown, role: 'sam' | 'review' = 'sam', nonce = randomUUID()) => {
    const raw = JSON.stringify(body), timestamp = String(clock), secret = role === 'sam' ? options.sharedKey! : options.reviewSharedKey!
    return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sam-timestamp': timestamp, 'x-sam-nonce': nonce, 'x-sam-signature': researchSignature(secret, timestamp, nonce, 'POST', path, raw) }, body: raw })
  }
  return { db, app, options, member, worker, time: () => clock, advance: (ms: number) => { clock += ms } }
}
const input = {
  entity: 'EXAMPLE', claim: 'The filing reports revenue growth in the most recent quarter.',
  sources: ['https://www.sec.gov/Archives/example-filing.html'],
  reasoning: 'The cited revenue line is compared with the equivalent prior-year quarter.',
  counterargument: 'A single quarter does not establish durable growth.',
  invalidation: 'An amended filing changing the comparable revenue figure would change this claim.',
}
async function intakeAndClaim(ctx: ReturnType<typeof setup>, memberId = 1, data = input) {
  const intake = await ctx.member('/api/member/research', data, memberId)
  expect(intake.status).toBe(200)
  const response = await ctx.worker('/api/internal/research/claim', { limit: 1 })
  expect(response.status).toBe(200)
  const { items } = await response.json() as any
  return items[0]
}
function evidence(ctx: ReturnType<typeof setup>, task: any, outcome = 'eligible') {
  return {
    receiptId: randomUUID(), submissionId: task.id, leaseToken: task.leaseToken, processorVersion: 'samv2-test-v1', inputDigest: task.inputDigest,
    asOf: task.asOf, completedAt: new Date(ctx.time()).toISOString(), outcome,
    reason: 'The available primary filing substantiates the precise revenue comparison.',
    checks: { entityMatched: true, timeAligned: true, primarySourcesChecked: true }, originalContribution: true,
    claims: [{ text: input.claim, verdict: 'supported', critical: true, sourceRefs: ['sec-filing-1'], explanation: 'The retained filing records the comparison in the revenue table.' }],
    sources: [{ url: input.sources[0], provider: 'sec-edgar', providerReceiptId: 'sec-filing-1', retrievedAt: new Date(ctx.time() - 5000).toISOString(), availableAt: new Date(ctx.time() - 30_000).toISOString(), contentHash: 'a'.repeat(64), primary: true, entityId: '0000000001', publisherId: 'sec-cik:0000000001' }],
  }
}
function modelReceipt(task: any) {
  return {
    receiptId: randomUUID(), submissionId: task.id, leaseToken: task.leaseToken, samReceiptId: task.samReceipt.receiptId,
    evidenceDigest: task.evidenceDigest, inputDigest: task.inputDigest, asOf: task.samReceipt.asOf,
    modelVersion: 'independent-test-v1', reviewerVersion: 'review-worker-v1', verdict: 'approved',
    reason: 'Independent review confirms the claim and limitations against the exact retained evidence.',
    checks: { entityMatched: true, timeAligned: true, primarySourcesChecked: true, evidenceSupportsConclusion: true, independentReview: true },
  }
}

describe('durable member research', () => {
  it('keeps a content-free erasure job for claimed research and rejects late point receipts', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx)
    deleteMemberResearch(ctx.db,1,ctx.time())
    const rows = ctx.db.prepare('SELECT * FROM member_research_deletions').all()
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain(input.claim)
    expect((await ctx.worker('/api/internal/research/sam-receipt',evidence(ctx,task,'supported_effort'))).status).toBe(404)
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM test_awards').get()!.n).toBe(0)
    expect((await ctx.worker('/api/internal/research/deletion-claim',{},'review')).status).toBe(401)
    const first = (await (await ctx.worker('/api/internal/research/deletion-claim',{})).json() as any).items[0]
    expect(first.submissionId).toBe(task.id); expect(first.memberId).toBeUndefined()
    expect((await (await ctx.worker('/api/internal/research/deletion-claim',{})).json() as any).items).toEqual([])
    ctx.advance(301_000)
    const second = (await (await ctx.worker('/api/internal/research/deletion-claim',{})).json() as any).items[0]
    const receipt = {...first,scope:'samv2-model-records-v1'}; delete receipt.leaseExpiresAt
    expect((await ctx.worker('/api/internal/research/deletion-receipt',receipt)).status).toBe(409)
    receipt.leaseToken=second.leaseToken
    expect((await ctx.worker('/api/internal/research/deletion-receipt',{...receipt,scope:'all-provider-logs'})).status).toBe(400)
    expect((await ctx.worker('/api/internal/research/deletion-receipt',receipt)).status).toBe(200)
    expect(await (await ctx.worker('/api/internal/research/deletion-receipt',receipt)).json()).toMatchObject({completed:true,idempotent:true})
    expect(ctx.db.prepare('SELECT state FROM member_research_deletions').get()!.state).toBe('completed')
  })

  it('does not wait for external erasure when research was never leased', async () => {
    const ctx=setup(); await ctx.member('/api/member/research',input)
    deleteMemberResearch(ctx.db,1,ctx.time())
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM member_research_deletions').get()!.n).toBe(0)
  })

  it('distinguishes earlier duplicates so later copies cannot disqualify the original', async () => {
    const ctx = setup()
    const first = await (await ctx.member('/api/member/research', input, 1)).json() as any
    const second = await (await ctx.member('/api/member/research', input, 2)).json() as any
    const { items } = await (await ctx.worker('/api/internal/research/claim', { limit: 5 })).json() as any
    expect(items.find((t: any) => t.id === first.submission.id).earlierExactDuplicateCount).toBe(0)
    expect(items.find((t: any) => t.id === second.submission.id).earlierExactDuplicateCount).toBe(1)
    expect(items.every((t: any) => t.exactDuplicateCount === 1)).toBe(true)
  })

  it('matches the Python worker signature for an exact protocol vector', () => {
    expect(researchSignature('k'.repeat(32), '1790427600000', 'a'.repeat(32), 'POST', '/api/internal/research/claim', '{"limit":1}'))
      .toBe('566259187b744bc9c32b69dd3c73e7ef72fd0eb37757e1a5485b679c5b8aeebf')
  })
  it('requires membership and completed Discord verification', async () => {
    const ctx = setup({ canSubmitResearch: () => false })
    expect((await ctx.app.request('/api/member/research')).status).toBe(401)
    expect((await ctx.member('/api/member/research', input)).status).toBe(403)
  })

  it('rejects non-public URL hints without making network requests', async () => {
    for (const url of ['http://www.sec.gov/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/x', 'https://metadata.internal/x', 'https://user:pass@www.sec.gov/x', 'https://localhost/x', 'https://www.sec.gov:8080/x']) expect(isPublicHttpsHint(url)).toBe(false)
    const ctx = setup()
    expect((await ctx.member('/api/member/research', { ...input, sources: ['https://127.0.0.1/x'] })).status).toBe(400)
  })

  it('persists intake, scopes reads, and preserves all idempotency aliases', async () => {
    const ctx = setup()
    const first = await (await ctx.member('/api/member/research', input, 1, 'request-0001')).json() as any
    const second = await (await ctx.member('/api/member/research', input, 1, 'request-0002')).json() as any
    expect(second.duplicate).toBe(true); expect(second.submission.id).toBe(first.submission.id)
    expect((await ctx.member('/api/member/research', { ...input, claim: 'A different sufficiently long claim.' }, 1, 'request-0002')).status).toBe(409)
    expect((await (await ctx.member('/api/member/research', undefined, 2)).json() as any).submissions).toEqual([])
    expect(first.submission.points).toBe(null)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_awards').get()).toEqual({ n: 0 })
  })

  it('caps intake by member and rejects oversized bodies before parsing', async () => {
    const ctx = setup()
    for (let i = 0; i < 8; i++) expect((await ctx.member('/api/member/research', { ...input, claim: `${input.claim} Revision ${i}.` })).status).toBe(200)
    expect((await ctx.member('/api/member/research', { ...input, claim: `${input.claim} Ninth.` })).status).toBe(429)
    expect((await ctx.member('/api/member/research', { ...input, reasoning: 'x'.repeat(30_000) })).status).toBe(413)
  })

  it('authenticates worker role, body, path, timestamp and one-use nonce', async () => {
    const ctx = setup()
    expect((await ctx.app.request('/api/internal/research/claim', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await ctx.worker('/api/internal/research/review-claim', {}, 'sam')).status).toBe(401)
    const nonce = randomUUID()
    expect((await ctx.worker('/api/internal/research/claim', {}, 'sam', nonce)).status).toBe(200)
    expect((await ctx.worker('/api/internal/research/claim', {}, 'sam', nonce)).status).toBe(409)
    const path = '/api/internal/research/claim', timestamp = String(ctx.time() - 301_000), raw = '{}'
    expect((await ctx.app.request(path, { method: 'POST', headers: { 'x-sam-timestamp': timestamp, 'x-sam-nonce': randomUUID(), 'x-sam-signature': researchSignature(ctx.options.sharedKey!, timestamp, randomUUID(), 'POST', path, raw) }, body: raw })).status).toBe(401)
  })

  it('leases atomically and rejects receipts after a lease was replaced', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx)
    expect((await (await ctx.worker('/api/internal/research/claim', {})).json() as any).items).toEqual([])
    ctx.advance(301_000)
    const replacement = (await (await ctx.worker('/api/internal/research/claim', {})).json() as any).items[0]
    expect(replacement.id).toBe(task.id); expect(replacement.leaseToken).not.toBe(task.leaseToken)
    expect((await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, task, 'supported_effort'))).status).toBe(409)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_awards').get()).toEqual({ n: 0 })
  })

  it('keeps outages pending and fails closed when real providers are unconfigured', async () => {
    const ctx = setup({ allowedProviders: [] }), task = await intakeAndClaim(ctx)
    expect((await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, task, 'supported_effort'))).status).toBe(503)
    const receipt = evidence(ctx, task, 'unavailable')
    receipt.claims = []; receipt.sources = []
    const answer = await (await ctx.worker('/api/internal/research/sam-receipt', receipt)).json() as any
    expect(answer.submission.status).toBe('received'); expect(answer.submission.points).toBe(null)
    expect(answer.submission.reason).toContain('not a false-information')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_awards').get()).toEqual({ n: 0 })
  })

  it('requires attributable evidence for a false finding', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx), receipt = evidence(ctx, task, 'false')
    receipt.claims[0]!.verdict = 'contradicted'; receipt.claims[0]!.sourceRefs = ['made-up-receipt']
    expect((await ctx.worker('/api/internal/research/sam-receipt', receipt)).status).toBe(400)
    receipt.claims[0]!.sourceRefs = ['sec-filing-1']
    const answer = await (await ctx.worker('/api/internal/research/sam-receipt', receipt)).json() as any
    expect(answer.submission.status).toBe('declined'); expect(answer.submission.points).toBe(0)
  })

  it('awards supported effort once and rejects exact copied awards across members', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx), receipt = evidence(ctx, task, 'supported_effort')
    const first = await (await ctx.worker('/api/internal/research/sam-receipt', receipt)).json() as any
    expect(first.submission.points).toBe(1)
    const retry = await (await ctx.worker('/api/internal/research/sam-receipt', receipt)).json() as any
    expect(retry.idempotent).toBe(true)
    const copy = await intakeAndClaim(ctx, 2)
    expect(copy.exactDuplicateCount).toBe(1)
    expect((await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, copy, 'supported_effort'))).status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM test_awards').get()).toEqual({ n: 1 })
  })

  it('requires independent review of matching evidence before +3', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx), sam = evidence(ctx, task)
    const accepted = await (await ctx.worker('/api/internal/research/sam-receipt', sam)).json() as any
    expect(accepted.submission.status).toBe('eligible_for_review'); expect(accepted.submission.points).toBe(null)
    const reviewTask = (await (await ctx.worker('/api/internal/research/review-claim', {}, 'review')).json() as any).items[0]
    const review = modelReceipt(reviewTask)
    expect((await ctx.worker('/api/internal/research/model-receipt', { ...review, evidenceDigest: 'b'.repeat(64) }, 'review')).status).toBe(409)
    expect((await ctx.worker('/api/internal/research/model-receipt', { ...review, checks: { ...review.checks, entityMatched: false } }, 'review')).status).toBe(400)
    const result = await (await ctx.worker('/api/internal/research/model-receipt', review, 'review')).json() as any
    expect(result.submission.points).toBe(3); expect(result.submission.status).toBe('awarded')
    expect((await (await ctx.worker('/api/internal/research/model-receipt', review, 'review')).json() as any).idempotent).toBe(true)
    expect(ctx.db.prepare('SELECT points FROM test_awards').all()).toEqual([{ points: 3 }])
  })

  it('rejects shared reviewer credentials and future evidence leakage', async () => {
    const ctx = setup({ reviewSharedKey: 's'.repeat(48) })
    expect((await ctx.worker('/api/internal/research/review-claim', {}, 'review')).status).toBe(503)
    const task = await intakeAndClaim(ctx), receipt = evidence(ctx, task)
    receipt.sources[0]!.availableAt = new Date(ctx.time() + 1000).toISOString()
    expect((await ctx.worker('/api/internal/research/sam-receipt', receipt)).status).toBe(400)
  })

  it('does not let member-supplied event time earn a speed achievement', async () => {
    let awarded: any
    const ctx = setup({ awardReview: input => { awarded = input } })
    const task = await intakeAndClaim(ctx, 1, { ...input, eventAt: new Date(ctx.time() - 1000).toISOString() } as typeof input)
    expect((await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, task, 'supported_effort'))).status).toBe(200)
    expect(awarded.quality.eventAt).toBeUndefined()
    expect((await ctx.member(`/api/member/research/${task.id}`, undefined, 2)).status).toBe(404)
    expect((await (await ctx.member(`/api/member/research/${task.id}`)).json() as any).verification.claims[0].verdict).toBe('supported')
  })

  it('rolls back both receipt and status if the points ledger fails', async () => {
    const ctx = setup({ awardReview: () => { throw new Error('ledger offline') } }), task = await intakeAndClaim(ctx)
    expect((await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, task, 'supported_effort'))).status).toBe(503)
    expect(ctx.db.prepare('SELECT status,points FROM member_research').get()).toEqual({ status: 'system_check', points: null })
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM member_research_receipts').get()).toEqual({ n: 0 })
  })

  it('makes appeal evidence available to workers and binds a new context digest', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx), receipt = evidence(ctx, task, 'needs_evidence')
    expect((await ctx.worker('/api/internal/research/sam-receipt', receipt)).status).toBe(200)
    const appeal = { reason: 'An additional primary filing now provides the missing comparable period.', sources: ['https://www.sec.gov/Archives/amended-filing.html'] }
    expect((await ctx.member(`/api/member/research/${task.id}/appeal`, appeal, 2)).status).toBe(404)
    expect((await ctx.member(`/api/member/research/${task.id}/appeal`, appeal)).status).toBe(200)
    const next = (await (await ctx.worker('/api/internal/research/claim', {})).json() as any).items[0]
    expect(next.appeals[0].reason).toBe(appeal.reason); expect(next.inputDigest).not.toBe(task.inputDigest)
    expect((await ctx.worker('/api/internal/research/sam-receipt', { ...evidence(ctx, next), inputDigest: task.inputDigest })).status).toBe(409)
  })

  it('removes retained member research only in the explicit deletion flow', async () => {
    const ctx = setup(), task = await intakeAndClaim(ctx)
    await ctx.worker('/api/internal/research/sam-receipt', evidence(ctx, task, 'needs_evidence'))
    deleteMemberResearch(ctx.db, 1)
    for (const table of ['member_research', 'member_research_events', 'member_research_receipts', 'member_research_idempotency']) expect(ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
  })

  it('accepts /dd only with an authentic Discord signature, linked member and designated channel', async () => {
    const keys = generateKeyPairSync('ed25519')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
    const ctx = setup({ discord: { publicKey, guildId: '12345678901234567', channelId: '22345678901234567', publicOrigin: 'https://members.example.com',
      getLinkedMember: id => id === '32345678901234567' ? { id: 1 } : undefined,
      getMemberSummary: () => ({ userId: 'test.member', rank: 2, title: 'Observer', points: 10, deadline: '2026-09-30T00:00:00Z', collectibles: [{ collection: 'moon', title: 'First Man on the Moon', serial: 4, cap: 200 }] }),
    } })
    const interaction = { id: '42345678901234567', type: 2, guild_id: '12345678901234567', channel_id: '22345678901234567', member: { user: { id: '32345678901234567' } }, data: { name: 'dd', options: Object.entries(input).map(([name, value]) => ({ name, value: Array.isArray(value) ? value.join(' ') : value })) } }
    const request = async (payload: unknown, valid = true) => {
      const raw = JSON.stringify(payload), timestamp = String(Math.floor(ctx.time() / 1000))
      return ctx.app.request('/api/discord/interactions', { method: 'POST', body: raw, headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': valid ? sign(null, Buffer.from(timestamp + raw), keys.privateKey).toString('hex') : '0'.repeat(128) } })
    }
    expect((await request(interaction, false)).status).toBe(401)
    expect((await (await request({ ...interaction, channel_id: '99999999999999999' })).json() as any).data.content).toContain('designated')
    const reply = await (await request(interaction)).json() as any
    expect(reply.data.flags).toBe(64); expect(reply.data.content).toContain('Research received:')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM member_research').get()).toEqual({ n: 1 })
    await request(interaction)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM member_research').get()).toEqual({ n: 1 })
    const profile = await (await request({ ...interaction, data: { name: 'profile' } })).json() as any
    expect(profile.data.flags).toBe(64); expect(profile.data.content).toContain('<t:1790726400:R>')
    expect(profile.data.content).toContain('#4/200')
    const badge = await (await request({ ...interaction, data: { name: 'badge', options: [{ name: 'share', value: true }] } })).json() as any
    expect(badge.data.flags).toBeUndefined(); expect(badge.data.allowed_mentions).toEqual({ parse: [] })
    expect(badge.data.embeds[0].image.url).toBe('https://members.example.com/badges/moon.png')
    const unearned = await (await request({ ...interaction, data: { name: 'badge', options: [{ name: 'choice', value: 'wolf' }] } })).json() as any
    expect(unearned.data.content).toContain('only display badges awarded')
  })
})
