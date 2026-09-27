import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { Webhook } from 'svix'
import { z } from 'zod'
import type { Db } from './db.js'
import { enqueueMail, initMail, mailReady, type MailConfig } from './mail.js'

const EVENT_TYPES = ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced',
  'email.complained', 'email.failed', 'email.suppressed'] as const
const Event = z.object({
  type: z.enum(EVENT_TYPES), created_at: z.iso.datetime({ offset: true }),
  data: z.object({
    email_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
    to: z.array(z.email().max(254)).length(1),
    tags: z.object({ sam_outbox_id: z.uuid().optional() }).optional(),
  }),
})
type MailRecord = { id: string; member_id: number | null; recipient: string; state: string;
  provider_id: string | null; first_attempt_at: number | null; tracking_version: number }

export function mailWebhookReady(config?: MailConfig): boolean {
  const secret = config?.webhookSecret
  return Boolean(secret && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) &&
    Buffer.from(secret.slice(6), 'base64').length >= 16 && secret.length <= 200 &&
    Buffer.from(secret.slice(6), 'base64').toString('base64').replace(/=+$/, '') === secret.slice(6).replace(/=+$/, ''))
}

/** Only signed, matched events are stored. Provider payloads, addresses and subjects are discarded. */
export function mountMailWebhook(app: Hono, db: Db, config: MailConfig = {}, now = Date.now) {
  initMail(db)
  const verifier = mailWebhookReady(config) ? new Webhook(config.webhookSecret!) : undefined
  app.post('/api/webhooks/resend', bodyLimit({ maxSize: 32 * 1024 }), async c => {
    if (!verifier) return c.json({ ok: false, error: 'email_webhook_unconfigured' }, 503)
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      return c.json({ ok: false, error: 'json_required' }, 415)
    }
    const eventId = c.req.header('svix-id') ?? ''
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId)) return c.json({ ok: false, error: 'invalid_webhook' }, 400)
    const raw = await c.req.text()
    let verified: unknown
    try {
      verifier.verify(raw, { 'svix-id': eventId, 'svix-timestamp': c.req.header('svix-timestamp') ?? '',
        'svix-signature': c.req.header('svix-signature') ?? '' })
      // Svix 2 verifies without parsing. Parse only after verification of the exact bytes.
      verified = JSON.parse(raw)
    } catch { return c.json({ ok: false, error: 'invalid_webhook' }, 400) }
    // Other products may share the provider account. Never retain unrelated events.
    if (!verified || typeof verified !== 'object' || !('type' in verified) ||
        !EVENT_TYPES.includes(verified.type as typeof EVENT_TYPES[number])) return c.json({ ok: true, ignored: true })
    const parsed = Event.safeParse(verified)
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_email_event' }, 400)
    const event = parsed.data, receivedAt = now(), occurredAt = Date.parse(event.created_at)
    if (occurredAt > receivedAt + 5 * 60_000) return c.json({ ok: false, error: 'invalid_event_time' }, 400)
    const payloadHash = createHash('sha256').update(raw).digest('hex')
    db.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = db.prepare('SELECT payload_hash FROM member_email_events WHERE event_id=?').get(eventId)
      if (duplicate) {
        db.exec('COMMIT')
        return duplicate.payload_hash === payloadHash ? c.json({ ok: true, duplicate: true }) :
          c.json({ ok: false, error: 'email_event_conflict' }, 409)
      }
      const tag = event.data.tags?.sam_outbox_id
      const row = (tag ? db.prepare('SELECT * FROM member_email_outbox WHERE id=?').get(tag) :
        db.prepare('SELECT * FROM member_email_outbox WHERE provider_id=?').get(event.data.email_id)) as MailRecord | undefined
      // Pre-signup/login mail can have no member_id. Still honor a pending deletion
      // for that address while external cleanup prevents final outbox removal.
      const memberDisabled = row && ((row.member_id !== null && !db.prepare('SELECT 1 FROM members WHERE id=? AND disabled_at IS NULL').get(row.member_id)) ||
        Boolean(db.prepare('SELECT 1 FROM members WHERE email=? COLLATE NOCASE AND disabled_at IS NOT NULL').get(row.recipient)))
      if (!row || row.state === 'cancelled' || memberDisabled || row.first_attempt_at === null ||
          row.recipient.toLowerCase() !== event.data.to[0]!.toLowerCase() ||
          (row.provider_id !== null && row.provider_id !== event.data.email_id) ||
          (tag && row.tracking_version !== 1)) {
        db.exec('COMMIT')
        return c.json({ ok: true, ignored: true })
      }
      db.prepare(`INSERT INTO member_email_events(event_id,outbox_id,provider_id,event_type,occurred_at,received_at,payload_hash)
        VALUES(?,?,?,?,?,?,?)`).run(eventId, row.id, event.data.email_id, event.type, occurredAt, receivedAt, payloadHash)
      // This can race with the send response or arrive after a timeout. Never send a second copy.
      db.prepare(`UPDATE member_email_outbox SET state='accepted',provider_id=?,accepted_at=COALESCE(accepted_at,?),
        body='',lease_id=NULL,lease_until=NULL,last_error=NULL WHERE id=?`).run(event.data.email_id, receivedAt, row.id)
      db.exec('COMMIT')
      return c.json({ ok: true })
    } catch (error) { db.exec('ROLLBACK'); throw error }
  })
}

// Stronger evidence cannot be undone by delayed/replayed events. Complaints remain visible
// after delivery; a later sent/delayed event never makes a delivered message look pending.
const DELIVERY_ROLLUP = `SELECT o.id,o.kind,o.state AS queue_state,o.created_at,o.accepted_at,
  CASE MAX(CASE e.event_type WHEN 'email.complained' THEN 7 WHEN 'email.bounced' THEN 6
    WHEN 'email.suppressed' THEN 5 WHEN 'email.failed' THEN 4 WHEN 'email.delivered' THEN 3
    WHEN 'email.delivery_delayed' THEN 2 WHEN 'email.sent' THEN 1 ELSE 0 END)
    WHEN 7 THEN 'complained' WHEN 6 THEN 'bounced' WHEN 5 THEN 'suppressed' WHEN 4 THEN 'failed'
    WHEN 3 THEN 'delivered_to_mail_server' WHEN 2 THEN 'delayed' WHEN 1 THEN 'sent' ELSE 'unconfirmed' END AS delivery_state,
  MIN(CASE WHEN e.event_type='email.delivered' THEN e.occurred_at END) AS delivered_at,
  MAX(e.received_at) AS last_event_at,COUNT(e.event_id) AS event_count
  FROM member_email_outbox o LEFT JOIN member_email_events e ON e.outbox_id=o.id GROUP BY o.id`

/** Aggregate operations data; no email addresses, message text, codes, keys or event payloads. */
export function mailDeliveryHealth(db: Db, config?: MailConfig, now = Date.now()) {
  initMail(db)
  const counts = db.prepare(`WITH delivery AS (${DELIVERY_ROLLUP})
    SELECT delivery_state AS state,COUNT(*) AS count FROM delivery WHERE queue_state='accepted' GROUP BY delivery_state`).all()
  const unconfirmed = db.prepare(`WITH delivery AS (${DELIVERY_ROLLUP})
    SELECT COUNT(*) AS count,MIN(accepted_at) AS oldestAcceptedAt FROM delivery
    WHERE queue_state='accepted' AND delivery_state IN ('unconfirmed','sent','delayed') AND accepted_at<=?`).get(now - 15 * 60_000)
  const latest = db.prepare('SELECT MAX(received_at) AS lastEventAt FROM member_email_events').get()
  return { transportConfigured: mailReady(config), webhookConfigured: mailWebhookReady(config),
    probeRecipientConfigured: z.email().max(254).safeParse(config?.probeTo).success,
    counts, awaitingDeliveryOver15Minutes: unconfirmed, lastEventAt: latest?.lastEventAt ?? null,
    deliveryMeaning: 'Recipient mail-server acceptance; does not prove inbox placement or reading.' }
}

export function queueMailProbe(db: Db, config: MailConfig | undefined, probeId: string, now = Date.now()) {
  initMail(db)
  const recipient = z.email().max(254).safeParse(config?.probeTo)
  if (!mailReady(config) || !recipient.success || !mailWebhookReady(config)) throw new Error('email_probe_unconfigured')
  const key = `operator-email-probe:${probeId}`
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare('SELECT id,state FROM member_email_outbox WHERE dedupe_key=?').get(key)
    if (existing) { db.exec('COMMIT'); return existing }
    if (db.prepare("SELECT 1 FROM member_email_outbox WHERE kind='operator_delivery_probe' AND created_at>?").get(now - 10 * 60_000)) {
      throw new Error('email_probe_cooldown')
    }
    enqueueMail(db, { to: recipient.data, subject: 'SAM member email delivery check',
      text: `SAM email delivery check\n\nReference: ${probeId}\nRequested: ${new Date(now).toISOString()}\n\nThis checks the transactional email path before member access is activated. Confirm that this message reached your mailbox and compare the reference with the protected delivery status. No member account or invitation was created.`,
      kind: 'operator_delivery_probe', dedupeKey: key, expiresAt: now + 15 * 60_000 }, now)
    const probe = db.prepare('SELECT id,state FROM member_email_outbox WHERE dedupe_key=?').get(key)!
    db.exec('COMMIT')
    return probe
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function mailProbeStatus(db: Db, probeId: string) {
  return db.prepare(`WITH delivery AS (${DELIVERY_ROLLUP}) SELECT d.* FROM delivery d
    JOIN member_email_outbox o ON o.id=d.id WHERE o.dedupe_key=? AND o.kind='operator_delivery_probe'`).get(`operator-email-probe:${probeId}`)
}
