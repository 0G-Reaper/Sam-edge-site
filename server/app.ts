import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import type { Db } from './db.js'
import { addSignup, allSignups, countSignups } from './db.js'
import { memberKey } from './keys.js'
import type { MarketsPayload } from './markets.js'
import { RateLimiter } from './ratelimit.js'

export interface SiteConfig {
  instagram?: string
  discord?: string
}

export interface AppOptions {
  db: Db
  markets: () => Promise<MarketsPayload>
  adminToken?: string
  site?: SiteConfig
  indexHtml?: string
  /** Directory of built client files, relative to the process working directory. */
  staticRoot?: string
  production?: boolean
  /** The one public hostname; every other Host is redirected to it (the health check excepted). */
  canonicalHost?: string
  /** A mailto: or https: URI published at /.well-known/security.txt (RFC 9116). */
  securityContact?: string
  now?: () => number
}

const MIN_FORM_MS = 2_500
const MAX_FORM_MS = 24 * 60 * 60_000

const USER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/

const SignupBody = z.object({
  userId: z
    .string()
    .trim()
    .transform((s) => s.replace(/^@+/, ''))
    .pipe(z.string().min(2, 'User ID needs at least 2 characters.').max(32, 'User ID is too long.').regex(USER_ID, 'Use letters, numbers, dots, dashes or underscores.')),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')).pipe(z.string().max(254)),
  website: z.string().max(2048).optional(),
  t: z.number().int().nonnegative(),
})

export function createApp(opts: AppOptions) {
  const now = opts.now ?? Date.now
  const site: SiteConfig = opts.site ?? {}
  const app = new Hono()

  const apiLimiter = new RateLimiter(120, 60_000)
  const signupLimiter = new RateLimiter(5, 10 * 60_000)
  const adminLimiter = new RateLimiter(20, 60_000)

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        ...(opts.production ? { upgradeInsecureRequests: [] } : {}),
      },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
      referrerPolicy: 'strict-origin-when-cross-origin',
      xFrameOptions: 'DENY',
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
      crossOriginEmbedderPolicy: false,
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
        usb: [],
      },
    }),
  )

  app.get('/healthz', (c) => c.text('ok'))

  // One public origin: the www form, the platform's own domain and any forged Host header are all
  // sent to the canonical host, so links, the canonical tag and HSTS agree on a single origin.
  if (opts.canonicalHost) {
    const canonical = opts.canonicalHost.toLowerCase()
    app.use('*', async (c, next) => {
      const host = (c.req.header('host') ?? '').toLowerCase().replace(/:\d+$/, '')
      if (host === canonical || c.req.path === '/healthz') return next()
      const url = new URL(c.req.url)
      return c.redirect(`https://${canonical}${url.pathname}${url.search}`, 301)
    })
  }

  if (opts.securityContact) {
    app.get('/.well-known/security.txt', (c) => {
      const lines = [`Contact: ${opts.securityContact}`, `Expires: ${new Date(now() + 365 * 86_400_000).toISOString()}`, 'Preferred-Languages: en']
      if (opts.canonicalHost) lines.push(`Canonical: https://${opts.canonicalHost.toLowerCase()}/.well-known/security.txt`)
      c.header('Cache-Control', 'public, max-age=86400')
      return c.text(lines.join('\n') + '\n')
    })
  }

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const rl = apiLimiter.check(clientIp(c), now())
    if (!rl.ok) return tooMany(c, rl.retryAfter)
    await next()
  })

  app.get('/api/markets', async (c) => {
    try {
      const payload = await opts.markets()
      c.header('Cache-Control', 'public, max-age=300')
      return c.json(payload)
    } catch {
      return c.json({ ok: false, error: 'unavailable' }, 503)
    }
  })

  app.post('/api/waitlist', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const rl = signupLimiter.check(clientIp(c), now())
    if (!rl.ok) return tooMany(c, rl.retryAfter)
    if (!sameOrigin(c)) return c.json({ ok: false, error: 'forbidden', message: 'Cross-site requests are not accepted.' }, 403)
    const contentType = (c.req.header('content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) return invalid(c, 'Send JSON.')
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return invalid(c, 'Send valid JSON.')
    }
    const parsed = SignupBody.safeParse(raw)
    if (!parsed.success) return invalid(c, parsed.error.issues[0]?.message ?? 'Check the form and try again.')
    const { userId, email, website, t } = parsed.data
    const age = now() - t
    if (website || age < MIN_FORM_MS || age > MAX_FORM_MS) {
      // Bots get a convincing answer and nothing is stored.
      return c.json({ ok: true, status: 'created', key: memberKey(), userId }, 201)
    }
    const result = addSignup(opts.db, { userId, email })
    switch (result.status) {
      case 'created':
        return c.json({ ok: true, status: 'created', key: result.key, userId }, 201)
      case 'existing':
        return c.json({ ok: true, status: 'existing', message: 'You are already on the list. Your member key was shown when you first joined.' })
      case 'taken':
        return c.json({ ok: false, error: 'taken', message: 'That user ID is already taken. Try another.' }, 409)
    }
  })

  app.get('/api/admin/export.csv', (c) => {
    const rl = adminLimiter.check(clientIp(c), now())
    if (!rl.ok || !authed(c, opts.adminToken)) return notFound(c)
    const rows = allSignups(opts.db)
    const csv = toCsv(
      ['user_id', 'email', 'member_key', 'joined_at'],
      rows.map((r) => [r.user_id, r.email, r.user_key, r.created_at]),
    )
    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header('Content-Disposition', 'attachment; filename="waitlist.csv"')
    return c.body(csv)
  })

  app.get('/api/admin/stats', (c) => {
    const rl = adminLimiter.check(clientIp(c), now())
    if (!rl.ok || !authed(c, opts.adminToken)) return notFound(c)
    return c.json({ ok: true, signups: countSignups(opts.db) })
  })

  app.all('/api/*', (c) => notFound(c))

  const html = (c: Context) => {
    if (!opts.indexHtml) return c.text('Not found', 404)
    c.header('Cache-Control', 'no-cache')
    return c.html(renderIndex(opts.indexHtml, site, originOf(c, opts.production === true)))
  }
  app.get('/', html)
  app.get('/index.html', html)

  if (opts.staticRoot) {
    app.use(
      '/*',
      serveStatic({
        root: opts.staticRoot,
        onFound: (path, c) => {
          c.header('Cache-Control', cacheFor(path))
        },
      }),
    )
  }

  app.get('*', (c) => {
    const path = c.req.path
    if (path.includes('.')) return c.text('Not found', 404)
    return html(c)
  })

  return app
}

function invalid(c: Context, message: string) {
  return c.json({ ok: false, error: 'invalid', message }, 400)
}

function notFound(c: Context) {
  return c.json({ ok: false, error: 'not found' }, 404)
}

function tooMany(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json({ ok: false, error: 'rate_limited', message: 'Too many requests. Please wait a moment.', retryAfter }, 429)
}

/** Railway's edge appends the real client address as the last X-Forwarded-For entry. */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last) return last
  }
  return 'local'
}

function sameOrigin(c: Context): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = c.req.header('origin')
  if (origin) {
    try {
      return new URL(origin).host === c.req.header('host')
    } catch {
      return false
    }
  }
  return true
}

function authed(c: Context, token: string | undefined): boolean {
  if (!token) return false
  const m = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')
  if (!m) return false
  const given = Buffer.from(m[1]!)
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function toCsv(header: string[], rows: string[][]): string {
  const cell = (v: string) => {
    let s = v
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}` // neutralise spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`
  }
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

function cacheFor(path: string): string {
  if (path.includes('/assets/')) return 'public, max-age=31536000, immutable'
  if (/\/(art|film|models|globe|audio|icons)\//.test(path)) return 'public, max-age=2592000'
  return 'public, max-age=3600'
}

function originOf(c: Context, production: boolean): string {
  const rawHost = c.req.header('host') ?? 'localhost'
  const host = /^[A-Za-z0-9.:-]{1,253}$/.test(rawHost) ? rawHost : 'localhost'
  const forwarded = (c.req.header('x-forwarded-proto') ?? '').split(',')[0]!.trim()
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : production ? 'https' : 'http'
  return `${proto}://${host}`
}

const rendered = new Map<string, string>()

export function renderIndex(template: string, site: SiteConfig, origin: string): string {
  const cacheKey = origin
  const hit = rendered.get(cacheKey)
  if (hit) return hit
  const config = JSON.stringify({ instagram: site.instagram ?? '', discord: site.discord ?? '' }).replace(/</g, '\\u003c')
  const out = template.replaceAll('__ORIGIN__', origin).replace('__SITE_CONFIG__', config)
  if (rendered.size > 32) rendered.clear()
  rendered.set(cacheKey, out)
  return out
}
