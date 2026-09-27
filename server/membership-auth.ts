import { createHash, createHmac, createPublicKey, randomBytes, randomInt, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import type { Hono, Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Db } from './db.js'
import { initializeMembershipSchema } from './membership-schema.js'

export interface MemberContext { id: number; userId: string; email: string; deviceId: string; sessionId: string }
export type MemberEnv = { Variables: { member: MemberContext } }
export interface MembershipMail { to: string; subject: string; text: string; kind: string; dedupeKey: string; memberId?: number }
export interface MembershipAuthOptions {
  db: Db; enabled: boolean; emailReady: boolean; discordReady?: boolean; now?: () => number
  enqueueMail?: (mail: MembershipMail) => void
  validateInvite?: (token: string, email: string) => boolean
  /** Synchronous hooks run inside the same transaction as member creation/verification. */
  onMemberCreated?: (memberId: number, inviteToken: string) => void
  onMemberVerified?: (memberId: number) => void
}
type MemberRow = { id: number; user_id: string; email: string; verified_at: string | null; disabled_at: string | null }
type Challenge = { id: string; member_id: number | null; user_id: string | null; email: string; invite_token: string | null; public_key_jwk: string; public_key_hash: string; nonce: string; code_hash: string; device_label: string; expires_at: number; attempts: number; consumed_at: number | null }
const COOKIE = '__Host-sam_member'
const CODE_TTL = 10 * 60_000
const SESSION_TTL = 7 * 86_400_000
const USER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/
const PublicKey = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
const StartBody = z.object({
  email: z.email().max(254).transform(s => s.toLowerCase()),
  userId: z.string().min(2).max(32).regex(USER_ID).optional(),
  inviteToken: z.string().min(16).max(128).optional(),
  publicKey: PublicKey,
  deviceLabel: z.string().trim().min(1).max(80).default('Registered browser'),
})
const VerifyBody = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{8}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/) })

export const memberHash = (value: string) => createHash('sha256').update(value).digest('hex')
export function deviceKeyHash(jwk: { kty: string; crv: string; x: string; y: string }): string {
  return memberHash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}
export function verificationMessage(challengeId: string, nonce: string, code: string, keyHash: string): string {
  return ['SAM-VERIFY-v1', challengeId, nonce, code, keyHash].join('\n')
}
export function requestSigningMessage(method: string, path: string, body: string, timestamp: string, nonce: string, sessionBinding: string): string {
  return ['SAM-MEMBER-v1', sessionBinding, method.toUpperCase(), path, memberHash(body), timestamp, nonce].join('\n')
}
function verifySignature(jwk: string, payload: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: JSON.parse(jwk), format: 'jwk' })
    return verify('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  } catch { return false }
}
function sameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = c.req.header('origin')
  if (!origin) return true
  try { return new URL(origin).host === (c.req.header('host') ?? new URL(c.req.url).host) } catch { return false }
}
function authError(c: Context, message = 'Please sign in from a registered browser.') {
  return c.json({ ok: false, error: 'unauthorized', message }, 401)
}
function limited(db: Db, key: string, max: number, now: number): boolean {
  db.prepare(`INSERT INTO membership_auth_limits(key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN window_start <= ? THEN 1 ELSE count+1 END,
      window_start=CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END`).run(key, now, now - CODE_TTL, now - CODE_TTL)
  return (db.prepare('SELECT count FROM membership_auth_limits WHERE key=?').get(key) as { count: number }).count > max
}

async function readBoundedBody(request: Request, maxBytes = 128 * 1024): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > maxBytes) return null
  const reader = request.clone().body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0, body = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return body + decoder.decode()
      size += part.value.byteLength
      if (size > maxBytes) { void reader.cancel().catch(() => {}); return null }
      body += decoder.decode(part.value, { stream: true })
    }
  } catch { return null }
}

/** Sessions only work together with possession of the registered nonextractable browser key. */
export function requireMember(opts: { db: Db; now?: () => number; enabled?: boolean }): MiddlewareHandler<MemberEnv> {
  return async (c, next) => {
    c.header('Cache-Control', 'no-store')
    if (opts.enabled === false) return c.json({ ok: false, error: 'membership_unavailable' }, 503)
    if (!sameOrigin(c)) return authError(c)
    const token = getCookie(c, COOKIE)
    const ts = c.req.header('x-sam-timestamp') ?? ''
    const nonce = c.req.header('x-sam-nonce') ?? ''
    const signature = c.req.header('x-sam-signature') ?? ''
    const now = (opts.now ?? Date.now)()
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\d{13}$/.test(ts) || Math.abs(now - Number(ts)) > 60_000 || !/^[A-Za-z0-9_-]{22,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{80,100}$/.test(signature)) return authError(c)
    const sessionId = memberHash(token)
    if (c.req.header('x-sam-session') !== sessionId) return authError(c)
    const row = opts.db.prepare(`SELECT m.id, m.user_id, m.email, s.device_id, d.public_key_jwk
      FROM membership_sessions s JOIN members m ON m.id=s.member_id JOIN membership_devices d ON d.id=s.device_id
      WHERE s.id=? AND s.expires_at>? AND s.revoked_at IS NULL AND d.revoked_at IS NULL
      AND m.disabled_at IS NULL AND m.verified_at IS NOT NULL`).get(sessionId, now) as { id: number; user_id: string; email: string; device_id: string; public_key_jwk: string } | undefined
    if (!row) return authError(c)
    const url = new URL(c.req.url)
    const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await readBoundedBody(c.req.raw)
    if (body === null) return c.json({ ok: false, error: 'body_too_large' }, 413)
    if (!verifySignature(row.public_key_jwk, requestSigningMessage(c.req.method, url.pathname + url.search, body, ts, nonce, sessionId), signature)) return authError(c)
    opts.db.prepare('DELETE FROM membership_request_nonces WHERE expires_at < ?').run(now)
    try { opts.db.prepare('INSERT INTO membership_request_nonces(session_id,nonce,expires_at) VALUES (?,?,?)').run(sessionId, nonce, now + 120_000) } catch { return authError(c, 'This request was already used. Please try again.') }
    opts.db.prepare('UPDATE membership_devices SET last_used_at=? WHERE id=?').run(now, row.device_id)
    c.set('member', { id: row.id, userId: row.user_id, email: row.email, deviceId: row.device_id, sessionId })
    await next()
  }
}

export function revokeDevice(db: Db, memberId: number, deviceId: string, now = Date.now()): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('UPDATE membership_devices SET revoked_at=? WHERE id=? AND member_id=? AND revoked_at IS NULL').run(now, deviceId, memberId)
    db.prepare('UPDATE membership_sessions SET revoked_at=? WHERE device_id=? AND member_id=? AND revoked_at IS NULL').run(now, deviceId, memberId)
    if (result.changes) db.prepare('INSERT INTO membership_audit(member_id,event,detail,created_at) VALUES (?,?,?,?)').run(memberId, 'device_revoked', deviceId, now)
    db.exec('COMMIT')
    return Boolean(result.changes)
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function mountMembershipAuth(app: Hono, opts: MembershipAuthOptions): void {
  const now = opts.now ?? Date.now
  initializeMembershipSchema(opts.db, now(), opts.enabled)
  const secret = (opts.db.prepare('SELECT value FROM membership_secrets WHERE name=?').get('otp-hmac-v1') as { value: string }).value
  const codeHash = (id: string, code: string) => createHmac('sha256', secret).update(`${id}:${code}`).digest('hex')
  const generic = 'If these details can be used, a verification code has been emailed. It expires in 10 minutes.'
  app.get('/api/membership/status', c => c.json({ enabled: opts.enabled, emailReady: Boolean(opts.emailReady && opts.enqueueMail), discordReady: Boolean(opts.discordReady) }))
  for (const mode of ['signup', 'login'] as const) {
    app.post(`/api/membership/${mode}`, bodyLimit({ maxSize: 8192 }), async c => {
      if (!opts.enabled || !opts.emailReady || !opts.enqueueMail) return c.json({ ok: false, error: 'email_unavailable', message: 'Membership email is not available yet. Please try again later.' }, 503)
      if (!sameOrigin(c)) return c.json({ ok: false, error: 'forbidden' }, 403)
      let parsed
      try { parsed = StartBody.safeParse(await c.req.json()) } catch { return c.json({ ok: false, error: 'invalid' }, 400) }
      if (!parsed.success || (mode === 'signup' && (!parsed.data.userId || !parsed.data.inviteToken))) return c.json({ ok: false, error: 'invalid', message: 'Check your email, UserID and invitation.' }, 400)
      const data = parsed.data
      try { createPublicKey({ key: data.publicKey, format: 'jwk' }) } catch { return c.json({ ok: false, error: 'invalid_key' }, 400) }
      const ip = (c.req.header('x-forwarded-for') ?? 'local').split(',').at(-1)!.trim()
      const at = now()
      const ipLimited = limited(opts.db, `ip:${memberHash(ip)}`, 12, at)
      const emailLimited = limited(opts.db, `email:${memberHash(data.email)}`, 3, at)
      if (ipLimited || emailLimited) { c.header('Retry-After', '600'); return c.json({ ok: false, error: 'rate_limited', message: 'Please wait before requesting another code.' }, 429) }
      const id = randomUUID(), nonce = randomBytes(32).toString('base64url'), code = String(randomInt(0, 100_000_000)).padStart(8, '0')
      const member = opts.db.prepare('SELECT * FROM members WHERE email=? COLLATE NOCASE').get(data.email) as MemberRow | undefined
      const canLogin = mode === 'login' && member && !member.disabled_at
      const canSignup = mode === 'signup' && !member && !opts.db.prepare('SELECT 1 FROM members WHERE user_id=? COLLATE NOCASE').get(data.userId!) && Boolean(opts.onMemberCreated)
      if (canLogin || canSignup) {
        opts.db.exec('BEGIN IMMEDIATE')
        try {
          if (canSignup && opts.validateInvite && !opts.validateInvite(data.inviteToken!, data.email)) {
            opts.db.exec('COMMIT')
            return c.json({ ok: true, challengeId: id, nonce, message: generic }, 202)
          }
          // Only the newest email challenge remains valid. Auth codes are never logged or stored in plaintext here.
          opts.db.prepare('UPDATE membership_challenges SET consumed_at=? WHERE email=? AND consumed_at IS NULL').run(at, data.email)
          opts.db.prepare(`INSERT INTO membership_challenges(id,member_id,email,user_id,invite_token,public_key_jwk,public_key_hash,nonce,code_hash,device_label,created_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, member?.id ?? null, data.email, data.userId ?? null, data.inviteToken ?? null, JSON.stringify(data.publicKey), deviceKeyHash(data.publicKey), nonce, codeHash(id, code), data.deviceLabel, at, at + CODE_TTL)
          opts.enqueueMail({ to: data.email, subject: 'Your SAM membership verification code', text: `Your SAM verification code is ${code}. It expires in 10 minutes.\n\nThis code signs in and registers this browser if a slot is available. Each member can register two browsers. Never forward a code. If you did not request this, ignore this email.`, kind: 'membership_code', dedupeKey: `membership-code:${id}`, ...(member ? { memberId: member.id } : {}) })
          opts.db.exec('COMMIT')
        } catch { opts.db.exec('ROLLBACK'); return c.json({ ok: false, error: 'email_unavailable', message: 'We could not queue your email. Please try again later.' }, 503) }
      }
      return c.json({ ok: true, challengeId: id, nonce, message: generic }, 202)
    })
  }
  app.post('/api/membership/verify', bodyLimit({ maxSize: 4096 }), async c => {
    if (!opts.enabled || !opts.emailReady || !opts.enqueueMail) return c.json({ ok: false, error: 'email_unavailable' }, 503)
    if (!sameOrigin(c)) return authError(c)
    let parsed
    try { parsed = VerifyBody.safeParse(await c.req.json()) } catch { return authError(c, 'The code could not be verified.') }
    if (!parsed.success) return authError(c, 'The code could not be verified.')
    const { challengeId, code, signature } = parsed.data
    const at = now()
    opts.db.exec('BEGIN IMMEDIATE')
    try {
      const ch = opts.db.prepare('SELECT * FROM membership_challenges WHERE id=?').get(challengeId) as Challenge | undefined
      if (!ch || ch.consumed_at || ch.expires_at <= at || ch.attempts >= 5) { opts.db.exec('COMMIT'); return authError(c, 'The code is invalid or expired. Request a new code.') }
      opts.db.prepare('UPDATE membership_challenges SET attempts=attempts+1 WHERE id=?').run(ch.id)
      const hash = codeHash(ch.id, code)
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(ch.code_hash)) || !verifySignature(ch.public_key_jwk, verificationMessage(ch.id, ch.nonce, code, ch.public_key_hash), signature)) { opts.db.exec('COMMIT'); return authError(c, 'The code could not be verified.') }
      let member: MemberRow
      if (ch.member_id) {
        const found = opts.db.prepare('SELECT * FROM members WHERE id=? AND disabled_at IS NULL').get(ch.member_id) as MemberRow | undefined
        if (!found) { opts.db.exec('COMMIT'); return authError(c) }
        member = found
      } else {
        if (!ch.user_id || !ch.invite_token || !opts.onMemberCreated) { opts.db.exec('COMMIT'); return authError(c) }
        const inserted = opts.db.prepare('INSERT INTO members(user_id,email,created_at) VALUES(?,?,?)').run(ch.user_id, ch.email, new Date(at).toISOString())
        const id = Number(inserted.lastInsertRowid)
        opts.onMemberCreated(id, ch.invite_token)
        member = opts.db.prepare('SELECT * FROM members WHERE id=?').get(id) as MemberRow
      }
      const existing = opts.db.prepare('SELECT id, revoked_at FROM membership_devices WHERE member_id=? AND public_key_hash=?').get(member.id, ch.public_key_hash) as { id: string; revoked_at: number | null } | undefined
      const activeCount = (opts.db.prepare('SELECT COUNT(*) AS n FROM membership_devices WHERE member_id=? AND revoked_at IS NULL').get(member.id) as { n: number }).n
      if ((!existing || existing.revoked_at !== null) && activeCount >= 2) { opts.db.exec('ROLLBACK'); return c.json({ ok: false, error: 'device_limit', message: 'Two browsers are already registered. Remove a lost browser from another registered browser, or contact member support for recovery.' }, 409) }
      const deviceId = existing?.id ?? randomUUID()
      if (existing) opts.db.prepare('UPDATE membership_devices SET revoked_at=NULL,last_used_at=?,label=? WHERE id=?').run(at, ch.device_label, deviceId)
      else opts.db.prepare('INSERT INTO membership_devices(id,member_id,public_key_hash,public_key_jwk,label,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)').run(deviceId, member.id, ch.public_key_hash, ch.public_key_jwk, ch.device_label, at, at)
      const firstVerification = !member.verified_at
      if (firstVerification) {
        opts.db.prepare('UPDATE members SET verified_at=? WHERE id=?').run(new Date(at).toISOString(), member.id)
        opts.onMemberVerified?.(member.id)
        opts.enqueueMail({ to: member.email, memberId: member.id, subject: `Welcome to SAM, ${member.user_id}`, kind: 'membership_welcome', dedupeKey: `membership-welcome:${member.id}`, text: `Your SAM UserID is ${member.user_id}.\n\nYour verified profile tracks your invitations, quests, titles and collectible badges. Your first quest is to welcome someone you trust using one of your 10 personal invitations. Open your profile for progress and the next step.\n\nUserIDs are public; your email and login codes are private. Invite rewards are community recognition, with no cash value or investment promise. Two registered browsers can access your account. Browser storage is your device credential; clearing it does not release a slot.\n\nResearch claims must be checked against cited evidence. SAM is a developing research platform, not a promise of returns.` })
      }
      opts.db.prepare('UPDATE membership_challenges SET consumed_at=? WHERE id=?').run(at, ch.id)
      const token = randomBytes(32).toString('base64url')
      opts.db.prepare('UPDATE membership_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(at, deviceId)
      opts.db.prepare('INSERT INTO membership_sessions(id,member_id,device_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(memberHash(token), member.id, deviceId, at, at + SESSION_TTL)
      opts.db.prepare('INSERT INTO membership_audit(member_id,event,detail,created_at) VALUES(?,?,?,?)').run(member.id, 'browser_signin', deviceId, at)
      opts.db.exec('COMMIT')
      setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_TTL / 1000 })
      return c.json({ ok: true, member: { id: member.id, userId: member.user_id, email: member.email }, deviceId, sessionBinding: memberHash(token) })
    } catch { opts.db.exec('ROLLBACK'); return c.json({ ok: false, error: 'verification_failed', message: 'We could not complete verification. Your invitation may have been used; request a new code or invitation.' }, 409) }
  })
  const authed = requireMember(opts)
  app.post('/api/membership/logout', authed, c => {
    const member = c.get('member' as never) as MemberContext
    opts.db.prepare('UPDATE membership_sessions SET revoked_at=? WHERE id=?').run(now(), member.sessionId)
    deleteCookie(c, COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict' })
    return c.json({ ok: true })
  })
  app.get('/api/member/devices', authed, c => {
    const member = c.get('member' as never) as MemberContext
    const rows = opts.db.prepare('SELECT id,label,created_at,last_used_at FROM membership_devices WHERE member_id=? AND revoked_at IS NULL ORDER BY created_at').all(member.id) as Array<{ id: string; label: string; created_at: number; last_used_at: number }>
    return c.json({ devices: rows.map(row => ({ id: row.id, label: row.label, createdAt: new Date(row.created_at).toISOString(), lastUsedAt: new Date(row.last_used_at).toISOString(), current: row.id === member.deviceId })), limit: 2 })
  })
  app.delete('/api/member/devices/:id', authed, c => {
    const member = c.get('member' as never) as MemberContext
    if (c.req.param('id') === member.deviceId) return c.json({ ok: false, error: 'current_device', message: 'Keep this browser registered. Remove a different browser.' }, 409)
    if (!revokeDevice(opts.db, member.id, c.req.param('id'), now())) return c.json({ ok: false, error: 'not_found' }, 404)
    return c.json({ ok: true })
  })
}
