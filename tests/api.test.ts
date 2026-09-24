import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { openDb, type Db } from '../server/db.js'
import { KEY_PATTERN, memberKey } from '../server/keys.js'
import { getMarkets, resetMarketsCache, type MarketsPayload } from '../server/markets.js'
import { RateLimiter } from '../server/ratelimit.js'

const RENDERED_AT = 1_800_000_000_000
const NOW = RENDERED_AT + 10_000

function fakeMarkets(): MarketsPayload {
  return {
    asOf: new Date(NOW).toISOString(),
    items: [{ key: 'DJI', name: 'Dow Jones', dates: ['2026-09-23'], closes: [1], last: 1, changePct: 0, source: 'live' }],
  }
}

function build(db: Db, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    db,
    markets: async () => fakeMarkets(),
    adminToken: 'test-admin-token',
    site: { instagram: 'https://instagram.com/example' },
    indexHtml: '<html><head><meta property="og:image" content="__ORIGIN__/og.jpg"></head><script id="site-config" type="application/json">__SITE_CONFIG__</script></html>',
    now: () => NOW,
    ...extra,
  })
}

function signup(app: ReturnType<typeof createApp>, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.request('/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': headers.ip ?? '203.0.113.7', ...headers },
    body: JSON.stringify({ t: RENDERED_AT, ...body }),
  })
}

describe('member keys', () => {
  it('have the documented shape and do not repeat', () => {
    const keys = new Set(Array.from({ length: 200 }, () => memberKey()))
    expect(keys.size).toBe(200)
    for (const k of keys) expect(k).toMatch(KEY_PATTERN)
  })
})

describe('waitlist', () => {
  let db: Db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('stores a signup and returns a member key', async () => {
    const app = build(db)
    const res = await signup(app, { userId: '@sam_fan', email: 'Fan@Example.com' })
    expect(res.status).toBe(201)
    const json = (await res.json()) as { key: string; userId: string; status: string }
    expect(json.status).toBe('created')
    expect(json.userId).toBe('sam_fan')
    expect(json.key).toMatch(KEY_PATTERN)
    const rows = db.prepare('SELECT user_id, email, user_key FROM waitlist').all() as Array<Record<string, string>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.email).toBe('fan@example.com')
    expect(rows[0]!.user_key).toBe(json.key)
  })

  it('never mints a second key for the same email', async () => {
    const app = build(db)
    await signup(app, { userId: 'one', email: 'dup@example.com' })
    const res = await signup(app, { userId: 'two', email: 'DUP@example.com' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { status: string; key?: string }
    expect(json.status).toBe('existing')
    expect(json.key).toBeUndefined()
    expect((db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as { n: number }).n).toBe(1)
  })

  it('refuses a user ID that someone else holds', async () => {
    const app = build(db)
    await signup(app, { userId: 'Taken', email: 'a@example.com' })
    const res = await signup(app, { userId: 'taken', email: 'b@example.com' })
    expect(res.status).toBe(409)
  })

  it('validates the fields', async () => {
    const app = build(db)
    expect((await signup(app, { userId: 'x', email: 'a@example.com' })).status).toBe(400)
    expect((await signup(app, { userId: 'fine', email: 'not-an-email' })).status).toBe(400)
    expect((await signup(app, { userId: 'bad id!', email: 'a@example.com' })).status).toBe(400)
    const wrongType = await app.request('/api/waitlist', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })
    expect(wrongType.status).toBe(400)
  })

  it('stores nothing when the honeypot is filled or the form was submitted instantly', async () => {
    const app = build(db)
    const bot = await signup(app, { userId: 'bot', email: 'bot@example.com', website: 'http://spam' })
    expect(bot.status).toBe(201)
    const fast = await signup(app, { userId: 'fast', email: 'fast@example.com', t: NOW - 100 })
    expect(fast.status).toBe(201)
    expect((db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as { n: number }).n).toBe(0)
  })

  it('rejects cross-site submissions', async () => {
    const app = build(db)
    const res = await signup(app, { userId: 'x_site', email: 'x@example.com' }, { origin: 'https://evil.example', host: 'sam.example' })
    expect(res.status).toBe(403)
    const res2 = await signup(app, { userId: 'x_site', email: 'x@example.com' }, { 'sec-fetch-site': 'cross-site' })
    expect(res2.status).toBe(403)
  })

  it('rate limits repeated signups from one address', async () => {
    const app = build(db)
    for (let i = 0; i < 5; i++) {
      const res = await signup(app, { userId: `user${i}`, email: `u${i}@example.com` }, { ip: '198.51.100.9' })
      expect(res.status).toBe(201)
    }
    const res = await signup(app, { userId: 'user9', email: 'u9@example.com' }, { ip: '198.51.100.9' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('admin export', () => {
  it('is invisible without the token and works with it', async () => {
    const db = openDb(':memory:')
    const app = build(db)
    await signup(app, { userId: 'export_me', email: 'e@example.com' })
    expect((await app.request('/api/admin/export.csv')).status).toBe(404)
    expect((await app.request('/api/admin/export.csv', { headers: { authorization: 'Bearer wrong' } })).status).toBe(404)
    const ok = await app.request('/api/admin/export.csv', { headers: { authorization: 'Bearer test-admin-token' } })
    expect(ok.status).toBe(200)
    const csv = await ok.text()
    expect(csv.split('\r\n')[0]).toBe('"user_id","email","member_key","joined_at"')
    expect(csv).toContain('"export_me","e@example.com","SAM-')
    const stats = await app.request('/api/admin/stats', { headers: { authorization: 'Bearer test-admin-token' } })
    expect(await stats.json()).toEqual({ ok: true, signups: 1 })
  })

  it('stays hidden when no token is configured', async () => {
    const app = build(openDb(':memory:'), { adminToken: undefined })
    const res = await app.request('/api/admin/stats', { headers: { authorization: 'Bearer anything' } })
    expect(res.status).toBe(404)
  })

  it('neutralises spreadsheet formulas in exports', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO waitlist (user_id, email, user_key) VALUES (?, ?, ?)').run('=cmd', 'x@example.com', 'SAM-0000-0000-0000-0000')
    const app = build(db)
    const csv = await (await app.request('/api/admin/export.csv', { headers: { authorization: 'Bearer test-admin-token' } })).text()
    expect(csv).toContain(`"'=cmd"`)
  })
})

describe('pages and headers', () => {
  it('redirects every other hostname to the canonical one, except the health check', async () => {
    const app = build(openDb(':memory:'), { canonicalHost: 'sam.example' })
    const res = await app.request('/how?x=1', { headers: { host: 'www.sam.example' } })
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://sam.example/how?x=1')
    expect((await app.request('/api/markets', { headers: { host: 'web-production.up.railway.app' } })).status).toBe(301)
    expect((await app.request('/', { headers: { host: 'sam.example' } })).status).toBe(200)
    expect((await app.request('/healthz', { headers: { host: 'healthcheck.internal' } })).status).toBe(200)
  })

  it('publishes security.txt only when a contact is configured', async () => {
    expect((await build(openDb(':memory:')).request('/.well-known/security.txt')).status).toBe(404)
    const app = build(openDb(':memory:'), { canonicalHost: 'sam.example', securityContact: 'mailto:security@sam.example' })
    const res = await app.request('/.well-known/security.txt', { headers: { host: 'sam.example' } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Contact: mailto:security@sam.example')
    expect(text).toContain('Canonical: https://sam.example/.well-known/security.txt')
    expect(text).toMatch(/Expires: \d{4}-/)
  })

  it('serves the shell with the site config and absolute origin filled in', async () => {
    const app = build(openDb(':memory:'))
    const res = await app.request('/', { headers: { host: 'sam.example', 'x-forwarded-proto': 'https' } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('content="https://sam.example/og.jpg"')
    expect(html).toContain('"instagram":"https://instagram.com/example"')
    expect(html).toContain('"discord":""')
  })

  it('sends a strict security header set', async () => {
    const app = build(openDb(':memory:'))
    const res = await app.request('/api/markets')
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('http://')
    expect(res.headers.get('strict-transport-security')).toContain('max-age=63072000')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('answers unknown API paths with 404 and unknown pages with the shell', async () => {
    const app = build(openDb(':memory:'))
    expect((await app.request('/api/nope')).status).toBe(404)
    expect((await app.request('/some/deep/link')).status).toBe(200)
    expect((await app.request('/missing.png')).status).toBe(404)
  })
})

describe('markets', () => {
  beforeEach(() => resetMarketsCache())

  it('falls back to labelled sample data when no source answers', async () => {
    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const payload = await getMarkets({ fetchImpl: failing, now: () => NOW })
    expect(payload.items.map((i) => i.key)).toEqual(['DJI', 'IXIC', 'RUT'])
    for (const item of payload.items) {
      expect(item.source).toBe('illustrative')
      expect(item.closes).toHaveLength(30)
    }
  })

  it('parses a CSV source and marks it live', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')},1,2,0,${100 + i},10`)
    const csv = ['Date,Open,High,Low,Close,Volume', ...rows].join('\n')
    const fetchImpl = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch
    const payload = await getMarkets({ fetchImpl, now: () => NOW })
    const dji = payload.items[0]!
    expect(dji.source).toBe('live')
    expect(dji.closes).toHaveLength(30)
    expect(dji.last).toBe(139)
    expect(dji.changePct).toBeCloseTo((139 - 138) / 138 * 100, 6)
  })
})

describe('rate limiter', () => {
  it('opens again once the window passes', () => {
    const rl = new RateLimiter(2, 1000)
    expect(rl.check('a', 0).ok).toBe(true)
    expect(rl.check('a', 10).ok).toBe(true)
    expect(rl.check('a', 20).ok).toBe(false)
    expect(rl.check('a', 1100).ok).toBe(true)
  })
})
