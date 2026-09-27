import { createHmac, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { addSignup, openDb, type Db } from '../server/db.js'
import { deliverMailBatch, enqueueMail, initMail, type MailConfig } from '../server/mail.js'
import { mailDeliveryHealth } from '../server/mail-events.js'
import { finalizeMemberDeletions, requestMemberDeletion } from '../server/member-deletion.js'
import type { MemberRuntime } from '../server/members.js'

const NOW = 1_800_000_000_000
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
const ADMIN = 'fixture-admin'
const PROVIDER_ID = 'cf4b3536-e063-454c-a59f-5eb6a705f5a6'
const MAIL = { to: 'member@example.com', subject: 'Private welcome', text: 'Private verification code 12345678',
  kind: 'welcome', dedupeKey: 'mail:1' }
const databases: Db[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close() })

function fixture(options: { enabled?: boolean; member?: boolean; mail?: Partial<MailConfig> } = {}) {
  const db = openDb(':memory:'); databases.push(db)
  if (options.member) addSignup(db, { userId: 'Founder', email: MAIL.to })
  let runtime!: MemberRuntime
  const sent: Array<Record<string, unknown>> = []
  const config: MailConfig = { enabled: true, apiKey: 'fixture-key', from: 'sam@example.com',
    webhookSecret: SECRET, probeTo: 'operator@example.com', now: () => NOW,
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return Response.json({ id: PROVIDER_ID })
    }) as typeof fetch, ...options.mail }
  const app = createApp({ db, adminToken: ADMIN, now: () => NOW,
    markets: async () => ({ asOf: new Date(NOW).toISOString(), items: [] }),
    membership: { enabled: options.enabled ?? true, mail: config }, onMemberRuntime: value => { runtime = value } })
  function enqueue() {
    enqueueMail(db, { ...MAIL, ...(options.member ? { memberId: 1 } : {}) }, NOW)
    return db.prepare('SELECT id FROM member_email_outbox WHERE dedupe_key=?').get(MAIL.dedupeKey)!.id as string
  }
  return { db, config, app, runtime, sent, enqueue }
}
type Fixture = ReturnType<typeof fixture>
function event(outboxId: string, type = 'email.delivered', at = NOW, to = MAIL.to) {
  return { type, created_at: new Date(at).toISOString(), data: { email_id: PROVIDER_ID, to: [to],
    subject: MAIL.subject, tags: { sam_outbox_id: outboxId } } }
}
function requestFor(payload: unknown, options: { id?: string; timestamp?: number; secret?: string; alterBody?: boolean } = {}) {
  const raw = JSON.stringify(payload), id = options.id ?? `msg_${randomUUID()}`
  const timestamp = String(Math.floor((options.timestamp ?? NOW) / 1000))
  // Independent standard-webhook signature, not the implementation's verifier/sign helper.
  const signature = createHmac('sha256', Buffer.from((options.secret ?? SECRET).slice(6), 'base64'))
    .update(`${id}.${timestamp}.${raw}`).digest('base64')
  return { method: 'POST', body: options.alterBody ? `${raw} ` : raw,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } }
}
async function webhook(f: Fixture, payload: unknown, options: Parameters<typeof requestFor>[1] = {}) {
  return f.app.request('/api/webhooks/resend', requestFor(payload, options))
}
async function status(f: Fixture) {
  return (await f.app.request('/api/admin/members/status', { headers: { authorization: `Bearer ${ADMIN}` } })).json() as
    Promise<{ enabled: boolean; emailDelivery: ReturnType<typeof mailDeliveryHealth> }>
}
function postProbe(f: Fixture, probeId: string, extra: Record<string, unknown> = {}, authenticated = true) {
  return f.app.request('/api/admin/members/email-probe', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${ADMIN}` } : {}) },
    body: JSON.stringify({ probeId, ...extra }) })
}

describe('verified member email events', () => {
  it('records delivery separately from acceptance and exposes only aggregate diagnostics', async () => {
    const f = fixture(), id = f.enqueue()
    await f.runtime.tick()
    expect(mailDeliveryHealth(f.db, f.config, NOW).counts).toEqual([{ state: 'unconfirmed', count: 1 }])
    expect((await webhook(f, event(id))).status).toBe(200)
    const health = await status(f)
    expect(health.emailDelivery.counts).toEqual([{ state: 'delivered_to_mail_server', count: 1 }])
    expect(health.emailDelivery.lastEventAt).toBe(NOW)
    const receipt = f.db.prepare('SELECT * FROM member_email_events').get()!
    expect(receipt).toMatchObject({ outbox_id: id, event_type: 'email.delivered', occurred_at: NOW })
    for (const privateValue of [MAIL.to, MAIL.subject, '12345678', SECRET, 'fixture-key']) {
      expect(JSON.stringify(health)).not.toContain(privateValue)
      expect(JSON.stringify(receipt)).not.toContain(privateValue)
    }
  })

  it('deduplicates retries and rejects changed content under the same event identity', async () => {
    const f = fixture(), id = f.enqueue(); await f.runtime.tick()
    const payload = event(id), options = { id: 'msg_same_event' }
    expect((await webhook(f, payload, options)).status).toBe(200)
    expect(await (await webhook(f, payload, options)).json()).toMatchObject({ duplicate: true })
    expect((await webhook(f, event(id, 'email.bounced'), options)).status).toBe(409)
    expect(f.db.prepare('SELECT COUNT(*) n FROM member_email_events').get()!.n).toBe(1)
  })

  it.each([
    { alterBody: true },
    { timestamp: NOW - 301_000 },
    { timestamp: NOW + 301_000 },
    { secret: `whsec_${Buffer.alloc(32, 8).toString('base64')}` },
  ])('rejects forged or stale callbacks before changing state: %j', async options => {
    const f = fixture(), id = f.enqueue(); await f.runtime.tick()
    expect((await webhook(f, event(id), options)).status).toBe(400)
    expect(f.db.prepare('SELECT COUNT(*) n FROM member_email_events').get()!.n).toBe(0)
  })

  it('reconciles a webhook received before a lost send response without sending twice', async () => {
    const f = fixture(), id = f.enqueue(); let sends = 0
    f.config.fetchImpl = (async () => {
      sends++
      expect((await webhook(f, event(id))).status).toBe(200)
      throw new Error('provider accepted but HTTP response lost')
    }) as typeof fetch
    expect(await deliverMailBatch(f.db, f.config)).toEqual({ accepted: 1, retried: 0 })
    await deliverMailBatch(f.db, f.config)
    expect(sends).toBe(1)
    expect(f.db.prepare('SELECT state,body,lease_id FROM member_email_outbox WHERE id=?').get(id))
      .toEqual({ state: 'accepted', body: '', lease_id: null })
  })

  it('ignores unattempted, unrelated, mismatched and cancelled mail', async () => {
    const f = fixture(), id = f.enqueue()
    expect(await (await webhook(f, event(id))).json()).toMatchObject({ ignored: true })
    await f.runtime.tick()
    for (const payload of [event(randomUUID()), event(id, 'email.delivered', NOW, 'other@example.com'),
      { ...event(id), data: { ...event(id).data, email_id: randomUUID() } }, { type: 'email.opened', data: {} }]) {
      expect(await (await webhook(f, payload)).json()).toMatchObject({ ignored: true })
    }
    f.db.prepare("UPDATE member_email_outbox SET state='cancelled' WHERE id=?").run(id)
    expect(await (await webhook(f, event(id))).json()).toMatchObject({ ignored: true })
    expect(f.db.prepare('SELECT COUNT(*) n FROM member_email_events').get()!.n).toBe(0)
  })

  it.each(['email.bounced', 'email.complained', 'email.suppressed'])('keeps %s visible and suppresses subsequent sends', async type => {
    const f = fixture(), id = f.enqueue(); await f.runtime.tick()
    await webhook(f, event(id, 'email.delivered', NOW - 5000))
    await webhook(f, event(id, 'email.delivery_delayed', NOW - 10_000))
    expect(mailDeliveryHealth(f.db, f.config, NOW).counts).toEqual([{ state: 'delivered_to_mail_server', count: 1 }])
    await webhook(f, event(id, type))
    await webhook(f, event(id, 'email.sent', NOW - 15_000))
    expect(mailDeliveryHealth(f.db, f.config, NOW).counts).toEqual([{ state: type.slice(6), count: 1 }])
    enqueueMail(f.db, { ...MAIL, dedupeKey: 'mail:2', to: MAIL.to.toUpperCase() }, NOW)
    await f.runtime.tick()
    expect(f.sent).toHaveLength(1)
    expect(f.db.prepare("SELECT state,body FROM member_email_outbox WHERE dedupe_key='mail:2'").get())
      .toEqual({ state: 'suppressed', body: '' })
  })

  it('shows delayed/failed delivery and acceptance with no delivery evidence past fifteen minutes', async () => {
    const f = fixture(), id = f.enqueue(); await f.runtime.tick()
    await webhook(f, event(id, 'email.delivery_delayed'))
    expect(mailDeliveryHealth(f.db, f.config, NOW + 16 * 60_000).awaitingDeliveryOver15Minutes)
      .toEqual({ count: 1, oldestAcceptedAt: NOW })
    await webhook(f, event(id, 'email.failed'))
    expect(mailDeliveryHealth(f.db, f.config, NOW).counts).toEqual([{ state: 'failed', count: 1 }])
  })

  it('erases email events immediately on deletion and never recreates them from late callbacks', async () => {
    const f = fixture({ member: true }), id = f.enqueue()
    enqueueMail(f.db, { ...MAIL, kind: 'login_code', dedupeKey: 'before-signup' }, NOW)
    const loginId = f.db.prepare("SELECT id FROM member_email_outbox WHERE dedupe_key='before-signup'").get()!.id as string
    await f.runtime.tick()
    const payload = event(id), eventId = { id: 'msg_before_deletion' }
    await webhook(f, payload, eventId)
    await webhook(f, event(loginId))
    f.db.prepare(`INSERT INTO discord_member_links(member_id,discord_user_id,discord_username,state,
      confirmation_expires_at,access_token_expires_at,updated_at) VALUES(1,'111111111111111111','private-name','verified',?,?,?)`).run(NOW, NOW, NOW)
    expect(requestMemberDeletion(f.db, 1, 'Founder', NOW)).toBe(true)
    expect(f.db.prepare('SELECT state FROM member_deletions').get()!.state).toBe('requested')
    expect(f.db.prepare('SELECT * FROM member_email_events').all()).toHaveLength(0)
    expect(await (await webhook(f, payload, eventId)).json()).toMatchObject({ ignored: true })
    expect(await (await webhook(f, event(loginId))).json()).toMatchObject({ ignored: true })
    f.db.prepare("UPDATE discord_member_links SET state='revoked'").run()
    expect(finalizeMemberDeletions(f.db, NOW)).toBe(1)
    expect(await (await webhook(f, payload)).json()).toMatchObject({ ignored: true })
    expect(f.db.prepare('SELECT * FROM member_email_outbox').all()).toHaveLength(0)
    expect(f.db.prepare('SELECT * FROM member_email_events').all()).toHaveLength(0)
  })

  it('preserves the send envelope when upgrading an already attempted legacy outbox', async () => {
    const f = fixture(), id = f.enqueue()
    f.db.exec('ALTER TABLE member_email_outbox DROP COLUMN tracking_version')
    f.db.prepare("UPDATE member_email_outbox SET attempts=1,first_attempt_at=?,last_error='delivery_uncertain' WHERE id=?").run(NOW - 1000, id)
    initMail(f.db)
    await f.runtime.tick()
    expect(f.sent[0]).toEqual({ from: 'sam@example.com', to: [MAIL.to], subject: MAIL.subject, text: MAIL.text })
    const payload = event(id)
    expect((await webhook(f, { ...payload, data: { email_id: PROVIDER_ID, to: [MAIL.to] } })).status).toBe(200)
    expect(mailDeliveryHealth(f.db, f.config, NOW).counts).toEqual([{ state: 'delivered_to_mail_server', count: 1 }])
  })

  it('fails closed without a signing secret and bounds callback bodies', async () => {
    const disabled = fixture({ mail: { webhookSecret: undefined } })
    expect((await webhook(disabled, event(randomUUID()))).status).toBe(503)
    const f = fixture()
    expect((await webhook(f, { padding: 'x'.repeat(33 * 1024) })).status).toBe(413)
    expect((await f.app.request('/api/webhooks/resend', { method: 'POST', body: '{}' })).status).toBe(415)
  })
})

describe('operator delivery check before membership activation', () => {
  it('sends only a configured operator probe, stays idempotent and leaves membership inactive', async () => {
    const f = fixture({ enabled: false }), probeId = randomUUID()
    const ordinaryId = f.enqueue()
    expect((await postProbe(f, probeId)).status).toBe(202)
    expect((await postProbe(f, probeId)).status).toBe(202)
    expect((await postProbe(f, randomUUID())).status).toBe(429)
    await f.runtime.tick()
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.to).toEqual(['operator@example.com'])
    expect(f.sent[0]!.text).toContain(probeId)
    expect(f.db.prepare('SELECT state FROM member_email_outbox WHERE id=?').get(ordinaryId)!.state).toBe('queued')
    expect(f.db.prepare('SELECT * FROM members').all()).toHaveLength(0)
    expect(f.db.prepare("SELECT * FROM membership_migrations WHERE name='waitlist-bootstrap-v1'").all()).toHaveLength(0)
    const probe = f.db.prepare("SELECT id FROM member_email_outbox WHERE kind='operator_delivery_probe'").get()!
    await webhook(f, event(probe.id as string, 'email.delivered', NOW, 'operator@example.com'))
    const response = await f.app.request(`/api/admin/members/email-probe/${probeId}`, { headers: { authorization: `Bearer ${ADMIN}` } })
    expect(await response.json()).toMatchObject({ probe: { delivery_state: 'delivered_to_mail_server', event_count: 1 } })
    expect((await status(f)).enabled).toBe(false)
  })

  it('rejects guests, arbitrary recipients, cross-origin requests and missing probe configuration', async () => {
    const f = fixture({ enabled: false })
    expect((await postProbe(f, randomUUID(), {}, false)).status).toBe(404)
    expect((await postProbe(f, randomUUID(), { to: 'attacker@example.com' })).status).toBe(400)
    const crossOrigin = await f.app.request('/api/admin/members/email-probe', { method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ probeId: randomUUID() }) })
    expect(crossOrigin.status).toBe(404)
    const unconfigured = fixture({ enabled: false, mail: { probeTo: undefined } })
    expect((await postProbe(unconfigured, randomUUID())).status).toBe(503)
    expect(f.db.prepare('SELECT * FROM member_email_outbox').all()).toHaveLength(0)
    expect((await f.app.request('/api/admin/members/status')).status).toBe(404)
  })
})
