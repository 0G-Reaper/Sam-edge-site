import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { openDb, type Db } from '../server/db.js'
import { mountMemberDiscord, type DiscordMail, type MemberDiscordConfig } from '../server/member-discord.js'

const NOW = 1_800_000_000_000
const DISCORD_A = '111111111111111111'
const DISCORD_B = '222222222222222222'
const ROLE = '333333333333333333'
interface TestStatus { ready: boolean; missingConfig: string[]; state: string; discordUserId?: string }
const config: MemberDiscordConfig = {
  enabled: true, publicOrigin: 'https://sam.example', clientId: '1553172093393440808',
  clientSecret: 'test-client-secret', guildId: '1552864798889353218', botToken: 'test-bot-token',
  verifiedRoleId: ROLE, encryptionKey: Buffer.alloc(32, 7).toString('base64'),
}
const databases: Db[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function fixture(overrides: Partial<MemberDiscordConfig> = {}) {
  const db = openDb(':memory:'); databases.push(db)
  const app = new Hono()
  const emails: DiscordMail[] = []
  const awards: number[] = []
  const active = new Set([1, 2])
  const guild = new Map<string, { user: { id: string }; roles: string[]; pending: boolean }>()
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let pending = false, failRoleGrant = false, failRoleDelete = false, failJoin = false, clock = NOW
  let exchangeGate: Promise<void> | undefined
  let grantGate: Promise<void> | undefined, rejectAward = false
  const requireMember: MiddlewareHandler = async (c, next) => {
    const id = Number(c.req.header('x-member') ?? 1)
    if (!active.has(id)) return c.json({ error: 'forbidden' }, 403)
    c.set('member', { id, userId: `member${id}`, email: `member${id}@example.com`, sessionId: c.req.header('x-session') ?? `session-${id}` })
    await next()
  }
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    calls.push({ url: path, init })
    if (path.endsWith('/oauth2/token')) {
      if (exchangeGate) await exchangeGate
      const code = new URLSearchParams(init?.body as URLSearchParams).get('code')
      return Response.json({ access_token: `oauth-secret-${code}`, token_type: 'Bearer', expires_in: 3600, scope: 'identify guilds.join' })
    }
    if (path.endsWith('/users/@me')) {
      const auth = new Headers(init?.headers).get('authorization')
      const id = auth?.endsWith('-b') ? DISCORD_B : DISCORD_A
      return Response.json({ id, username: id === DISCORD_A ? 'astronomer' : 'techhead' })
    }
    const discordId = path.match(/\/members\/(\d+)/)?.[1]
    if (!discordId) throw new Error(`unexpected test route: ${path}`)
    if (path.includes('/roles/')) {
      if (init?.method === 'PUT') {
        if (grantGate) await grantGate
        if (failRoleGrant) return new Response('', { status: 503 })
        const user = guild.get(discordId)
        if (!user) return new Response('', { status: 404 })
        if (!user.roles.includes(ROLE)) user.roles.push(ROLE)
      } else {
        if (failRoleDelete) return new Response('', { status: 503 })
        const user = guild.get(discordId)
        if (user) user.roles = user.roles.filter((role) => role !== ROLE)
      }
      return new Response(null, { status: 204 })
    }
    if (init?.method === 'PUT') {
      if (failJoin) return new Response('', { status: 503 })
      expect(JSON.parse(String(init.body))).not.toHaveProperty('roles')
      if (!guild.has(discordId)) guild.set(discordId, { user: { id: discordId }, roles: [], pending })
      return new Response(null, { status: 204 })
    }
    return guild.has(discordId) ? Response.json(guild.get(discordId)) : new Response('', { status: 404 })
  }) as typeof fetch
  const controller = mountMemberDiscord(app, {
    db, config: { ...config, ...overrides }, requireMember, isMemberActive: (id) => active.has(id),
    enqueueMail: (_db, mail) => emails.push(mail), canStartDiscordQuest: (_db, id) => active.has(id),
    onDiscordVerified: (_db, id) => { if (rejectAward) throw new Error('quest identity mismatch'); awards.push(id) }, now: () => clock, fetchImpl,
  })
  const post = (path: string, body: Record<string, unknown> = {}, id = 1, session?: string) => app.request(`/api/member/discord/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-member': String(id), ...(session ? { 'x-session': session } : {}) }, body: JSON.stringify(body),
  })
  const state = async (id = 1) => {
    const res = await post('start', {}, id)
    expect(res.status).toBe(200)
    return new URL((await res.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')!
  }
  const link = async (id = 1, code = 'a') => {
    const res = await post('complete', { state: await state(id), code, discordUserId: 'attacker-supplied-id' }, id)
    expect(res.status).toBe(200)
    return new URL(emails.at(-1)!.text.match(/https:\/\/[^\s]+/)![0]).hash.split('discord_confirm=')[1]!
  }
  const getStatus = async (id = 1) => (await app.request('/api/member/discord/status', { headers: { 'x-member': String(id) } })).json() as Promise<TestStatus>
  return {
    db, app, post, state, link, getStatus, controller, emails, awards, calls, guild, active,
    setPending: (value: boolean) => { pending = value }, failGrant: (value: boolean) => { failRoleGrant = value },
    failDelete: (value: boolean) => { failRoleDelete = value }, failJoin: (value: boolean) => { failJoin = value },
    setClock: (value: number) => { clock = value }, setExchangeGate: (value: Promise<void>) => { exchangeGate = value },
    setGrantGate: (value: Promise<void>) => { grantGate = value }, rejectAward: () => { rejectAward = true },
  }
}

describe('member Discord linkage', () => {
  it('fails closed before operational permission review and exposes no secrets', async () => {
    const f = fixture({ enabled: false })
    const status = await f.getStatus()
    expect(status.ready).toBe(false)
    expect(status.missingConfig).toContain('DISCORD_MEMBER_ENABLED')
    expect(JSON.stringify(status)).not.toContain(config.botToken)
    expect((await f.post('start')).status).toBe(503)
    expect(f.calls).toHaveLength(0)
  })

  it('public callback only redirects fixed origin to a fragment; no exchange or email', async () => {
    const f = fixture()
    const state = await f.state()
    const response = await f.app.request(`/api/member/discord/callback?code=a&state=${state}&redirect_uri=https://evil.example`)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`https://sam.example/members#discord_code=a&discord_state=${state}`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(f.calls).toHaveLength(0)
    expect(f.emails).toHaveLength(0)
  })

  it('binds one-use OAuth state to the initiating authenticated member and session', async () => {
    const f = fixture()
    const state = await f.state()
    expect((await f.post('complete', { state, code: 'a' }, 2)).status).toBe(403)
    expect((await f.post('complete', { state, code: 'a' }, 1, 'other-session')).status).toBe(403)
    expect((await f.post('complete', { state, code: 'a' })).status).toBe(200)
    expect((await f.post('complete', { state, code: 'a' })).status).toBe(409)
    expect(f.emails).toHaveLength(1)
    expect(f.calls.filter((call) => call.url.endsWith('/oauth2/token'))).toHaveLength(1)
  })

  it('does not duplicate an exchange when completion is replayed concurrently', async () => {
    const f = fixture()
    let release!: () => void
    f.setExchangeGate(new Promise<void>((resolve) => { release = resolve }))
    const state = await f.state()
    const first = f.post('complete', { state, code: 'a' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await f.post('complete', { state, code: 'a' })).status).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(f.emails).toHaveLength(1)
  })

  it('uses provider identity, encrypts access token, and awaits explicit email confirmation', async () => {
    const f = fixture()
    const token = await f.link()
    const row = f.db.prepare('SELECT * FROM discord_member_links').get()!
    expect(row.discord_user_id).toBe(DISCORD_A)
    expect(JSON.stringify(row)).not.toContain('oauth-secret-a')
    expect(row.access_token_ciphertext).toBeTruthy()
    expect(row.confirmation_hash).not.toBe(token)
    expect(f.emails[0]!.to).toBe('member1@example.com')
    expect(f.guild.size).toBe(0)
    expect(f.awards).toHaveLength(0)
    expect((await f.post('confirm', { token }, 2)).status).toBe(409)
    const responses = await Promise.all([f.post('confirm', { token }), f.post('confirm', { token })])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect((await f.getStatus()).state).toBe('verified')
    expect(f.awards).toEqual([1])
    expect(f.db.prepare('SELECT access_token_ciphertext FROM discord_member_links').get()!.access_token_ciphertext).toBeNull()
    await f.post('refresh'); await f.controller.reconcile()
    expect(f.awards).toEqual([1])
  })

  it('holds Discord quest completion until screening and confirmed role grant succeed', async () => {
    const f = fixture(); f.setPending(true)
    await f.post('confirm', { token: await f.link() })
    expect((await f.getStatus()).state).toBe('pending_screening')
    expect(f.awards).toEqual([])
    expect(f.calls.some((call) => call.url.includes('/roles/'))).toBe(false)
    f.guild.get(DISCORD_A)!.pending = false
    f.failGrant(true)
    await f.post('refresh')
    expect((await f.getStatus()).state).toBe('pending_screening')
    expect(f.awards).toEqual([])
    f.failGrant(false)
    await Promise.all([f.post('refresh'), f.post('refresh')])
    expect((await f.getStatus()).state).toBe('verified')
    expect(f.awards).toEqual([1])
  })

  it('reserves each Discord identity for one member and blocks client-selected identities', async () => {
    const f = fixture()
    await f.link(1)
    const result = await f.post('complete', { state: await f.state(2), code: 'a' }, 2)
    expect(result.status).toBe(409)
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM discord_member_links').get()!.n).toBe(1)
    expect(f.emails).toHaveLength(1)
  })

  it('expires confirmations and removes abandoned encrypted tokens during reconciliation', async () => {
    const f = fixture()
    const token = await f.link()
    f.setClock(NOW + 16 * 60_000)
    expect((await f.post('confirm', { token })).status).toBe(409)
    await f.controller.reconcile()
    const row = f.db.prepare('SELECT * FROM discord_member_links').get()!
    expect(row.access_token_ciphertext).toBeNull()
    expect(row.confirmation_hash).toBeNull()
    expect(f.awards).toEqual([])
  })

  it('retains truthful pending revocation and retries after Discord recovers', async () => {
    const f = fixture()
    await f.post('confirm', { token: await f.link() })
    f.failDelete(true)
    await f.post('unlink')
    expect((await f.getStatus()).state).toBe('revocation_pending')
    expect(f.guild.get(DISCORD_A)!.roles).toContain(ROLE)
    expect((await f.post('start')).status).toBe(409)
    f.failDelete(false)
    await f.controller.reconcile()
    expect((await f.getStatus()).state).toBe('revoked')
    expect(f.guild.get(DISCORD_A)!.roles).not.toContain(ROLE)
  })

  it('revokes Discord access when membership becomes inactive', async () => {
    const f = fixture()
    await f.post('confirm', { token: await f.link() })
    f.active.delete(1)
    await f.controller.reconcile()
    expect(f.db.prepare('SELECT state FROM discord_member_links').get()!.state).toBe('revoked')
    expect(f.guild.get(DISCORD_A)!.roles).not.toContain(ROLE)
  })

  it('retries a temporary guild join failure without repeating the email confirmation', async () => {
    const f = fixture(); f.failJoin(true)
    await f.post('confirm', { token: await f.link() })
    expect((await f.getStatus()).state).toBe('join_retry')
    expect(f.awards).toEqual([])
    f.failJoin(false)
    await f.post('refresh')
    expect((await f.getStatus()).state).toBe('verified')
    expect(f.awards).toEqual([1])
    expect(f.emails).toHaveLength(1)
  })

  it('does not reassign permanent Discord identity after unlinking', async () => {
    const f = fixture()
    await f.post('confirm', { token: await f.link() })
    await f.post('unlink')
    const response = await f.post('complete', { state: await f.state(), code: 'b' })
    expect(response.status).toBe(409)
    expect((await f.getStatus()).discordUserId).toBe(DISCORD_A)
    expect(f.guild.has(DISCORD_B)).toBe(false)
  })

  it('removes a granted role if the quest ownership hook rejects completion', async () => {
    const f = fixture(); f.rejectAward()
    await f.post('confirm', { token: await f.link() })
    expect((await f.getStatus()).state).toBe('revoked')
    expect(f.guild.get(DISCORD_A)!.roles).not.toContain(ROLE)
    expect(f.awards).toEqual([])
  })

  it('serializes revocation after an already in-flight role grant', async () => {
    const f = fixture(); f.setPending(true)
    await f.post('confirm', { token: await f.link() })
    f.guild.get(DISCORD_A)!.pending = false
    let release!: () => void
    f.setGrantGate(new Promise<void>((resolve) => { release = resolve }))
    const refreshing = f.post('refresh')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await f.post('unlink')
    expect((await f.getStatus()).state).toBe('revocation_pending')
    expect((await f.post('start')).status).toBe(409)
    release()
    await refreshing
    expect((await f.getStatus()).state).toBe('revoked')
    expect(f.guild.get(DISCORD_A)!.roles).not.toContain(ROLE)
    expect(f.awards).toEqual([])
  })
})
