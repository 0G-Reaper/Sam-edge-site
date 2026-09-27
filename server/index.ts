import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openDb } from './db.js'
import { getMarkets } from './markets.js'
import { discordConfigFromEnv } from './member-discord.js'
import type { MemberRuntime } from './members.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(here, '../client')
const indexPath = resolve(clientDir, 'index.html')
const production = process.env.NODE_ENV === 'production'
// Restrict database, WAL and mail-outbox files created by this process.
process.umask(0o077)

const port = Number(process.env.PORT ?? 8080)
const dbPath = process.env.DB_PATH ?? resolve(process.cwd(), 'data/waitlist.sqlite')
const db = openDb(dbPath)
let memberRuntime: MemberRuntime | undefined

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
  membership: {
    enabled:process.env.MEMBER_ACCESS_ENABLED==='true',
    mail:{enabled:process.env.MEMBER_EMAIL_ENABLED==='true',apiKey:process.env.RESEND_API_KEY,from:process.env.MEMBER_EMAIL_FROM,
      webhookSecret:process.env.RESEND_WEBHOOK_SECRET,probeTo:process.env.MEMBER_EMAIL_PROBE_TO},
    discord:discordConfigFromEnv(),
    researchKey:process.env.SAM_RESEARCH_SHARED_KEY,
    reviewKey:process.env.SAM_REVIEW_SHARED_KEY,
    allowedProviders:process.env.SAM_RESEARCH_ALLOWED_PROVIDERS?.split(',').map(s=>s.trim()).filter(Boolean),
    allowedReviewModels:process.env.SAM_REVIEW_ALLOWED_MODELS?.split(',').map(s=>s.trim()).filter(Boolean),
    discordPublicKey:process.env.DISCORD_PUBLIC_KEY,
    discordResearchChannelId:process.env.DISCORD_RESEARCH_CHANNEL_ID,
    questDeadline:process.env.MEMBER_QUEST_DEADLINE,
  },
  onMemberRuntime:runtime=>{memberRuntime=runtime},
})

const membershipWorker=setInterval(()=>{
  void memberRuntime?.tick().catch(()=>console.error('Member delivery/reconciliation failed; durable state retained.'))
},15_000)
membershipWorker.unref()

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
  clearInterval(membershipWorker)
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
