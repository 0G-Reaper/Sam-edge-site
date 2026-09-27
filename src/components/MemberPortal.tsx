import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { getMembershipStatus, logoutMember, memberFetch, startMembershipAuth, verifyMembershipAuth } from '../lib/member-api'
import { Arrow, Check, Copy, Discord, Logo, Shield } from './Icons'
import Nav from './Nav'
import Footer from './Footer'

type Status = Awaited<ReturnType<typeof getMembershipStatus>>
type Profile = {
  userId: string; joinedAt: string | number
  referrals: { directVerified: number; networkReach: number; rank: number; remainingInvites: number; limit: number; title: string }
  research: { points: number; rank: number; title: string; goal: number }
  quests: Array<{ id: string; title: string; status: 'locked' | 'active' | 'complete'; progress: number; target: number }>
  collectibles: Array<{ collection: string; title: string; serial: number; cap: number; choice: string | null; choices: string[]; selectable: boolean }>
  titles: Array<{ id: string; title: string; earned: boolean; progress: number; target: number; remaining: number | null }>
  catalog: Array<{ id: string; title: string; cap: number; issued: number; remaining: number }>
  countdown: { status: 'scheduled' | 'not_scheduled' | 'ended'; deadline: string | null }
  readiness: { email: boolean; discord: boolean; research: boolean }
}
type Invite = { slot: number; status: 'available' | 'issued' | 'reserved' | 'consumed'; expiresAt?: string | number; recipientEmail?: string }
type Device = { id: string; label?: string; name?: string; createdAt?: string | number; lastUsedAt?: string | number; current?: boolean }
type Submission = { id: string; entity: string; claim: string; status: string; points: number | null; reason?: string; createdAt: string | number }
type DiscordStatus = { ready: boolean; state: string; discordUserId?: string; discordUsername?: string; questEligible: boolean }
type DirectoryEntry = { userId: string; rank: number; title: string }
type Inbound = { invite: string; discordCode: string; discordState: string; discordConfirm: string }
const CHOICES: Record<string, { label: string; description: string; symbol: string }> = {
  stargazer: { label: 'Stargazer', description: 'Curiosity beyond the obvious.', symbol: '✦' },
  techhead: { label: 'Techhead', description: 'The systems thinker.', symbol: '⌘' },
  wolf: { label: 'Wolf of Wall Street', description: 'Follow the evidence.', symbol: '◇' },
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'We could not complete that request. Please try again.'
}
function isSignedOut(error: unknown) { return typeof error === 'object' && error !== null && 'status' in error && error.status === 401 }
function readInbound(): Inbound {
  const url = new URL(window.location.href)
  const hash = new URLSearchParams(url.hash.slice(1))
  return {
    invite: hash.get('invite') ?? url.searchParams.get('invite') ?? '',
    discordCode: hash.get('discord_code') ?? '',
    discordState: hash.get('discord_state') ?? '',
    discordConfirm: hash.get('discord_confirm') ?? '',
  }
}
function stripInbound() {
  const url = new URL(window.location.href)
  url.searchParams.delete('invite')
  const hash = new URLSearchParams(url.hash.slice(1))
  if (['invite', 'discord_code', 'discord_state', 'discord_confirm'].some((key) => hash.has(key))) url.hash = ''
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}
function prettyState(value: string) { return value.replaceAll('_', ' ') }
function dateLabel(value?: string | number) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? 'Not recorded' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return <div className="member-meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.max(0, Math.min(value, max))}><span style={{ width: `${Math.min(100, Math.max(0, value / Math.max(1, max) * 100))}%` }} /></div>
}
function Countdown({ countdown }: { countdown: Profile['countdown'] }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (countdown.status !== 'scheduled') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [countdown.status])
  const deadline = countdown.deadline ? Date.parse(countdown.deadline) : NaN
  const seconds = Math.max(0, Math.floor((deadline - now) / 1000))
  const text = countdown.status === 'not_scheduled' || !Number.isFinite(deadline)
    ? 'No deadline scheduled'
    : countdown.status === 'ended' || seconds === 0
      ? 'This window has ended'
      : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`
  return <div className="member-countdown"><span className="member-caption">Community quest window</span><strong className="mono">{text}</strong>{Number.isFinite(deadline) ? <small>Ends {new Date(deadline).toLocaleString()}</small> : <small>Your progress stays with your account.</small>}</div>
}

export default function MemberPortal({ status, onAuthenticationChange, onMeetSam, children }: {
  status: Status; onAuthenticationChange: (signedIn: boolean) => void; onMeetSam: () => void; children: ReactNode
}) {
  const [inbound] = useState(readInbound)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const refreshProfile = useCallback(async () => {
    const response = await memberFetch<{ profile: Profile }>('/api/member/profile')
    setProfile(response.profile)
    onAuthenticationChange(true)
  }, [onAuthenticationChange])
  useEffect(() => {
    stripInbound()
    let active = true
    memberFetch<{ profile: Profile }>('/api/member/profile').then((response) => {
      if (!active) return
      setProfile(response.profile)
      onAuthenticationChange(true)
    }).catch((error: unknown) => {
      if (active && !isSignedOut(error)) setLoadError(messageOf(error))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [onAuthenticationChange])
  const signOut = async () => {
    try {
      await logoutMember()
      setProfile(null)
      onAuthenticationChange(false)
      setLoadError('')
    } catch (error) {
      if (isSignedOut(error)) {
        setProfile(null)
        onAuthenticationChange(false)
        setLoadError('')
      } else setLoadError(messageOf(error))
    }
  }
  if (loading) return <main className="member-loading" role="status"><Logo /><p>Checking your registered browser…</p></main>
  if (!profile) return <MemberGate status={status} invite={inbound.invite} initialError={loadError} onAuthenticated={refreshProfile} />
  return <>
    <Nav onMeetSam={onMeetSam} memberMode />
    <main id="top">
      <MemberDashboard profile={profile} refreshProfile={refreshProfile} signOut={signOut} inbound={inbound} />
      {loadError ? <p className="member-notice wrap" role="alert">{loadError}</p> : null}
      {children}
    </main>
    <Footer onMeetSam={onMeetSam} memberMode />
  </>
}

function MemberGate({ status, invite, initialError, onAuthenticated }: {
  status: Status; invite: string; initialError: string; onAuthenticated: () => Promise<void>
}) {
  const [mode, setMode] = useState<'login' | 'signup'>(invite ? 'signup' : 'login')
  const [challenge, setChallenge] = useState<{ challengeId: string; email: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [notice, setNotice] = useState('')
  async function begin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const email = String(data.get('email') ?? '').trim()
    setBusy(true); setError('')
    try {
      const result = await startMembershipAuth({ mode, email, userId: mode === 'signup' ? String(data.get('userId') ?? '').trim() : undefined, inviteToken: mode === 'signup' ? invite : undefined })
      setChallenge({ challengeId: result.challengeId, email })
      setNotice(result.message || 'Check your inbox for a verification code.')
    } catch (error) { setError(messageOf(error)) } finally { setBusy(false) }
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!challenge) return
    const data = new FormData(event.currentTarget)
    setBusy(true); setError('')
    try {
      await verifyMembershipAuth({ challengeId: challenge.challengeId, code: String(data.get('code') ?? '').trim() })
      await onAuthenticated()
    } catch (error) { setError(messageOf(error)) } finally { setBusy(false) }
  }
  return <main id="top" className="member-gate wrap">
    <a className="brand member-gate__brand" href="/" aria-label="SAM Edge"><Logo /><span className="brand__name">SAM</span><span className="brand__tag">Edge</span></a>
    <div className="member-gate__grid">
      <div className="member-gate__story">
        <span className="eyebrow"><Shield /> A private research community</span>
        <h1>Good questions.<br /><span className="grad">Better company.</span></h1>
        <p className="lede">An invitation opens the door. The quality of your contributions builds your standing.</p>
        <div className="member-gate__principles">
          <div><span>01</span><p><strong>Join through someone you trust.</strong> Each member can invite ten people. Every invitation is tied to its intended email.</p></div>
          <div><span>02</span><p><strong>Bring evidence to the conversation.</strong> Research contributions are reviewed before points are awarded.</p></div>
          <div><span>03</span><p><strong>Build a record of useful work.</strong> Follow your quests, titles and limited community collectibles.</p></div>
        </div>
        <p className="member-caption">SAM is being built to connect market evidence with clear analysis. Membership does not imply investment performance.</p>
      </div>
      <div className="card member-gate__form">
        <span className="member-pill">Members & their guests</span>
        <h2>{challenge ? 'Check your email.' : mode === 'signup' ? 'Your invitation awaits.' : 'Welcome back.'}</h2>
        <p className="member-muted">{challenge ? `Enter the code sent to ${challenge.email}. Stay in this browser to finish.` : mode === 'signup' ? 'Choose the User ID that members will know you by.' : 'Already on the early-access list? Use the email you registered with.'}</p>
        {!challenge ? <div className="member-tabs" aria-label="Access options"><button type="button" className={mode === 'login' ? 'is-selected' : ''} aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError('') }}>Member sign-in</button><button type="button" className={mode === 'signup' ? 'is-selected' : ''} aria-pressed={mode === 'signup'} onClick={() => { setMode('signup'); setError('') }}>I have an invite</button></div> : null}
        {!status.emailReady ? <p className="member-notice" role="status">Email verification is not configured yet. Member access will open when email setup is complete.</p> : null}
        {mode === 'signup' && !invite && !challenge ? <p className="member-notice">Open the private invitation link shared by your member. A User ID alone cannot grant access.</p> : null}
        {challenge ? <form className="form" onSubmit={verify}>
          <div className="field"><label htmlFor="member-code">Email verification code</label><input id="member-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={12} autoFocus disabled={busy} /></div>
          {notice ? <p className="member-muted" role="status">{notice}</p> : null}
          {error ? <p className="form__err" role="alert">{error}</p> : null}
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Verifying…' : 'Enter SAM Edge'}<Arrow /></button>
          <button type="button" className="member-text-button" disabled={busy} onClick={() => { setChallenge(null); setNotice(''); setError('') }}>Use another email or request a new code</button>
        </form> : <form className="form" onSubmit={begin}>
          {mode === 'signup' ? <div className="field"><label htmlFor="member-userid">Public User ID</label><input id="member-userid" name="userId" autoComplete="username" placeholder="your_user_id" required minLength={2} maxLength={33} pattern="@?[A-Za-z0-9._-]{2,32}" disabled={busy} /><small>Your ID and rank are visible to fellow members. Your email stays private.</small></div> : null}
          <div className="field"><label htmlFor="member-email">Email address</label><input id="member-email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={busy} /></div>
          {error ? <p className="form__err" role="alert">{error}</p> : null}
          <button type="submit" className="btn btn--primary" disabled={busy || !status.emailReady || (mode === 'signup' && !invite)}>{busy ? 'Sending your code…' : 'Send verification code'}<Arrow /></button>
        </form>}
        <div className="member-security-note"><Shield /><p>Access is limited to two registered browsers, each secured with a cryptographic key. Clearing browser data or changing browsers requires recovery; a website cannot permanently identify your physical device.</p></div>
        <details className="member-details"><summary>Need help recovering a browser?</summary><p className="member-caption">Use your other registered browser to revoke a lost key. If neither browser is available, ask the member who invited you to contact the community administrator. Recovery requires review and does not reset your device limit automatically.</p></details>
        <p className="member-caption">We retain your membership and progress until the account is deleted. Email is used for verification and membership updates.</p>
      </div>
    </div>
    <p className="member-gate__foot">SAM Edge · Research, with receipts.</p>
  </main>
}

function MemberDashboard({ profile, refreshProfile, signOut, inbound }: {
  profile: Profile; refreshProfile: () => Promise<void>; signOut: () => Promise<void>; inbound: Inbound
}) {
  const [invites, setInvites] = useState<Invite[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [discord, setDiscord] = useState<DiscordStatus | null>(null)
  const [directory, setDirectory] = useState<DirectoryEntry[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [inviteLink, setInviteLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [panelErrors, setPanelErrors] = useState<string[]>([])
  const handledDiscord = useRef(false)
  const loadPanels = useCallback(async () => {
    const results = await Promise.allSettled([
      memberFetch<{ invites: Invite[] }>('/api/member/invites'),
      memberFetch<{ devices: Device[] }>('/api/member/devices'),
      memberFetch<{ submissions: Submission[] }>('/api/member/research'),
      memberFetch<DiscordStatus>('/api/member/discord/status'),
    ])
    if (results[0].status === 'fulfilled') setInvites(results[0].value.invites)
    if (results[1].status === 'fulfilled') setDevices(results[1].value.devices)
    if (results[2].status === 'fulfilled') setSubmissions(results[2].value.submissions)
    if (results[3].status === 'fulfilled') setDiscord(results[3].value)
    const labels = ['Invitations', 'Registered browsers', 'Research history', 'Discord status']
    setPanelErrors(results.flatMap((result, index) => result.status === 'rejected' ? [labels[index]] : []))
  }, [])
  useEffect(() => { void loadPanels() }, [loadPanels])
  useEffect(() => {
    if (handledDiscord.current || (!inbound.discordCode && !inbound.discordConfirm)) return
    handledDiscord.current = true
    const path = inbound.discordConfirm ? '/api/member/discord/confirm' : '/api/member/discord/complete'
    const data = inbound.discordConfirm ? { token: inbound.discordConfirm } : { code: inbound.discordCode, state: inbound.discordState }
    memberFetch<{ message?: string; state?: string }>(path, { method: 'POST', body: JSON.stringify(data) }).then(async (result) => {
      setNotice(result.message || `Discord: ${prettyState(result.state || 'updated')}.`)
      await Promise.all([refreshProfile(), loadPanels()])
    }).catch((error) => setError(messageOf(error)))
  }, [inbound, refreshProfile, loadPanels])
  async function perform(name: string, action: () => Promise<void>) {
    setBusy(name); setError(''); setNotice('')
    try { await action() } catch (error) { setError(messageOf(error)) } finally { setBusy('') }
  }
  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    await perform('invite', async () => {
      const result = await memberFetch<{ invite: { token: string; slot: number } }>('/api/member/invites', { method: 'POST', body: JSON.stringify({ email: String(data.get('inviteEmail') ?? '').trim() }) })
      setInviteLink(`${window.location.origin}/#invite=${encodeURIComponent(result.invite.token)}`)
      setCopied(false)
      setNotice(`Invitation ${result.invite.slot} is ready. Copy its private link below; it is only shown once.`)
      form.reset()
      await Promise.all([refreshProfile(), loadPanels()])
    })
  }
  async function copyInvite() {
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true) } catch { setNotice('Select and copy the invitation link below.') }
  }
  async function revokeInvite(slot: number) {
    await perform(`invite-${slot}`, async () => {
      await memberFetch(`/api/member/invites/${slot}/revoke`, { method: 'POST', body: '{}' })
      setInviteLink('')
      setNotice('Unused invitation revoked. Its slot is available again.')
      await Promise.all([refreshProfile(), loadPanels()])
    })
  }
  async function loadDirectory(offset = 0) {
    await perform('directory', async () => {
      const result = await memberFetch<{ members: DirectoryEntry[]; nextOffset: number | null }>(`/api/member/directory?offset=${offset}`)
      setDirectory((previous) => offset === 0 ? result.members : [...previous, ...result.members])
      setNextOffset(result.nextOffset)
      setDirectoryOpen(true)
    })
  }
  async function submitResearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    await perform('research', async () => {
      await memberFetch('/api/member/research', { method: 'POST', body: JSON.stringify({
        entity: String(data.get('entity') ?? '').trim(), claim: String(data.get('claim') ?? '').trim(),
        sources: String(data.get('sources') ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        reasoning: String(data.get('reasoning') ?? '').trim(), counterargument: String(data.get('counterargument') ?? '').trim(),
        invalidation: String(data.get('invalidation') ?? '').trim(),
      }) })
      form.reset()
      setNotice('Research received. Points remain pending until the review is complete.')
      await loadPanels()
    })
  }
  const nextRankAt = (Math.floor(profile.research.points / 10) + 1) * 10
  const researchUnlocked = profile.quests.some((quest) => quest.id === 'research-500' && quest.status !== 'locked')
  return <section id="profile" className="member-dashboard">
    <div className="wrap">
      <div className="member-dashboard__heading"><div><span className="eyebrow">Your member record</span><h1>{profile.userId}<span className="grad">, welcome in.</span></h1><p className="member-muted">The next useful idea starts with a good question.</p></div><button type="button" className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => perform('signout', signOut)}>Sign out</button></div>
      {notice ? <p className="member-notice member-notice--success" role="status">{notice}</p> : null}
      {error ? <p className="member-notice member-notice--error" role="alert">{error}</p> : null}
      {panelErrors.length ? <p className="member-notice" role="status">{panelErrors.join(', ')} could not load. <button type="button" className="member-text-button" onClick={() => void loadPanels()}>Try again</button></p> : null}
      <div className="member-overview">
        <div className="card member-rank-card"><span className="member-caption">Research rank</span><div className="member-rank-number">{String(profile.research.rank).padStart(2, '0')}<span>{profile.research.title}</span></div><div className="member-between"><strong>{profile.research.points} points</strong><span>{profile.research.goal} to complete the quest</span></div><Meter value={profile.research.points} max={profile.research.goal} label="Research quest progress" /><small>Rank advances every 10 research points. Next rank at {nextRankAt}.</small></div>
        <div className="card member-network-card"><span className="member-caption">Your invitation network</span><div className="member-network-numbers"><div><strong>{profile.referrals.directVerified}</strong><span>Direct members</span></div><div><strong>{profile.referrals.networkReach}</strong><span>Network reach</span></div></div><span className="member-pill">Community rank {profile.referrals.rank} · {profile.referrals.title}</span><small>Verified memberships build your network title. Research points are earned separately.</small></div>
        <div className="card member-clock-card"><Countdown countdown={profile.countdown} /><span className="member-caption">Member since {dateLabel(profile.joinedAt)}</span></div>
      </div>
      <div className="member-layout">
        <div className="member-stack">
          <article className="card member-panel" id="member-quests"><div className="member-panel__heading"><div><span className="eyebrow">The journey</span><h2>Your next move.</h2></div><span className="member-caption">Progress saved</span></div><ol className="member-quests">{profile.quests.map((quest, index) => <li key={quest.id} className={`member-quest member-quest--${quest.status}`}><div className="member-quest__number">{quest.status === 'complete' ? <Check /> : String(index + 1).padStart(2, '0')}</div><div><div className="member-between"><h3>{quest.title}</h3><span className="member-pill">{quest.status}</span></div><p className="member-muted">{quest.progress} / {quest.target}</p><Meter value={quest.progress} max={quest.target} label={`${quest.title} progress`} /></div></li>)}</ol></article>
          <article className="card member-panel" id="member-invites"><div className="member-panel__heading"><div><span className="eyebrow">Share your circle</span><h2>Ten invitations.<br />Choose thoughtfully.</h2></div><span className="member-pill">{profile.referrals.remainingInvites} / {profile.referrals.limit} available</span></div><p className="member-muted">Send an invitation to someone whose curiosity you trust. They receive their own ten invitations after verified signup. One verified invitation completes your first quest; using all ten is never required. Research points are earned through reviewed contributions.</p><form className="member-invite-form" onSubmit={createInvite}><div className="field"><label htmlFor="invite-email">Your guest’s email</label><input id="invite-email" name="inviteEmail" type="email" required maxLength={254} placeholder="someone@you-trust.com" disabled={!!busy || profile.referrals.remainingInvites <= 0} /></div><button className="btn btn--primary" disabled={!!busy || profile.referrals.remainingInvites <= 0}>{busy === 'invite' ? 'Creating…' : 'Create private invite'}<Arrow /></button></form>{inviteLink ? <div className="member-share"><label htmlFor="private-invite">Private invitation link · only this email can redeem it</label><div><input id="private-invite" readOnly value={inviteLink} onFocus={(event) => event.target.select()} /><button type="button" className="btn btn--ghost btn--sm" onClick={copyInvite}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</button></div></div> : null}<details className="member-details"><summary>Invitation slots</summary><ul className="member-list">{invites.length ? invites.map((invite) => <li key={invite.slot}><div><strong>#{invite.slot} · {prettyState(invite.status)}</strong><small>{invite.recipientEmail || 'Available to share'}</small></div>{invite.status === 'issued' || invite.status === 'reserved' ? <button type="button" className="member-text-button" disabled={!!busy} onClick={() => revokeInvite(invite.slot)}>Revoke invite</button> : null}</li>) : <li>No invitations loaded.</li>}</ul></details></article>
          <article className="card member-panel" id="member-research"><div className="member-panel__heading"><div><span className="eyebrow">One research inbox</span><h2>Make a case.<br />Show your sources.</h2></div></div><p className="member-muted">Submit a specific claim, the evidence behind it and what would change your mind. The review separates supported findings from uncertainty.</p><div className="member-rubric"><span><strong>0</strong> Unsupported or incorrect</span><span><strong>+1</strong> Useful, verified effort</span><span><strong>+3</strong> Substantial, verified research</span></div>{!profile.readiness.research ? <p className="member-notice">Research validation is not fully configured. Once your inbox is unlocked, submissions can be recorded and remain pending until review is available.</p> : null}<form className="form member-research-form" onSubmit={submitResearch}>{!researchUnlocked ? <p className="member-notice">Complete your invitation and Discord quests to open the research inbox.</p> : null}<fieldset disabled={!researchUnlocked || !!busy}><div className="field"><label htmlFor="research-entity">Company or topic</label><input id="research-entity" name="entity" required maxLength={100} placeholder="e.g. Company name and ticker" /></div><div className="field"><label htmlFor="research-claim">The claim you want reviewed</label><textarea id="research-claim" name="claim" required minLength={20} maxLength={2000} rows={3} placeholder="One clear, testable statement." /></div><div className="field"><label htmlFor="research-sources">Source links</label><textarea id="research-sources" name="sources" required maxLength={6000} rows={3} placeholder="One https:// source per line (up to 8)" /><small>Prefer filings, company disclosures and original research.</small></div><div className="field"><label htmlFor="research-reasoning">Why the evidence supports your claim</label><textarea id="research-reasoning" name="reasoning" required minLength={30} maxLength={5000} rows={4} /></div><div className="member-form-columns"><div className="field"><label htmlFor="research-counter">Strongest counterargument</label><textarea id="research-counter" name="counterargument" required minLength={10} maxLength={2000} rows={3} /></div><div className="field"><label htmlFor="research-invalid">What would change your mind?</label><textarea id="research-invalid" name="invalidation" required minLength={10} maxLength={1500} rows={3} /></div></div><button className="btn btn--primary" disabled={!!busy}>{busy === 'research' ? 'Submitting…' : 'Submit for review'}<Arrow /></button></fieldset><p className="member-caption">No rewards for speed, word count or repeated submissions. Review outcomes and awarded points appear below.</p></form><details className="member-details"><summary>Your submissions ({submissions.length})</summary><ul className="member-list member-list--vertical">{submissions.length ? submissions.map((item) => <li key={item.id}><div className="member-between"><strong>{item.entity}</strong><span className="member-pill">{prettyState(item.status)}</span></div><p>{item.claim}</p><small>{item.reason || 'Awaiting review.'} · {item.points == null ? 'Points pending' : `${item.points} points`}</small></li>) : <li>Your first research contribution will appear here.</li>}</ul></details></article>
        </div>
        <aside className="member-stack" aria-label="Membership tools and collection">
          <article className="card member-panel" id="member-discord"><span className="eyebrow"><Discord /> Member Discord</span><h2>The conversation continues.</h2><p className="member-muted">Connect your Discord account, then confirm through your registered email. Your public User ID alone cannot unlock the server.</p><span className="member-pill">{discord ? prettyState(discord.state) : 'Status unavailable'}</span>{discord?.discordUsername ? <p className="mono">{discord.discordUsername}</p> : null}{discord && !discord.questEligible ? <p className="member-caption">Complete your first invitation quest to unlock Discord verification.</p> : null}{!discord?.ready ? <p className="member-notice">Private Discord access is awaiting configuration. Your quest progress is preserved.</p> : <><button className="btn btn--primary" disabled={!!busy || !discord.questEligible || discord.state === 'verified'} onClick={() => perform('discord', async () => { const result = await memberFetch<{ authorizationUrl: string }>('/api/member/discord/start', { method: 'POST', body: '{}' }); const target = new URL(result.authorizationUrl); if (target.hostname !== 'discord.com' || target.protocol !== 'https:') throw new Error('Unexpected Discord authorization address.'); window.location.assign(target.href) })}>{discord.state === 'verified' ? 'Discord verified' : discord.state === 'email_pending' ? 'Reconnect Discord' : 'Connect Discord'}<Arrow /></button>{['pending_screening', 'join_retry', 'joining'].includes(discord.state) ? <button className="member-text-button" disabled={!!busy} onClick={() => perform('discord-refresh', async () => { await memberFetch('/api/member/discord/refresh', { method: 'POST', body: '{}' }); await Promise.all([refreshProfile(), loadPanels()]) })}>Check Discord access again</button> : null}{discord.state === 'email_pending' ? <p className="member-caption">Open the confirmation email in this registered browser to finish linking.</p> : null}{discord.discordUserId ? <button className="member-text-button" disabled={!!busy} onClick={() => perform('discord-unlink', async () => { await memberFetch('/api/member/discord/unlink', { method: 'POST', body: '{}' }); await Promise.all([refreshProfile(), loadPanels()]); setNotice('Discord unlink requested. Access removal status is shown above.') })}>Unlink Discord</button> : null}</>}</article>
          <article className="card member-panel"><span className="eyebrow">The collection</span><h2>A record of being here.</h2><p className="member-muted">Limited digital community collectibles. These are membership badges, not minted NFTs or financial assets.</p><div className="member-catalog">{profile.catalog.map((item) => <div className={`member-collectible member-collectible--${item.id}`} key={item.id}><div className="member-collectible__art">{item.id === 'moon' ? <img src="/badges/moon.png" alt="First Man on the Moon collectible artwork" width={320} height={320} loading="lazy" /> : <div className="member-collectible__trio">{['stargazer', 'techhead', 'wolf'].map((name) => <img key={name} src={`/badges/${name}.png`} alt={CHOICES[name].label} width={160} height={160} loading="lazy" />)}</div>}</div><span className="member-caption">x{item.cap} total</span><h3>{item.title}</h3><p className="member-caption">{item.id === 'moon' ? 'For the first 200 verified members.' : 'Choose one badge after one of the first 100 completed Discord verifications.'}</p><div className="member-between"><span>{item.remaining} remaining</span><span>{item.issued} awarded</span></div></div>)}</div>{profile.collectibles.length ? <div className="member-owned"><h3>Your collection</h3>{profile.collectibles.map((item) => <div key={item.collection}><strong>{item.title} #{item.serial}</strong><p className="member-muted">{item.choice ? CHOICES[item.choice]?.label || item.choice : 'Membership collectible'}</p>{item.selectable ? <div className="member-choices">{item.choices.map((choice) => <button type="button" key={choice} disabled={!!busy} onClick={() => perform('collectible', async () => { await memberFetch('/api/member/collectibles/discord-pioneer', { method: 'POST', body: JSON.stringify({ choice }) }); await refreshProfile(); setNotice('Your collectible choice has been saved.') })}><img src={`/badges/${choice}.png`} alt="" width={72} height={72} loading="lazy" /><strong>{CHOICES[choice]?.label || choice}</strong><small>{CHOICES[choice]?.description}</small></button>)}</div> : null}</div>)}</div> : <p className="member-caption">Earned collectibles appear here. Availability reflects actual awards.</p>}</article>
          <article className="card member-panel"><span className="eyebrow">Titles & achievements</span><h2>Depth earns distinction.</h2><ul className="member-title-list">{profile.titles.map((title) => <li key={title.id}><div className="member-between"><strong>{title.title}</strong>{title.earned ? <Check aria-label="Earned" /> : <span className="member-caption">{title.progress}/{title.target}</span>}</div><small>{title.earned ? 'Earned' : title.remaining == null ? 'No edition limit' : `${title.remaining} awards remaining`}</small></li>)}</ul></article>
          <article className="card member-panel"><span className="eyebrow">People, privately</span><h2>Meet the members.</h2><p className="member-muted">Member IDs, research ranks and titles. Emails and invitation links stay private.</p><button className="btn btn--ghost" disabled={!!busy} onClick={() => directoryOpen ? setDirectoryOpen(false) : void loadDirectory()}>{directoryOpen ? 'Close directory' : busy === 'directory' ? 'Loading…' : 'Open member directory'}</button>{directoryOpen ? <><ul className="member-list">{directory.map((member) => <li key={member.userId}><div><strong>{member.userId}</strong><small>{member.title}</small></div><span className="mono">#{member.rank}</span></li>)}</ul>{nextOffset != null ? <button className="member-text-button" disabled={!!busy} onClick={() => loadDirectory(nextOffset)}>Load more members</button> : null}</> : null}</article>
          <article className="card member-panel"><span className="eyebrow"><Shield /> Account access</span><h2>Your registered browsers.</h2><p className="member-muted">Two browser keys maximum. This is not a permanent hardware identifier. Keep this browser’s stored key to retain its registration.</p><ul className="member-list">{devices.length ? devices.map((device) => <li key={device.id}><div><strong>{device.label || device.name || 'Registered browser'}</strong><small>{device.current ? 'This browser' : `Last used ${dateLabel(device.lastUsedAt || device.createdAt)}`}</small></div>{!device.current ? <button type="button" className="member-text-button" disabled={!!busy} onClick={() => perform(`device-${device.id}`, async () => { await memberFetch(`/api/member/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }); await loadPanels(); setNotice('Browser key revoked. Its previous session no longer has access.') })}>Revoke</button> : <span className="member-pill">Current</span>}</li>) : <li>Browser registrations are loading.</li>}</ul><p className="member-caption">Lost a key? Use your other registered browser to revoke it before registering a replacement. If both are lost, ask the member who invited you to contact the community administrator. Account recovery requires review.</p></article>
        </aside>
      </div>
      <div className="member-dashboard__bottom"><Logo /><p>Curiosity earns a place. Evidence earns trust.</p><a href="#what" className="member-text-button">Explore what SAM is building <Arrow /></a></div>
    </div>
  </section>
}
