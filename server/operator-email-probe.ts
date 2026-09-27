import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'

const Status = z.object({ ok: z.literal(true), enabled: z.boolean(),
  members: z.object({ count: z.number().int().nonnegative() }),
  emailDelivery: z.object({ transportConfigured: z.boolean(), webhookConfigured: z.boolean(), probeRecipientConfigured: z.boolean() }) })
const Stats = z.object({ ok: z.literal(true), signups: z.number().int().nonnegative() })
const Probe = z.object({ ok: z.literal(true), probe: z.object({ id: z.uuid(),
  queue_state: z.string(), delivery_state: z.string(), event_count: z.number().int().nonnegative(),
  accepted_at: z.number().nullable(), delivered_at: z.number().nullable(), last_event_at: z.number().nullable() }) })

export class OperatorProbeError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** The operator opts in with one UUID in protected deployment configuration.
 * Use the existing authenticated API; never export credentials or bypass its checks. */
export async function runOperatorEmailProbe(env: Record<string, string | undefined>, options: {
  fetchImpl?: typeof fetch; signal?: AbortSignal; sleep?: (ms: number, signal: AbortSignal) => Promise<void>
} = {}) {
  const probeId = z.uuid().safeParse(env.MEMBER_EMAIL_PROBE_ID)
  const origin = env.MEMBER_PUBLIC_ORIGIN, token = env.ADMIN_TOKEN
  let target: URL
  try { target = new URL(origin ?? '') } catch { throw new OperatorProbeError('invalid_configuration') }
  if (!probeId.success || !token || /\s/.test(token) || token.length > 4096 ||
      target.protocol !== 'https:' || target.port || origin !== target.origin ||
      target.hostname !== env.CANONICAL_HOST?.trim().toLowerCase()) {
    throw new OperatorProbeError('invalid_configuration')
  }
  const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(options.signal ? [options.signal] : [])])
  const sleep = options.sleep ?? ((ms, s) => delay(ms, undefined, { signal: s }))
  const fetchImpl = options.fetchImpl ?? fetch
  const request = async (path: string, body?: unknown): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        headers: { authorization: `Bearer ${token}`, origin: origin!, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new OperatorProbeError(`http_${response.status}`)
      // Protected operations responses are tiny. Never log returned bodies or errors.
      const reader = response.body?.getReader()
      if (!reader) throw new OperatorProbeError('invalid_response')
      const chunks: Uint8Array[] = []; let bytes = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > 32 * 1024) { await reader.cancel(); throw new OperatorProbeError('invalid_response') }
        chunks.push(part.value)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch (error) {
      if (signal.aborted) throw new OperatorProbeError('timed_out_or_cancelled')
      if (error instanceof OperatorProbeError) throw error
      throw new OperatorProbeError('request_failed')
    }
  }
  const getStatus = async () => {
    const parsed = Status.safeParse(await request('/api/admin/members/status'))
    if (!parsed.success) throw new OperatorProbeError('invalid_response')
    return parsed.data
  }
  let before: z.infer<typeof Status> | undefined
  // Public routing can still point at the previous release immediately after listen().
  for (let attempt = 0; attempt < 30; attempt++) {
    try { before = await getStatus(); break } catch (error) {
      if (!(error instanceof OperatorProbeError) ||
          !['http_404', 'http_429', 'http_502', 'http_503', 'http_504', 'request_failed'].includes(error.code)) throw error
      await sleep(5_000, signal)
    }
  }
  if (!before) throw new OperatorProbeError('endpoint_unavailable')
  if (before.enabled || before.members.count !== 0) throw new OperatorProbeError('membership_already_active')
  if (!Object.values(before.emailDelivery).every(value => value === true)) throw new OperatorProbeError('email_unconfigured')
  const signupsBefore = Stats.safeParse(await request('/api/admin/stats'))
  if (!signupsBefore.success) throw new OperatorProbeError('invalid_response')
  // The API binds the destination to server configuration and deduplicates this UUID durably.
  await request('/api/admin/members/email-probe', { probeId: probeId.data })
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(5_000, signal)
    const parsed = Probe.safeParse(await request(`/api/admin/members/email-probe/${probeId.data}`))
    if (!parsed.success) throw new OperatorProbeError('invalid_response')
    const probe = parsed.data.probe
    if (['failed', 'cancelled'].includes(probe.queue_state) ||
        ['failed', 'bounced', 'complained', 'suppressed'].includes(probe.delivery_state)) {
      throw new OperatorProbeError('delivery_failed')
    }
    if (probe.queue_state !== 'accepted' || probe.delivery_state !== 'delivered_to_mail_server' ||
        probe.event_count < 1 || probe.accepted_at === null || probe.delivered_at === null || probe.last_event_at === null) continue
    const after = await getStatus()
    const signupsAfter = Stats.safeParse(await request('/api/admin/stats'))
    if (after.enabled || after.members.count !== 0 || !signupsAfter.success ||
        signupsAfter.data.signups < signupsBefore.data.signups) throw new OperatorProbeError('isolation_check_failed')
    return { event: 'member_email_probe_delivered', probeId: probeId.data, outboxId: probe.id,
      deliveryState: probe.delivery_state, signedEvents: probe.event_count,
      deliveredAt: probe.delivered_at, lastEventAt: probe.last_event_at,
      membershipEnabled: false, members: after.members.count,
      signupsBefore: signupsBefore.data.signups, signupsAfter: signupsAfter.data.signups }
  }
  throw new OperatorProbeError('delivery_unconfirmed')
}
