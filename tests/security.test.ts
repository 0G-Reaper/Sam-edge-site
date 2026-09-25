import { describe, expect, it } from 'vitest'
import { createApp } from '../server/app.js'
import { openDb } from '../server/db.js'
import { isProbe } from '../server/security.js'

const TOKEN = 'correct-horse-battery-staple-0123456789'
const DAY = 24 * 60 * 60_000

function setup() {
  let clock = 1_800_000_000_000
  const events: Array<Record<string, string>> = []
  const app = createApp({
    db: openDb(':memory:'),
    markets: async () => ({ asOf: new Date(clock).toISOString(), items: [] }),
    adminToken: TOKEN,
    indexHtml: '<html></html>',
    now: () => clock,
    onSecurityEvent: (event, fields) => events.push({ event, ...fields }),
  })
  const get = (path: string, ip: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { 'x-forwarded-for': ip, ...headers } })
  return { get, events, advance: (ms: number) => (clock += ms) }
}

describe('scanner tripwire', () => {
  it('flags secret files, VCS metadata, server scripts and CMS panels, and nothing the site serves', () => {
    const probes = [
      '/.env', '/.env.production.local', '/app/.env', '/.git/config', '/.git-credentials', '/.aws/credentials',
      '/.vscode/sftp.json', '/wp-login.php', '/wp-admin/', '/api/phpinfo.php', '/_profiler/phpinfo', '/privkey.pem',
      '/database.sql', '/wp-config.php.bak', '/%2eenv', '/cgi-bin/luci',
    ]
    const served = [
      '/', '/index.html', '/how', '/robots.txt', '/sitemap.xml', '/favicon.svg', '/favicon.ico', '/icons/apple-touch-icon.png',
      '/assets/index-Cw3hZfl9.js', '/assets/land-D9K6ripJ.bin', '/assets/sam-B4SsdBHo.glb', '/.well-known/security.txt',
      '/api/waitlist', '/api/admin/export.csv', '/healthz',
    ]
    for (const p of probes) expect(isProbe(p), p).toBe(true)
    for (const p of served) expect(isProbe(p), p).toBe(false)
  })

  it('answers a probe with a plain 404 and shuts that address out of the API for a day', async () => {
    const { get, events, advance } = setup()
    expect((await get('/.env', '203.0.113.9')).status).toBe(404)
    expect(events).toEqual([{ event: 'probe', ip: '203.0.113.9', path: '/.env' }])
    expect((await get('/api/markets', '203.0.113.9')).status).toBe(404)
    expect((await get('/', '203.0.113.9')).status).toBe(200)
    expect((await get('/api/markets', '198.51.100.4')).status).toBe(200)
    expect((await get('/.git/config', '203.0.113.9')).status).toBe(404)
    expect(events).toHaveLength(1)
    advance(DAY + 1)
    expect((await get('/api/markets', '203.0.113.9')).status).toBe(200)
  })
})

describe('admin brute force', () => {
  it('shuts out an address after five wrong tokens in an hour, even if it then sends the right one', async () => {
    const { get, events } = setup()
    const wrong = { authorization: 'Bearer guess' }
    for (let i = 0; i < 5; i++) expect((await get('/api/admin/stats', '203.0.113.7', wrong)).status).toBe(404)
    expect(events.some((e) => e.event === 'ban')).toBe(false)
    expect((await get('/api/admin/stats', '203.0.113.7', wrong)).status).toBe(404)
    expect(events).toContainEqual({ event: 'ban', ip: '203.0.113.7', reason: 'admin_auth' })
    const right = { authorization: `Bearer ${TOKEN}` }
    expect((await get('/api/admin/stats', '203.0.113.7', right)).status).toBe(404)
    expect((await get('/api/admin/stats', '198.51.100.4', right)).status).toBe(200)
  })

  it('logs each failed admin attempt and nothing for a correct one', async () => {
    const { get, events } = setup()
    await get('/api/admin/export.csv', '203.0.113.7', { authorization: 'Bearer guess' })
    expect((await get('/api/admin/export.csv', '198.51.100.4', { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    expect(events).toEqual([{ event: 'admin_auth_failed', ip: '203.0.113.7' }])
  })
})
