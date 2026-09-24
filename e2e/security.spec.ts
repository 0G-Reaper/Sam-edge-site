import { test, expect } from '@playwright/test'

test.describe('server hardening', () => {
  test('sends the security headers on the document', async ({ request, baseURL }) => {
    const res = await request.get('/')
    expect(res.status()).toBe(200)
    const h = res.headers()
    expect(h['content-security-policy']).toContain("default-src 'self'")
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['cross-origin-opener-policy']).toBe('same-origin')
    expect(h['referrer-policy']).toBeTruthy()
    if (baseURL?.startsWith('https')) expect(h['strict-transport-security']).toContain('max-age')
  })

  test('cloaks the admin export without a token', async ({ request }) => {
    const res = await request.get('/api/admin/export.csv')
    expect(res.status()).toBe(404)
    const stats = await request.get('/api/admin/stats')
    expect(stats.status()).toBe(404)
  })

  test('refuses cross-site signups', async ({ request }) => {
    const res = await request.post('/api/waitlist', {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { userId: 'someone', email: 'someone@example.com', t: Date.now() - 5000 },
    })
    expect(res.status()).toBe(403)
  })

  test('serves live or clearly labelled index data', async ({ request }) => {
    const res = await request.get('/api/markets')
    expect(res.status()).toBe(200)
    const body = await res.json()
    const list = body.items
    expect(Array.isArray(list)).toBeTruthy()
    expect(list.length).toBe(3)
  })
})
