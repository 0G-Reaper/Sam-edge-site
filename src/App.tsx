import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import AppBand from './components/AppBand'
import Effects from './components/Effects'
import Explainer from './components/Explainer'
import Footer from './components/Footer'
import Hero from './components/Hero'
import Nav from './components/Nav'
import Process from './components/Process'
import Waitlist from './components/Waitlist'
import WhoWeAre from './components/WhoWeAre'
import { canPlayIntro, hasSeenIntro } from './lib/intro'
import { getMembershipStatus } from './lib/member-api'
import './components/MemberPortal.css'

const SamIntro = lazy(() => import('./components/SamIntro'))
const MemberPortal = lazy(() => import('./components/MemberPortal'))

export default function App() {
  const [intro, setIntro] = useState<'welcome' | 'replay' | null>(null)
  const [membership, setMembership] = useState<Awaited<ReturnType<typeof getMembershipStatus>> | null>(null)
  const [accessError, setAccessError] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  useEffect(() => {
    let active = true
    getMembershipStatus().then((status) => {
      if (!active) return
      setMembership(status)
      if (!status.enabled && canPlayIntro() && !hasSeenIntro()) setIntro('welcome')
    }).catch(() => { if (active) setAccessError(true) })
    return () => { active = false }
  }, [])
  const authenticationChanged = useCallback((signedIn: boolean) => {
    setAuthenticated(signedIn)
    if (!signedIn) setIntro(null)
    else if (canPlayIntro() && !hasSeenIntro()) setIntro('welcome')
  }, [])
  const meetSam = useCallback(() => {
    setIntro('replay')
  }, [])
  const closeIntro = useCallback(() => setIntro(null), [])

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <div className="aurora" />
        <div className="grid-overlay" />
        <div className="noise" />
      </div>
      {!membership ? (
        <main className="member-loading" aria-live="polite">
          <span className="eyebrow">SAM Edge</span>
          <h1>{accessError ? 'Access check unavailable.' : 'Opening your private workspace.'}</h1>
          <p>{accessError ? 'We could not verify membership access. Check your connection and try again.' : 'Checking membership access…'}</p>
          {accessError ? <button className="btn btn--primary" onClick={() => window.location.reload()}>Try again</button> : null}
        </main>
      ) : membership.enabled ? (
        <Suspense fallback={<main className="member-loading" role="status">Loading member access…</main>}>
          <MemberPortal status={membership} onAuthenticationChange={authenticationChanged} onMeetSam={meetSam}>
            <Hero onMeetSam={meetSam} memberMode />
            <Explainer />
            <Process />
            <AppBand memberMode />
            <WhoWeAre />
          </MemberPortal>
        </Suspense>
      ) : (
        <>
          <Nav onMeetSam={meetSam} />
          <main>
            <Hero onMeetSam={meetSam} />
            <Explainer />
            <Process />
            <AppBand />
            <WhoWeAre />
            <Waitlist />
          </main>
          <Footer onMeetSam={meetSam} />
        </>
      )}
      {membership && (!membership.enabled || authenticated) ? <Effects /> : null}
      {intro && membership && (!membership.enabled || authenticated) && (
        <Suspense fallback={null}>
          <SamIntro startWithSound={intro === 'replay'} onDone={closeIntro} />
        </Suspense>
      )}
    </>
  )
}
