import { useRef, useState, type FormEvent } from 'react'
import { Arrow, Check, Copy } from './Icons'
import Reveal from './Reveal'

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; key: string; userId: string }
  | { kind: 'existing'; message: string }
  | { kind: 'error'; message: string }

export default function Waitlist() {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  const renderedAt = useRef(Date.now())

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const body = {
      userId: String(fd.get('userId') ?? '').trim(),
      email: String(fd.get('email') ?? '').trim(),
      website: String(fd.get('website') ?? ''),
      t: renderedAt.current,
    }
    setState({ kind: 'busy' })
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as { status?: string; key?: string; userId?: string; message?: string }
      if (res.status === 201 && json.key) {
        setState({ kind: 'done', key: json.key, userId: json.userId ?? body.userId })
        form.reset()
      } else if (res.ok && json.status === 'existing') {
        setState({ kind: 'existing', message: json.message ?? 'You are already on the list.' })
      } else if (res.status === 429) {
        setState({ kind: 'error', message: 'Too many attempts from this connection. Please try again in a few minutes.' })
      } else {
        setState({ kind: 'error', message: json.message ?? 'Something went wrong. Please try again.' })
      }
    } catch {
      setState({ kind: 'error', message: 'We could not reach the server. Check your connection and try again.' })
    }
  }

  async function copy(key: string) {
    try {
      await navigator.clipboard.writeText(key)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked: the key is selectable text */
    }
  }

  return (
    <section id="waitlist" className="waitlist" aria-labelledby="waitlist-title">
      <div className="wrap">
        <Reveal>
          <div className="card waitlist__panel">
            <div className="waitlist__copy">
              <span className="eyebrow">Reserve your place</span>
              <h2 id="waitlist-title">
                Be first when <span className="grad">Edge opens.</span>
              </h2>
              <p className="lede">
                Leave a user ID and an email. You get a member key on the spot. It is how we will recognise early members, and how you will hear the moment the doors open.
              </p>
            </div>
            {state.kind === 'done' ? (
              <div className="keycard" role="status">
                <span className="eyebrow">
                  <Check /> You are on the list, {state.userId}
                </span>
                <div className="keycard__key">{state.key}</div>
                <div className="keycard__row">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy(state.key)}>
                    {copied ? <Check /> : <Copy />}
                    {copied ? 'Copied' : 'Copy key'}
                  </button>
                </div>
                <p>Keep this key somewhere safe. It is shown once, and it is what we will ask for when early access opens.</p>
              </div>
            ) : (
              <form className="form" onSubmit={onSubmit} noValidate>
                <div className="field">
                  <label htmlFor="wl-user">User ID</label>
                  <input id="wl-user" name="userId" type="text" inputMode="text" autoComplete="username" placeholder="your handle, e.g. @marketminded" required minLength={2} maxLength={33} pattern="@?[A-Za-z0-9._-]{2,32}" disabled={state.kind === 'busy'} />
                  <small>Letters, numbers, dots, dashes or underscores. Your Instagram handle works well.</small>
                </div>
                <div className="field">
                  <label htmlFor="wl-email">Email</label>
                  <input id="wl-email" name="email" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={state.kind === 'busy'} />
                </div>
                <div className="form__hp" aria-hidden="true">
                  <label htmlFor="wl-website">Website</label>
                  <input id="wl-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
                </div>
                {state.kind === 'error' && <p className="form__err" role="alert">{state.message}</p>}
                {state.kind === 'existing' && <p className="form__err" role="status" style={{ color: 'var(--accent)' }}>{state.message}</p>}
                <div>
                  <button type="submit" className="btn btn--primary" disabled={state.kind === 'busy'} data-magnetic>
                    {state.kind === 'busy' ? 'Creating your key' : 'Get my member key'}
                    <Arrow />
                  </button>
                </div>
                <p className="form__note">We store only your user ID and email, and use them for nothing but Edge. No spam, no sharing, ever.</p>
              </form>
            )}
          </div>
        </Reveal>
      </div>
    </section>
  )
}
