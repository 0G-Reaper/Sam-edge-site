import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Db } from './db.js'

const API = 'https://discord.com/api/v10'
const FLOW_MS = 15 * 60_000
const SNOWFLAKE = /^\d{17,20}$/
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')

export interface DiscordMember {
  id: number
  userId: string
  email: string
  sessionId: string
}

export interface MemberDiscordConfig {
  enabled: boolean
  publicOrigin?: string
  clientId: string
  clientSecret?: string
  guildId: string
  botToken?: string
  verifiedRoleId?: string
  encryptionKey?: string
}

export interface DiscordMail {
  to: string
  subject: string
  text: string
  kind: string
  dedupeKey: string
  memberId: number
}

export interface MemberDiscordOptions {
  db: Db
  requireMember: MiddlewareHandler
  isMemberActive: (memberId: number) => boolean
  enqueueMail: (db: Db, mail: DiscordMail, now: number) => unknown
  canStartDiscordQuest: (db: Db, memberId: number) => boolean
  onDiscordVerified: (db: Db, memberId: number, discordId: string, now: number) => void
  config?: MemberDiscordConfig
  now?: () => number
  fetchImpl?: typeof fetch
}

type LinkState = 'email_pending' | 'joining' | 'join_retry' | 'pending_screening' | 'verified' | 'revocation_pending' | 'revoked'
interface Link {
  member_id: number
  discord_user_id: string
  discord_username: string
  state: LinkState
  confirmation_hash: string | null
  confirmation_expires_at: number
  email_confirmed_at: number | null
  access_token_ciphertext: string | null
  access_token_expires_at: number
  verified_at: number | null
  updated_at: number
  lease_until: number
}
interface Flow { member_id: number; session_hash: string; expires_at: number; status: string }
interface GuildMember { user?: { id?: string }; pending?: boolean; roles?: string[] }

export function discordConfigFromEnv(env = process.env): MemberDiscordConfig {
  return {
    enabled: env.DISCORD_MEMBER_ENABLED === 'true',
    publicOrigin: env.MEMBER_PUBLIC_ORIGIN,
    clientId: env.DISCORD_CLIENT_ID ?? '1553172093393440808',
    clientSecret: env.DISCORD_CLIENT_SECRET,
    guildId: env.DISCORD_GUILD_ID ?? '1552864798889353218',
    botToken: env.DISCORD_BOT_TOKEN,
    verifiedRoleId: env.DISCORD_VERIFIED_ROLE_ID,
    encryptionKey: env.DISCORD_TOKEN_ENCRYPTION_KEY,
  }
}

function validOrigin(raw?: string): string | undefined {
  try {
    const url = new URL(raw ?? '')
    return url.protocol === 'https:' && url.origin === raw && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}

export function discordReadiness(config: MemberDiscordConfig) {
  const missingConfig: string[] = []
  if (!config.enabled) missingConfig.push('DISCORD_MEMBER_ENABLED')
  if (!validOrigin(config.publicOrigin)) missingConfig.push('MEMBER_PUBLIC_ORIGIN')
  if (!SNOWFLAKE.test(config.clientId)) missingConfig.push('DISCORD_CLIENT_ID')
  if (!config.clientSecret) missingConfig.push('DISCORD_CLIENT_SECRET')
  if (!SNOWFLAKE.test(config.guildId)) missingConfig.push('DISCORD_GUILD_ID')
  if (!config.botToken) missingConfig.push('DISCORD_BOT_TOKEN')
  if (!SNOWFLAKE.test(config.verifiedRoleId ?? '')) missingConfig.push('DISCORD_VERIFIED_ROLE_ID')
  if (!config.encryptionKey || !/^[A-Za-z0-9+/]{43}=$/.test(config.encryptionKey) || Buffer.from(config.encryptionKey, 'base64').length !== 32) {
    missingConfig.push('DISCORD_TOKEN_ENCRYPTION_KEY')
  }
  return { ready: missingConfig.length === 0, missingConfig }
}

export function initializeMemberDiscord(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_oauth_flows (
      state_hash TEXT PRIMARY KEY,
      member_id INTEGER NOT NULL,
      session_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','exchanging','used','failed'))
    );
    CREATE INDEX IF NOT EXISTS discord_flows_member ON discord_oauth_flows(member_id);
    CREATE TABLE IF NOT EXISTS discord_member_links (
      member_id INTEGER PRIMARY KEY,
      discord_user_id TEXT NOT NULL UNIQUE,
      discord_username TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('email_pending','joining','join_retry','pending_screening','verified','revocation_pending','revoked')),
      confirmation_hash TEXT UNIQUE,
      confirmation_expires_at INTEGER NOT NULL,
      email_confirmed_at INTEGER,
      access_token_ciphertext TEXT,
      access_token_expires_at INTEGER NOT NULL,
      verified_at INTEGER,
      updated_at INTEGER NOT NULL,
      lease_until INTEGER NOT NULL DEFAULT 0
    );
  `)
}

function encrypt(value: string, key: string, memberId: number, discordId: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv)
  cipher.setAAD(Buffer.from(`${memberId}:${discordId}`))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.')
}

function decrypt(link: Link, key: string) {
  const [iv, tag, ciphertext] = (link.access_token_ciphertext ?? '').split('.').map((part) => Buffer.from(part, 'base64url'))
  if (!iv || !tag || !ciphertext) throw new Error('missing encrypted access token')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv)
  decipher.setAAD(Buffer.from(`${link.member_id}:${link.discord_user_id}`))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

const member = (c: Context) => c.get('member') as DiscordMember
const readLink = (db: Db, id: number) => db.prepare('SELECT * FROM discord_member_links WHERE member_id=?').get(id) as unknown as Link | undefined
const noStore = (c: Context) => { c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer') }
const error = (c: Context, code: string, status: 400 | 403 | 409 | 503 = 400) => c.json({ ok: false, error: code }, status)

async function jsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  if (!(c.req.header('content-type') ?? '').startsWith('application/json')) return undefined
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined
  } catch { return undefined }
}

/** Attach before the application's catch-all /api route. Authentication verifies signed member fetches. */
export function mountMemberDiscord(app: Hono, opts: MemberDiscordOptions) {
  initializeMemberDiscord(opts.db)
  const { db } = opts
  const now = opts.now ?? Date.now
  const config = opts.config ?? discordConfigFromEnv()
  const fetcher = opts.fetchImpl ?? fetch
  const ready = () => discordReadiness(config)
  const redirectUri = () => `${config.publicOrigin}/api/member/discord/callback`
  const status = (id: number) => {
    const link = readLink(db, id)
    return {
      ok: true, ...ready(), state: link?.state ?? 'not_linked',
      discordUserId: link?.discord_user_id, discordUsername: link?.discord_username,
      verifiedAt: link?.verified_at ?? undefined,
      questEligible: opts.canStartDiscordQuest(db, id),
    }
  }
  const active = (id: number) => opts.isMemberActive(id) && opts.canStartDiscordQuest(db, id)

  async function discord(path: string, init: RequestInit = {}) {
    return fetcher(`${API}${path}`, {
      ...init, signal: AbortSignal.timeout(12_000), redirect: 'error',
      headers: { authorization: `Bot ${config.botToken}`, ...init.headers },
    })
  }

  async function readGuildMember(link: Link): Promise<GuildMember | undefined> {
    const response = await discord(`/guilds/${config.guildId}/members/${link.discord_user_id}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error('guild lookup unavailable')
    const value = await response.json() as GuildMember
    if (value.user?.id !== link.discord_user_id || !Array.isArray(value.roles)) throw new Error('invalid guild member')
    return value
  }

  async function revoke(id: number) {
    const link = readLink(db, id)
    if (!link || link.state === 'revoked') return
    db.prepare(`UPDATE discord_member_links SET state='revocation_pending', access_token_ciphertext=NULL,
      confirmation_hash=NULL, updated_at=? WHERE member_id=?`).run(now(), id)
    // An in-flight role grant owns this lease. Let it finish, then compensate; otherwise
    // a DELETE could race ahead of its PUT and falsely report completed revocation.
    if (link.lease_until > now()) return
    // Do not drop the binding until Discord confirms the role is absent.
    try {
      const res = await discord(`/guilds/${config.guildId}/members/${link.discord_user_id}/roles/${config.verifiedRoleId}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) return
      const current = await readGuildMember(link)
      if (current?.roles?.includes(config.verifiedRoleId!)) return
      db.prepare("UPDATE discord_member_links SET state='revoked', lease_until=0, updated_at=? WHERE member_id=? AND state='revocation_pending'").run(now(), id)
    } catch { /* Durable pending row is the retry queue. Never claim revocation succeeded. */ }
  }

  async function finish(id: number) {
    let link = readLink(db, id)
    if (!link || link.state === 'revoked') return
    if (link.state === 'revocation_pending' || !active(id)) return revoke(id)
    if (link.state === 'verified' || !link.email_confirmed_at) return
    // Serialize network workers. A crashed worker can be reclaimed after one minute.
    const claim = db.prepare(`UPDATE discord_member_links SET lease_until=?, state=CASE WHEN access_token_ciphertext IS NOT NULL THEN 'joining' ELSE 'pending_screening' END
      WHERE member_id=? AND lease_until<=? AND state IN ('joining','join_retry','pending_screening')`).run(now() + 60_000, id, now())
    if (!claim.changes) return
    try {
      link = readLink(db, id)!
      if (link.access_token_ciphertext) {
        if (link.access_token_expires_at <= now()) throw new Error('link expired')
        const response = await discord(`/guilds/${config.guildId}/members/${link.discord_user_id}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: decrypt(link, config.encryptionKey!) }),
        })
        if (!response.ok) throw new Error('guild join unavailable')
        db.prepare("UPDATE discord_member_links SET access_token_ciphertext=NULL, state='pending_screening' WHERE member_id=? AND state='joining'").run(id)
      }
      let current = await readGuildMember(link)
      // Discord may return pending=true until the user accepts its server rules.
      if (!current || current.pending !== false) return
      if (!active(id) || readLink(db, id)?.state === 'revocation_pending') return revoke(id)
      if (!current.roles!.includes(config.verifiedRoleId!)) {
        const response = await discord(`/guilds/${config.guildId}/members/${link.discord_user_id}/roles/${config.verifiedRoleId}`, { method: 'PUT' })
        if (!response.ok) throw new Error('role grant unavailable')
        current = await readGuildMember(link)
      }
      if (current?.pending !== false || !current.roles?.includes(config.verifiedRoleId!)) return
      if (!active(id) || readLink(db, id)?.state === 'revocation_pending') return revoke(id)
      db.exec('SAVEPOINT discord_verified')
      try {
        const changed = db.prepare(`UPDATE discord_member_links SET state='verified', verified_at=COALESCE(verified_at,?),
          access_token_ciphertext=NULL, lease_until=0, updated_at=? WHERE member_id=? AND state='pending_screening'`).run(now(), now(), id)
        if (changed.changes) opts.onDiscordVerified(db, id, link.discord_user_id, now())
        db.exec('RELEASE SAVEPOINT discord_verified')
      } catch (cause) {
        db.exec('ROLLBACK TO SAVEPOINT discord_verified'); db.exec('RELEASE SAVEPOINT discord_verified')
        // A rejected quest proof must not leave a newly granted access role behind.
        db.prepare("UPDATE discord_member_links SET state='revocation_pending', updated_at=? WHERE member_id=?").run(now(), id)
        throw cause
      }
    } catch {
      db.prepare(`UPDATE discord_member_links SET state=CASE WHEN access_token_ciphertext IS NOT NULL THEN 'join_retry' ELSE 'pending_screening' END,
        updated_at=? WHERE member_id=? AND state IN ('joining','pending_screening')`).run(now(), id)
    } finally {
      db.prepare('UPDATE discord_member_links SET lease_until=0 WHERE member_id=?').run(id)
      if (readLink(db, id)?.state === 'revocation_pending') await revoke(id)
    }
  }

  app.get('/api/member/discord/status', opts.requireMember, (c) => { noStore(c); return c.json(status(member(c).id)) })

  app.post('/api/member/discord/start', opts.requireMember, (c) => {
    noStore(c)
    if (!ready().ready) return error(c, 'discord_unavailable', 503)
    const m = member(c)
    if (!active(m.id)) return error(c, 'complete_first_quest', 403)
    const existing = readLink(db, m.id)
    if (existing && existing.state !== 'revoked') return error(c, 'discord_link_exists', 409)
    const state = secret()
    // New starts invalidate prior starts, including tabs opened on the same account.
    db.prepare("UPDATE discord_oauth_flows SET status='failed' WHERE member_id=? AND status IN ('started','exchanging')").run(m.id)
    db.prepare('INSERT INTO discord_oauth_flows(state_hash,member_id,session_hash,expires_at,status) VALUES (?,?,?,?,?)')
      .run(digest(state), m.id, digest(m.sessionId), now() + FLOW_MS, 'started')
    const url = new URL('https://discord.com/oauth2/authorize')
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'identify guilds.join', state, prompt: 'consent' }).toString()
    return c.json({ ok: true, authorizationUrl: url.href })
  })

  // A browser OAuth redirect cannot carry our request signature. It performs no exchange or linking.
  app.get('/api/member/discord/callback', (c) => {
    noStore(c)
    if (!ready().ready) return error(c, 'discord_unavailable', 503)
    const code = c.req.query('code') ?? ''
    const state = c.req.query('state') ?? ''
    if (!TOKEN.test(state) || !code || code.length > 2048 || c.req.query('error')) {
      return c.redirect(`${config.publicOrigin}/members#discord_error=authorization_failed`, 303)
    }
    const fragment = new URLSearchParams({ discord_code: code, discord_state: state })
    return c.redirect(`${config.publicOrigin}/members#${fragment}`, 303)
  })

  app.post('/api/member/discord/complete', bodyLimit({ maxSize: 4096 }), opts.requireMember, async (c) => {
    noStore(c)
    if (!ready().ready) return error(c, 'discord_unavailable', 503)
    const m = member(c)
    const body = await jsonBody(c)
    if (typeof body?.state !== 'string' || !TOKEN.test(body.state) || typeof body.code !== 'string' || !body.code || body.code.length > 2048) return error(c, 'invalid_oauth_response')
    const stateHash = digest(body.state)
    const flow = db.prepare('SELECT * FROM discord_oauth_flows WHERE state_hash=?').get(stateHash) as unknown as Flow | undefined
    if (!flow || flow.member_id !== m.id || flow.session_hash !== digest(m.sessionId) || flow.expires_at <= now() || !active(m.id)) return error(c, 'invalid_oauth_state', 403)
    const claim = db.prepare("UPDATE discord_oauth_flows SET status='exchanging' WHERE state_hash=? AND status='started'").run(stateHash)
    if (!claim.changes) return error(c, 'oauth_state_already_used', 409)
    try {
      const exchanged = await fetcher('https://discord.com/api/oauth2/token', {
        method: 'POST', signal: AbortSignal.timeout(12_000), redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret!, grant_type: 'authorization_code', code: body.code, redirect_uri: redirectUri() }),
      })
      if (!exchanged.ok) throw new Error('exchange failed')
      const token = await exchanged.json() as { access_token?: string; expires_in?: number; scope?: string; token_type?: string }
      const scopes = token.scope?.split(' ') ?? []
      if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in! <= 0 || token.token_type?.toLowerCase() !== 'bearer' || !scopes.includes('identify') || !scopes.includes('guilds.join')) throw new Error('invalid token')
      const response = await fetcher(`${API}/users/@me`, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(12_000), redirect: 'error' })
      if (!response.ok) throw new Error('identity unavailable')
      const identity = await response.json() as { id?: string; username?: string }
      if (!SNOWFLAKE.test(identity.id ?? '') || typeof identity.username !== 'string') throw new Error('invalid identity')
      if (!active(m.id)) throw new Error('membership changed')
      const latestFlow = db.prepare('SELECT status FROM discord_oauth_flows WHERE state_hash=?').get(stateHash) as { status: string }
      if (latestFlow.status !== 'exchanging') throw new Error('superseded flow')
      const previous = readLink(db, m.id)
      // Quest identity is permanent. Unlink revokes access; it does not transfer an
      // account's earned identity to a different Discord account.
      if (previous && previous.discord_user_id !== identity.id) throw new Error('discord identity change requires reviewed recovery')
      const confirmation = secret()
      const expires = now() + Math.min(FLOW_MS, token.expires_in! * 1000)
      const ciphertext = encrypt(token.access_token, config.encryptionKey!, m.id, identity.id!)
      db.exec('SAVEPOINT discord_link')
      try {
        // Retain revoked rows until an explicit new link; no silent account reassignment.
        db.prepare("DELETE FROM discord_member_links WHERE member_id=? AND state='revoked'").run(m.id)
        db.prepare(`INSERT INTO discord_member_links(member_id,discord_user_id,discord_username,state,confirmation_hash,
          confirmation_expires_at,access_token_ciphertext,access_token_expires_at,updated_at) VALUES (?,?,?,'email_pending',?,?,?,?,?)`)
          .run(m.id, identity.id!, identity.username.slice(0, 100), digest(confirmation), expires, ciphertext, expires, now())
        opts.enqueueMail(db, {
          to: m.email, memberId: m.id, kind: 'discord_confirmation', dedupeKey: `discord-link:${stateHash}`,
          subject: 'SAM — confirm your Discord connection',
          text: `UserID: ${m.userId}\n\nYou requested to connect Discord account ${identity.username.slice(0, 100)} (${identity.id}).\n\nDiscord Verification Completion Button:\n${config.publicOrigin}/members#discord_confirm=${confirmation}\n\nAre you prepared for what comes next? After email confirmation and Discord server screening, your next quest is to contribute evidence and earn research points. Completion is tracked in your profile.\n\nThis link expires in 15 minutes or sooner if the authorization expires. If this was not you, do not confirm it.`,
        }, now())
        db.prepare("UPDATE discord_oauth_flows SET status='used' WHERE state_hash=?").run(stateHash)
        db.exec('RELEASE SAVEPOINT discord_link')
      } catch (cause) { db.exec('ROLLBACK TO SAVEPOINT discord_link'); db.exec('RELEASE SAVEPOINT discord_link'); throw cause }
      return c.json({ ok: true, state: 'email_pending', message: 'Check your verified email to confirm this Discord account.' })
    } catch {
      db.prepare("UPDATE discord_oauth_flows SET status='failed' WHERE state_hash=?").run(stateHash)
      return error(c, 'discord_link_not_completed', 409)
    }
  })

  app.post('/api/member/discord/confirm', bodyLimit({ maxSize: 1024 }), opts.requireMember, async (c) => {
    noStore(c)
    if (!ready().ready) return error(c, 'discord_unavailable', 503)
    const m = member(c)
    const body = await jsonBody(c)
    if (typeof body?.token !== 'string' || !TOKEN.test(body.token) || !active(m.id)) return error(c, 'invalid_confirmation', 403)
    const claimed = db.prepare(`UPDATE discord_member_links SET state='joining', confirmation_hash=NULL, email_confirmed_at=?, updated_at=?
      WHERE member_id=? AND state='email_pending' AND confirmation_hash=? AND confirmation_expires_at>?`)
      .run(now(), now(), m.id, digest(body.token), now())
    if (!claimed.changes) return error(c, 'confirmation_expired_or_used', 409)
    await finish(m.id)
    return c.json(status(m.id))
  })

  app.post('/api/member/discord/refresh', opts.requireMember, async (c) => {
    noStore(c)
    if (!ready().ready) return error(c, 'discord_unavailable', 503)
    await finish(member(c).id)
    return c.json(status(member(c).id))
  })

  app.post('/api/member/discord/unlink', opts.requireMember, async (c) => {
    noStore(c)
    // Recording pending revocation remains possible during a provider/configuration outage.
    const id = member(c).id
    db.prepare("UPDATE discord_member_links SET state='revocation_pending', confirmation_hash=NULL, access_token_ciphertext=NULL, updated_at=? WHERE member_id=? AND state!='revoked'").run(now(), id)
    if (ready().ready) await revoke(id)
    return c.json(status(id))
  })

  return {
    readiness: ready,
    /** Call from a server-owned scheduled worker; never expose to unauthenticated clients. */
    async reconcile(limit = 25) {
      if (!ready().ready) return { ready: false, processed: 0 }
      const rows = db.prepare("SELECT member_id,state FROM discord_member_links WHERE state NOT IN ('revoked','email_pending') ORDER BY updated_at LIMIT ?")
        .all(Math.max(1, Math.min(100, limit))) as Array<{ member_id: number; state: LinkState }>
      for (const row of rows) {
        if (!active(row.member_id) || row.state === 'revocation_pending') await revoke(row.member_id)
        else if (row.state !== 'verified') await finish(row.member_id)
        db.prepare('UPDATE discord_member_links SET updated_at=? WHERE member_id=?').run(now(), row.member_id)
      }
      // Erase expired OAuth secrets, including abandoned email confirmations.
      db.prepare('UPDATE discord_member_links SET access_token_ciphertext=NULL, confirmation_hash=NULL WHERE access_token_expires_at<=?').run(now())
      db.prepare('DELETE FROM discord_oauth_flows WHERE expires_at<=?').run(now())
      return { ready: true, processed: rows.length }
    },
  }
}
