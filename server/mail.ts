import { createHash, randomUUID } from 'node:crypto'
import type { Db } from './db.js'

export interface MailInput {
  to: string
  subject: string
  text: string
  kind: string
  dedupeKey: string
  memberId?: number
  expiresAt?: number
}

export interface MailConfig {
  apiKey?: string
  from?: string
  enabled?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

export function initMail(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS member_email_outbox (
    id TEXT PRIMARY KEY, member_id INTEGER, recipient TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    lease_id TEXT, lease_until INTEGER, first_attempt_at INTEGER,
    accepted_at INTEGER, provider_id TEXT, last_error TEXT
  ); CREATE INDEX IF NOT EXISTS member_email_due ON member_email_outbox(state,next_attempt_at);`)
}

/** Safe inside the caller's transaction: no external I/O and no transaction commit. */
export function enqueueMail(db: Db, input: MailInput, now = Date.now()): void {
  initMail(db)
  if (!input.to || /[\r\n]/.test(input.to) || !input.subject || /[\r\n]/.test(input.subject)) throw new Error('invalid_email_envelope')
  if (input.text.length > 24_000 || input.subject.length > 200 || input.dedupeKey.length > 220) throw new Error('email_too_large')
  // Verification mail must never arrive days later looking actionable.
  const verification = /auth|verify|verification|login|code|discord_confirm/.test(input.kind)
  db.prepare(`INSERT OR IGNORE INTO member_email_outbox
    (id,member_id,recipient,subject,body,kind,dedupe_key,created_at,next_attempt_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.memberId ?? null, input.to,
    input.subject, input.text, input.kind, input.dedupeKey, now, now,
    input.expiresAt ?? now + (verification ? 10 * 60_000 : 23 * 60 * 60_000))
}

export function mailReady(config?: MailConfig): boolean {
  return config?.enabled === true && Boolean(config.apiKey && config.from && !/[\r\n]/.test(config.from))
}

type MailRow = { id: string; recipient: string; subject: string; body: string; kind: string;
  dedupe_key: string; attempts: number; expires_at: number; first_attempt_at: number | null }

/** One leased delivery at a time. Provider acceptance is not inbox delivery. */
export async function deliverMailBatch(db: Db, config: MailConfig, limit = 5): Promise<{ accepted: number; retried: number }> {
  initMail(db)
  const result = { accepted: 0, retried: 0 }
  if (!mailReady(config)) return result
  const clock = config.now ?? Date.now
  for (let i = 0; i < Math.min(20, Math.max(0, limit)); i++) {
    const now = clock()
    const lease = randomUUID()
    let row: MailRow | undefined
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE member_email_outbox SET state='expired',body='',last_error='expired_before_acceptance'
        WHERE state IN ('queued','sending') AND expires_at<=? AND (lease_until IS NULL OR lease_until<=?)`).run(now, now)
      row = db.prepare(`SELECT * FROM member_email_outbox WHERE
        (state='queued' OR (state='sending' AND lease_until<=?)) AND next_attempt_at<=? AND expires_at>?
        ORDER BY created_at,id LIMIT 1`).get(now, now, now) as MailRow | undefined
      if (row) {
        // Resend keeps idempotency keys 24h; stop automatic retries before that boundary.
        if (row.first_attempt_at !== null && now - row.first_attempt_at >= 23 * 60 * 60_000) {
          db.prepare("UPDATE member_email_outbox SET state='needs_review',last_error='idempotency_window_ended',body='' WHERE id=?").run(row.id)
          row = undefined
        } else {
          db.prepare(`UPDATE member_email_outbox SET state='sending',lease_id=?,lease_until=?,attempts=attempts+1,
            first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?`).run(lease, now + 60_000, now, row.id)
        }
      }
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    if (!row) break
    try {
      const response = await (config.fetchImpl ?? fetch)('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json',
          'Idempotency-Key': `sam-member-${createHash('sha256').update(row.dedupe_key).digest('hex')}` },
        body: JSON.stringify({ from: config.from, to: [row.recipient], subject: row.subject, text: row.body }),
      })
      if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'provider_retryable' : 'provider_rejected')
      const receipt = await response.json() as { id?: unknown }
      if (typeof receipt.id !== 'string' || !receipt.id) throw new Error('provider_invalid_receipt')
      db.prepare(`UPDATE member_email_outbox SET state='accepted',accepted_at=?,provider_id=?,
        body='',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND lease_id=?`).run(clock(), receipt.id, row.id, lease)
      result.accepted++
    } catch (error) {
      const reason = error instanceof Error && ['provider_retryable','provider_rejected','provider_invalid_receipt'].includes(error.message)
        ? error.message : 'delivery_uncertain'
      const terminal = reason === 'provider_rejected' || row.attempts >= 7
      db.prepare(`UPDATE member_email_outbox SET state=?,next_attempt_at=?,lease_id=NULL,lease_until=NULL,last_error=?
        WHERE id=? AND lease_id=?`).run(terminal ? 'needs_review' : 'queued', clock() + Math.min(60 * 60_000, 15_000 * 2 ** row.attempts), reason, row.id, lease)
      result.retried++
    }
  }
  return result
}

/** Operational counts only; never return message bodies, codes, addresses or keys. */
export function mailHealth(db: Db) {
  initMail(db)
  return db.prepare('SELECT state,COUNT(*) AS count FROM member_email_outbox GROUP BY state').all()
}
