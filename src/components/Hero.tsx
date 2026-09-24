import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { hasWebGL } from '../lib/intro'
import { Arrow, Play } from './Icons'
import IndexCharts from './IndexCharts'
import MarketClocks from './MarketClocks'

const Globe = lazy(() => import('./Globe'))

function GlobeSlot() {
  const ref = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!hasWebGL() || !ref.current) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setReady(true)
          io.disconnect()
        }
      },
      { rootMargin: '240px' },
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [])
  return (
    <div className="globe-slot">
      <div ref={ref} className="globe-frame">
        <div className="orb" aria-hidden="true" />
        {ready && (
          <Suspense fallback={null}>
            <Globe />
          </Suspense>
        )}
      </div>
      <MarketClocks />
    </div>
  )
}

export default function Hero({ onMeetSam }: { onMeetSam: () => void }) {
  return (
    <section className="hero" id="top">
      <div className="wrap hero__grid">
        <motion.div className="hero__copy" initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}>
          <span className="eyebrow">
            <i className="pulse" />
            Meet SAM
          </span>
          <h1>
            Synthetic <span className="grad">Analyst Model</span>
          </h1>
          <p className="lede">
            Better information to think with. SAM reads the market's own record, weighs what actually moved prices, and hands you calibrated context. Never a tip.
          </p>
          <div className="hero__cta">
            <a className="btn btn--primary" href="#waitlist" data-magnetic>
              Join the waitlist
              <Arrow />
            </a>
            <button type="button" className="btn btn--ghost" onClick={onMeetSam} data-magnetic>
              <Play />
              Meet SAM
            </button>
          </div>
          <ul className="hero__proof">
            <li>Reads primary sources</li>
            <li>Weighs, never shouts</li>
            <li>Shows its work</li>
          </ul>
        </motion.div>
        <motion.div className="hero__visual" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}>
          <GlobeSlot />
        </motion.div>
      </div>
      <div className="wrap">
        <IndexCharts />
      </div>
    </section>
  )
}
