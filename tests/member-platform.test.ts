import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { addSignup, openDb, type Db } from '../server/db.js'
import { deviceKeyHash, requestSigningMessage, verificationMessage } from '../server/membership-auth.js'
import type { MemberPlatformConfig, MemberRuntime } from '../server/members.js'

const NOW = 1_800_000_000_000
const databases: Db[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function database() { const db = openDb(':memory:'); databases.push(db); return db }
function browser() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = pair.publicKey.export({ format: 'jwk' })
  return { ...pair, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } }
}
type Browser = ReturnType<typeof browser>
type ProfileResponse = { profile: { referrals: { remainingInvites: number; directVerified: number }; quests: Array<{ status: string }> } }
function signature(device: Browser, message: string) {
  return sign('sha256', Buffer.from(message), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
}
function fixture(db: Db, membership?: MemberPlatformConfig) {
  let runtime!: MemberRuntime
  const app = createApp({ db, now: () => NOW, membership,
    markets: async () => ({ asOf: new Date(NOW).toISOString(), items: [] }),
    onMemberRuntime: value => { runtime = value },
  })
  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { app, runtime, post }
}
function deliveryConfig(sent: Array<{ to: string[]; subject: string; text: string }>): MemberPlatformConfig {
  return { enabled: true, mail: { enabled: true, apiKey: 'test-key', from: 'sam@example.com', now: () => NOW,
    fetchImpl: (async (_url: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return Response.json({ id: `mail-${sent.length}` })
    }) as typeof fetch,
  } }
}
async function enroll(f: ReturnType<typeof fixture>, db: Db, device: Browser, email: string, extra: { userId?: string; inviteToken?: string } = {}) {
  const start = await f.post(`/api/membership/${extra.inviteToken ? 'signup' : 'login'}`, { email, publicKey: device.publicKey, ...extra })
  expect(start.status).toBe(202)
  const challenge = await start.json() as { challengeId: string; nonce: string }
  const outbox = db.prepare('SELECT body FROM member_email_outbox WHERE dedupe_key=?').get(`membership-code:${challenge.challengeId}`) as { body: string }
  const code = outbox.body.match(/code is (\d{8})/)![1]!
  await f.runtime.tick()
  const response = await f.post('/api/membership/verify', {
    challengeId: challenge.challengeId, code,
    signature: signature(device, verificationMessage(challenge.challengeId, challenge.nonce, code, deviceKeyHash(device.publicKey))),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { sessionBinding: string; member: { id: number; userId: string } }
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!
  function signed(path: string, method = 'GET', data?: unknown) {
    const payload = data === undefined ? '' : JSON.stringify(data)
    const timestamp = String(NOW), nonce = randomBytes(18).toString('base64url')
    return { method, headers: { cookie, 'content-type': 'application/json', 'x-sam-session': body.sessionBinding,
      'x-sam-timestamp': timestamp, 'x-sam-nonce': nonce,
      'x-sam-signature': signature(device, requestSigningMessage(method, path, payload, timestamp, nonce, body.sessionBinding)),
    }, ...(payload ? { body: payload } : {}) }
  }
  return { ...body, cookie, signed }
}

describe('member platform integration', () => {
  it('closes public enrollment and research data at cutover even when email is not configured', async () => {
    const db = database()
    addSignup(db, { userId: 'Founder', email: 'founder@example.com' })
    const f = fixture(db, { enabled: true })
    expect((await f.post('/api/waitlist', { userId: 'Intruder', email: 'intruder@example.com', t: NOW - 3000 })).status).toBe(403)
    expect((await f.app.request('/api/markets')).status).toBe(401)
    expect((await f.app.request('/api/member/profile')).status).toBe(401)
    expect((await f.post('/api/membership/login', { email: 'founder@example.com', publicKey: browser().publicKey })).status).toBe(503)
    expect(await (await f.app.request('/api/membership/status')).json()).toMatchObject({ enabled: true, emailReady: false })
    await f.runtime.tick()
    expect(db.prepare('SELECT * FROM member_email_outbox').all()).toHaveLength(0)
    expect(db.prepare('SELECT * FROM waitlist').all()).toHaveLength(1)
    expect(db.prepare('SELECT verified_at FROM members').get()!.verified_at).toBeNull()
    expect((await f.app.request('/healthz')).status).toBe(200)
  })

  it('imports the waitlist once at activation and never reopens public entry on a missing or false flag', async () => {
    const db = database(), before = fixture(db)
    expect((await before.post('/api/waitlist', { userId: 'Founder', email: 'founder@example.com', t: NOW - 3000 })).status).toBe(201)
    expect(db.prepare('SELECT * FROM members').all()).toHaveLength(0)
    fixture(db, { enabled: true })
    expect(db.prepare('SELECT user_id FROM members').get()!.user_id).toBe('Founder')
    for (const config of [undefined, { enabled: false }]) {
      const after = fixture(db, config)
      expect((await after.post('/api/waitlist', { userId: 'NoBypass', email: 'no@example.com', t: NOW - 3000 })).status).toBe(403)
      expect((await after.app.request('/api/markets')).status).toBe(401)
      expect(await (await after.app.request('/api/membership/status')).json()).toMatchObject({ enabled: true, emailReady: false })
    }
    expect(db.prepare('SELECT * FROM members').all()).toHaveLength(1)
    expect(db.prepare('SELECT * FROM waitlist').all()).toHaveLength(1)
  })

  it('runs signed profile, invitation redemption and quest email transitions through the real mounts', async () => {
    const db = database(), sent: Array<{ to: string[]; subject: string; text: string }> = []
    addSignup(db, { userId: 'Founder', email: 'founder@example.com' })
    const f = fixture(db, deliveryConfig(sent))
    const founder = await enroll(f, db, browser(), 'founder@example.com')
    const profileRequest = founder.signed('/api/member/profile')
    const profile = await f.app.request('/api/member/profile', profileRequest)
    expect(profile.status).toBe(200)
    expect((await profile.json() as ProfileResponse).profile.referrals.remainingInvites).toBe(10)
    expect((await f.app.request('/api/member/profile', profileRequest)).status).toBe(401)
    const markets = await f.app.request('/api/markets', founder.signed('/api/markets'))
    expect(markets.status).toBe(200)
    expect(markets.headers.get('cache-control')).toBe('no-store')
    const issued = await f.app.request('/api/member/invites', founder.signed('/api/member/invites', 'POST', { email: 'guest@example.com' }))
    expect(issued.status).toBe(201)
    const invite = (await issued.json() as { invite: { token: string } }).invite
    const guest = await enroll(f, db, browser(), 'guest@example.com', { userId: 'Guest', inviteToken: invite.token })
    expect(guest.member.userId).toBe('Guest')
    const updated = await (await f.app.request('/api/member/profile', founder.signed('/api/member/profile'))).json() as ProfileResponse
    expect(updated.profile.referrals).toMatchObject({ directVerified: 1, remainingInvites: 9 })
    expect(updated.profile.quests[0]!.status).toBe('complete')
    expect(updated.profile.quests[1]!.status).toBe('active')
    expect(db.prepare('SELECT kind,state FROM member_email_outbox WHERE dedupe_key=?').get(`${founder.member.id}:first_referral_complete:v1`)).toMatchObject({ kind: 'quest_progression', state: 'queued' })
    const directory = await (await f.app.request('/api/member/directory', founder.signed('/api/member/directory'))).text()
    expect(directory).toContain('Founder')
    expect(directory).toContain('Guest')
    expect(directory).not.toContain('example.com')
    await f.runtime.tick()
    expect(sent.some(mail => mail.subject.includes('next SAM quest'))).toBe(true)
    expect(db.prepare("SELECT COUNT(*) n FROM member_email_outbox WHERE state!='accepted' OR body!=''").get()!.n).toBe(0)
    expect((await f.app.request('/api/member/devices', founder.signed('/api/member/devices'))).status).toBe(200)
    expect((await f.app.request('/api/member/invites', guest.signed('/api/member/invites'))).status).toBe(200)
  })

  it('does not let member sign-in unlock Discord or research before their prerequisites and services', async () => {
    const db = database(), sent: Array<{ to: string[]; subject: string; text: string }> = []
    addSignup(db, { userId: 'Founder', email: 'founder@example.com' })
    const f = fixture(db, deliveryConfig(sent)), account = await enroll(f, db, browser(), 'founder@example.com')
    const data = { entity: 'ACME', claim: 'A material revenue change is alleged.', sources: ['https://www.sec.gov/Archives/edgar/data/1/report.htm'],
      reasoning: 'The source should be checked against prior periods.', counterargument: 'The change might reflect a different period.', invalidation: 'A corrected source could contradict the claim.' }
    expect((await f.app.request('/api/member/research', account.signed('/api/member/research', 'POST', data))).status).toBe(403)
    expect(db.prepare('SELECT * FROM member_research').all()).toHaveLength(0)
    expect((await f.app.request('/api/member/discord/start', account.signed('/api/member/discord/start', 'POST'))).status).toBe(503)
    // OAuth callback deliberately lacks device auth; it must still fail closed without Discord config.
    expect((await f.app.request('/api/member/discord/callback?state=x&code=y')).status).toBe(503)
    expect((await f.post('/api/internal/research/claim', { limit: 1 })).status).toBe(503)
  })
})
