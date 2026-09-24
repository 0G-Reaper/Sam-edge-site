import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openDb } from './db.js'
import { getMarkets } from './markets.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(here, '../client')
const indexPath = resolve(clientDir, 'index.html')
const production = process.env.NODE_ENV === 'production'

const port = Number(process.env.PORT ?? 8080)
const dbPath = process.env.DB_PATH ?? resolve(process.cwd(), 'data/waitlist.sqlite')
const db = openDb(dbPath)

const app = createApp({
  db,
  markets: () => getMarkets(),
  adminToken: process.env.ADMIN_TOKEN || undefined,
  site: {
    instagram: cleanUrl(process.env.SITE_INSTAGRAM_URL),
    discord: cleanUrl(process.env.SITE_DISCORD_URL),
  },
  indexHtml: existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined,
  staticRoot: existsSync(clientDir) ? relative(process.cwd(), clientDir) || '.' : undefined,
  production,
  canonicalHost: cleanHost(process.env.CANONICAL_HOST),
  securityContact: cleanContact(process.env.SECURITY_CONTACT),
})

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`sam-edge-site listening on :${info.port} (${production ? 'production' : 'development'})`)
})

function cleanUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const u = new URL(value)
    return u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

function cleanHost(value: string | undefined): string | undefined {
  if (!value) return undefined
  const host = value.trim().toLowerCase()
  return /^[a-z0-9.-]{1,253}$/.test(host) ? host : undefined
}

function cleanContact(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  return /^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+)$/.test(v) ? v : undefined
}

function shutdown() {
  server.close(() => {
    try {
      db.close()
    } finally {
      process.exit(0)
    }
  })
  setTimeout(() => process.exit(0), 5_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
