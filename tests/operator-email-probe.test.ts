import { createHmac, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../server/app.js'
import { addSignup, allSignups, openDb, type Db } from '../server/db.js'
import type { MemberRuntime } from '../server/members.js'
import { runOperatorEmailProbe } from '../server/operator-email-probe.js'

const ORIGIN = 'https://members.example.test'
const ADMIN = 'operator-fixture-secret'
const SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
const databases: Db[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
const environment = () => ({ MEMBER_EMAIL_PROBE_ID: randomUUID(), MEMBER_PUBLIC_ORIGIN: ORIGIN,
  CANONICAL_HOST: 'members.example.test', ADMIN_TOKEN: ADMIN })

function fixture({ active = false, mailEnabled = true, receipt = true } = {}) {
  const db = openDb(':memory:'); databases.push(db)
  addSignup(db, { userId: 'PreservedUser', email: 'existing@example.test' })
  let runtime!: MemberRuntime
  const sent: unknown[] = []
  const app = createApp({ db, adminToken: ADMIN,
    markets: async () => ({ asOf: new Date().toISOString(), items: [] }),
    membership: { enabled: active, mail: { enabled: mailEnabled, apiKey: 'provider-fixture-secret',
      from: 'sender@example.test', probeTo: 'operator@example.test', webhookSecret: SECRET,
      fetchImpl: (async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)))
        return Response.json({ id: 'provider-probe-fixture' })
      }) as typeof fetch } }, onMemberRuntime: value => { runtime = value } })
  const requests: Array<{ url: string; method: string; redirect: string | undefined }> = []
  const fetchImpl = (async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', redirect: init?.redirect })
    return app.request(String(url), { ...init, headers: { ...init?.headers, host: 'members.example.test' } })
  }) as typeof fetch
  let receiptSent = false
  const sleep = async () => {
    await runtime.tick()
    if (!receipt || receiptSent) return
    const row = db.prepare("SELECT id FROM member_email_outbox WHERE kind='operator_delivery_probe' AND state='accepted'").get()
    if (!row) return
    const eventId = 'msg_operator_test', timestamp = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(),
      data: { email_id: 'provider-probe-fixture', to: ['operator@example.test'], tags: { sam_outbox_id: row.id } } })
    const signature = createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
      .update(`${eventId}.${timestamp}.${body}`).digest('base64')
    const response = await app.request('/api/webhooks/resend', { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'svix-id': eventId,
        'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` } })
    expect(response.status).toBe(200)
    receiptSent = true
  }
  return { db, sent, requests, fetchImpl, sleep }
}

describe('operator deployment email check', () => {
  it('uses protected APIs, requires a signed delivery receipt and preserves existing signups', async () => {
    const f = fixture(), env = environment()
    const result = await runOperatorEmailProbe(env, f)
    expect(result).toMatchObject({ event: 'member_email_probe_delivered', probeId: env.MEMBER_EMAIL_PROBE_ID,
      signedEvents: 1, membershipEnabled: false, members: 0, signupsBefore: 1, signupsAfter: 1 })
    expect(f.sent).toHaveLength(1)
    expect(allSignups(f.db).map(row => ({ userId: row.user_id, email: row.email })))
      .toEqual([{ userId: 'PreservedUser', email: 'existing@example.test' }])
    expect(f.db.prepare('SELECT COUNT(*) count FROM members').get()!.count).toBe(0)
    expect(f.requests.every(r => r.url.startsWith(`${ORIGIN}/api/admin/`) && r.redirect === 'error')).toBe(true)
    for (const privateValue of [ADMIN, SECRET, 'provider-fixture-secret', 'operator@example.test', 'existing@example.test']) {
      expect(JSON.stringify(result)).not.toContain(privateValue)
    }
    // A restart repeats the same check, not the message.
    await runOperatorEmailProbe(env, f)
    expect(f.sent).toHaveLength(1)
  })

  it('refuses to send after membership activation', async () => {
    const f = fixture({ active: true })
    await expect(runOperatorEmailProbe(environment(), f)).rejects.toThrow('membership_already_active')
    expect(f.requests.every(r => r.method === 'GET')).toBe(true)
    expect(f.sent).toHaveLength(0)
  })

  it('refuses to send with incomplete delivery configuration', async () => {
    const f = fixture({ mailEnabled: false })
    await expect(runOperatorEmailProbe(environment(), f)).rejects.toThrow('email_unconfigured')
    expect(f.requests.every(r => r.method === 'GET')).toBe(true)
    expect(f.sent).toHaveLength(0)
  })

  it.each(['http://members.example.test', 'https://other.example.test',
    'https://name:password@members.example.test', `${ORIGIN}/unexpected`, `${ORIGIN}:444`])
  ('rejects unsafe targets before making a request: %s', async origin => {
    const fetchImpl = vi.fn()
    await expect(runOperatorEmailProbe({ ...environment(), MEMBER_PUBLIC_ORIGIN: origin }, { fetchImpl }))
      .rejects.toThrow('invalid_configuration')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not follow a redirect with the administrator credential', async () => {
    const fetchImpl = vi.fn(async () => Response.redirect('https://other.example.test', 302))
    await expect(runOperatorEmailProbe(environment(), { fetchImpl })).rejects.toThrow('http_302')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.length).toBe(2)
  })

  it('does not claim delivery when only provider acceptance exists', async () => {
    const f = fixture({ receipt: false })
    // Avoid the separate HTTP rate limiter in this accelerated fixture; real polling is five seconds apart.
    const fetchImpl = (async (url, init) => f.fetchImpl(url, {
      ...init, headers: { ...init?.headers, 'x-forwarded-for': `fixture-${randomUUID()}` },
    })) as typeof fetch
    await expect(runOperatorEmailProbe(environment(), { ...f, fetchImpl })).rejects.toThrow('delivery_unconfirmed')
    expect(f.sent).toHaveLength(1)
  })

  it('does not expose raw transport errors or credentials', async () => {
    const failure = `${ADMIN} ${SECRET} operator@example.test`
    const fetchImpl = vi.fn(async () => { throw new Error(failure) })
    const result = await runOperatorEmailProbe(environment(), { fetchImpl, sleep: async () => {} }).catch(error => error)
    expect(result.message).toBe('endpoint_unavailable')
    expect(JSON.stringify(result)).not.toContain(ADMIN)
    expect(fetchImpl).toHaveBeenCalledTimes(30)
  })
})
