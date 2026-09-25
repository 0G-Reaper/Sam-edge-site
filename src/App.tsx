import { lazy, Suspense, useCallback, useState } from 'react'
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

const SamIntro = lazy(() => import('./components/SamIntro'))

export default function App() {
  const [intro, setIntro] = useState<'welcome' | 'replay' | null>(() => canPlayIntro() && !hasSeenIntro() ? 'welcome' : null)
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
      <Effects />
      {intro && (
        <Suspense fallback={null}>
          <SamIntro startWithSound={intro === 'replay'} onDone={closeIntro} />
        </Suspense>
      )}
    </>
  )
}
