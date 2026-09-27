import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { addSignup, openDb, type Db } from '../server/db.js'
import { mountMembershipAuth, requestSigningMessage, verificationMessage, deviceKeyHash, memberHash, revokeDevice, type MembershipMail, type MembershipAuthOptions } from '../server/membership-auth.js'
import { initializeMembershipSchema } from '../server/membership-schema.js'

type Browser = ReturnType<typeof browser>
function browser() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = pair.publicKey.export({ format: 'jwk' })
  return { ...pair, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } }
}
function signature(device: Browser, payload: string) { return sign('sha256', Buffer.from(payload), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }

describe('membership security', () => {
  let db: Db
  let app: Hono
  let at: number
  let mails: MembershipMail[]
  let build: (extra?: Partial<MembershipAuthOptions>) => Hono
  beforeEach(() => {
    at = 1_800_000_000_000
    db = openDb(':memory:')
    addSignup(db, { userId: 'Founder', email: 'founder@example.com' })
    mails = []
    build = (extra = {}) => {
      const instance = new Hono()
      mountMembershipAuth(instance, { db, enabled: true, emailReady: true, now: () => at, enqueueMail: mail => { mails.push(mail) }, ...extra })
      return instance
    }
    app = build()
  })
  async function start(device: Browser, extra: Record<string, unknown> = {}, mode = 'login') {
    const res = await app.request(`/api/membership/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'founder@example.com', publicKey: device.publicKeyJwk, ...extra }) })
    const challenge = await res.json() as { challengeId: string; nonce: string; message: string }
    const code = mails.at(-1)?.text.match(/code is (\d{8})/)?.[1] ?? '00000000'
    return { res, challenge, code }
  }
  async function finish(device: Browser, auth: Awaited<ReturnType<typeof start>>, code = auth.code) {
    return app.request('/api/membership/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: auth.challenge.challengeId, code, signature: signature(device, verificationMessage(auth.challenge.challengeId, auth.challenge.nonce, code, deviceKeyHash(device.publicKeyJwk))) }) })
  }
  async function login(device: Browser) {
    const auth = await start(device)
    const res = await finish(device, auth)
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '', value: await res.json() as { deviceId: string; member: { userId: string } } }
  }
  function signed(device: Browser, cookie: string, path = '/api/member/devices', method = 'GET', body = '') {
    const timestamp = String(at), nonce = randomBytes(18).toString('base64url')
    const sessionBinding = memberHash(cookie.split('=')[1] ?? '')
    return { method, headers: { cookie, 'content-type': 'application/json', 'x-sam-timestamp': timestamp, 'x-sam-nonce': nonce, 'x-sam-session': sessionBinding, 'x-sam-signature': signature(device, requestSigningMessage(method, path, body, timestamp, nonce, sessionBinding)) }, ...(body ? { body } : {}) }
  }

  it('preserves original identities and secret keys, imports once, and never resurrects deleted members', () => {
    const original = db.prepare('SELECT * FROM waitlist').get() as Record<string, unknown>
    const imported = db.prepare('SELECT * FROM members').get() as Record<string, unknown>
    expect(imported.id).toBe(original.id)
    expect(imported.user_id).toBe(original.user_id)
    expect(imported.email).toBe(original.email)
    expect(imported.verified_at).toBeNull()
    expect(imported.user_key).toBeUndefined()
    db.prepare('DELETE FROM members').run()
    initializeMembershipSchema(db, at)
    expect(db.prepare('SELECT * FROM members').all()).toHaveLength(0)
    expect(db.prepare('SELECT * FROM waitlist').get()).toEqual(original)
  })
  it('defers bootstrap until activation so intervening waitlist records are preserved', () => {
    const staged = openDb(':memory:')
    initializeMembershipSchema(staged, at, false)
    addSignup(staged, { userId: 'BeforeActivation', email: 'later@example.com' })
    expect(staged.prepare('SELECT * FROM members').all()).toHaveLength(0)
    initializeMembershipSchema(staged, at, true)
    expect(staged.prepare('SELECT user_id FROM members').get()).toEqual({ user_id: 'BeforeActivation' })
  })
  it('fails closed without email transport and offers no login bypass', async () => {
    app = build({ emailReady: false })
    expect((await start(browser())).res.status).toBe(503)
    expect(db.prepare('SELECT * FROM membership_sessions').all()).toHaveLength(0)
    expect(mails).toHaveLength(0)
  })
  it('does not disclose whether the requested email or UserID exists', async () => {
    const known = await start(browser())
    const unknown = await start(browser(), { email: 'missing@example.com' })
    expect(known.res.status).toBe(202)
    expect(unknown.res.status).toBe(202)
    expect(known.challenge.message).toBe(unknown.challenge.message)
    expect(mails).toHaveLength(1)
    expect((await finish(browser(), unknown)).status).toBe(401)
  })
  it('uses expiring hashed codes and requires key possession even with the correct email code', async () => {
    const device = browser()
    const auth = await start(device)
    const row = db.prepare('SELECT * FROM membership_challenges').get() as Record<string, unknown>
    expect(JSON.stringify(row)).not.toContain(auth.code)
    expect((await finish(browser(), auth)).status).toBe(401)
    at += 10 * 60_000
    expect((await finish(device, auth)).status).toBe(401)
    expect(db.prepare('SELECT * FROM membership_sessions').all()).toHaveLength(0)
  })
  it('locks the challenge after five incorrect attempts', async () => {
    const device = browser(), auth = await start(device)
    const wrong = auth.code === '00000000' ? '11111111' : '00000000'
    for (let i = 0; i < 5; i++) expect((await finish(device, auth, wrong)).status).toBe(401)
    expect((await finish(device, auth)).status).toBe(401)
    expect((db.prepare('SELECT attempts FROM membership_challenges').get() as { attempts: number }).attempts).toBe(5)
  })
  it('atomically caps registrations at two and storage clearing does not bypass the quota', async () => {
    expect((await login(browser())).res.status).toBe(200)
    expect((await login(browser())).res.status).toBe(200)
    const third = browser(), auth = await start(third)
    const results = await Promise.all([finish(third, auth), finish(third, auth)])
    expect(results.map(r => r.status)).toEqual([409, 409])
    expect((db.prepare('SELECT COUNT(*) AS n FROM membership_devices WHERE revoked_at IS NULL').get() as { n: number }).n).toBe(2)
  })
  it('sets a secure HttpOnly strict cookie and reuses the same browser slot', async () => {
    const device = browser()
    const first = await login(device)
    expect(first.res.status).toBe(200)
    expect(first.res.headers.get('set-cookie')).toMatch(/__Host-sam_member=.*HttpOnly.*Secure.*SameSite=Strict/i)
    expect(first.value.member.userId).toBe('Founder')
    const again = await login(device)
    expect(again.value.deviceId).toBe(first.value.deviceId)
    expect(db.prepare('SELECT * FROM membership_devices').all()).toHaveLength(1)
    expect((await app.request('/api/member/devices', signed(device, first.cookie))).status).toBe(401)
  })
  it('rejects stolen cookies, replayed signatures, altered payloads and unauthorized mutation', async () => {
    const device = browser(), session = await login(device)
    expect((await app.request('/api/member/devices')).status).toBe(401)
    expect((await app.request('/api/member/devices', { headers: { cookie: session.cookie } })).status).toBe(401)
    expect((await app.request('/api/member/devices', signed(browser(), session.cookie))).status).toBe(401)
    const request = signed(device, session.cookie)
    expect((await app.request('/api/member/devices', request)).status).toBe(200)
    expect((await app.request('/api/member/devices', request)).status).toBe(401)
    const logout = signed(device, session.cookie, '/api/membership/logout', 'POST', '{}')
    logout.body = '{"altered":true}'
    expect((await app.request('/api/membership/logout', logout)).status).toBe(401)
    expect((await app.request(`/api/member/devices/${session.value.deviceId}`, { method: 'DELETE' })).status).toBe(401)
  })
  it('rejects cross-site, stale signed requests and consumed verification codes', async () => {
    const device = browser(), auth = await start(device), verified = await finish(device, auth)
    expect(verified.status).toBe(200)
    expect((await finish(device, auth)).status).toBe(401)
    const cookie = verified.headers.get('set-cookie')!.split(';')[0]!
    const request = signed(device, cookie)
    expect((await app.request('/api/member/devices', { ...request, headers: { ...request.headers, origin: 'https://attacker.example' } })).status).toBe(401)
    at += 61_000
    expect((await app.request('/api/member/devices', request)).status).toBe(401)
  })
  it('binds request signatures to a particular session and expires sessions', async () => {
    const device = browser(), first = await login(device)
    const oldProof = signed(device, first.cookie)
    const second = await login(device)
    oldProof.headers.cookie = second.cookie
    oldProof.headers['x-sam-session'] = memberHash(second.cookie.split('=')[1]!)
    expect((await app.request('/api/member/devices', oldProof)).status).toBe(401)
    at += 7 * 86_400_000
    expect((await app.request('/api/member/devices', signed(device, second.cookie))).status).toBe(401)
  })
  it('rejects oversized authenticated bodies before buffering beyond the fixed limit', async () => {
    const device = browser(), session = await login(device)
    const body = 'x'.repeat(128 * 1024 + 1)
    expect((await app.request('/api/membership/logout', signed(device, session.cookie, '/api/membership/logout', 'POST', body))).status).toBe(413)
  })
  it('revokes sessions immediately with device revocation or member disablement', async () => {
    const device = browser(), session = await login(device)
    expect(revokeDevice(db, 1, session.value.deviceId, at)).toBe(true)
    expect((await app.request('/api/member/devices', signed(device, session.cookie))).status).toBe(401)
    const other = browser(), newSession = await login(other)
    db.prepare('UPDATE members SET disabled_at=? WHERE id=1').run(new Date(at).toISOString())
    expect((await app.request('/api/member/devices', signed(other, newSession.cookie))).status).toBe(401)
  })
  it('only consumes invites and creates members after verified email, with rollback on invalid invite', async () => {
    let redemptions = 0
    app = build({ validateInvite: () => true, onMemberCreated: () => { redemptions++; throw new Error('invite_used') } })
    const device = browser()
    const auth = await start(device, { email: 'new@example.com', userId: 'NewMember', inviteToken: 'valid-looking-invite-token' }, 'signup')
    expect(auth.res.status).toBe(202)
    expect(redemptions).toBe(0)
    expect(db.prepare('SELECT * FROM members').all()).toHaveLength(1)
    expect((await finish(device, auth)).status).toBe(409)
    expect(redemptions).toBe(1)
    expect(db.prepare('SELECT * FROM members').all()).toHaveLength(1)
    expect(db.prepare('SELECT * FROM membership_devices').all()).toHaveLength(0)
  })
  it('rolls back enrollment when durable welcome email cannot be queued', async () => {
    app = build({ enqueueMail: mail => { if (mail.kind === 'membership_welcome') throw new Error('disk full'); mails.push(mail) } })
    const device = browser(), auth = await start(device)
    expect((await finish(device, auth)).status).toBe(409)
    expect(db.prepare('SELECT * FROM membership_devices').all()).toHaveLength(0)
    expect((db.prepare('SELECT verified_at FROM members').get() as { verified_at: string | null }).verified_at).toBeNull()
  })
})
