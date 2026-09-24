import { motion, useMotionValue, useSpring, useTransform } from 'motion/react'
import appEdge from '../assets/art/app-edge.webp'
import type { PointerEvent } from 'react'
import { Arrow, Doc, Pulse, Radar } from './Icons'
import Reveal from './Reveal'

function Tilt() {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [9, -9]), { stiffness: 140, damping: 18 })
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-11, 11]), { stiffness: 140, damping: 18 })
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    x.set((e.clientX - r.left) / r.width - 0.5)
    y.set((e.clientY - r.top) / r.height - 0.5)
  }
  const reset = () => {
    x.set(0)
    y.set(0)
  }
  return (
    <motion.div className="tilt" style={{ rotateX, rotateY, transformPerspective: 1400 }} onPointerMove={onMove} onPointerLeave={reset}>
      <div className="tilt__halo" aria-hidden="true" />
      <img src={appEdge} alt="Three phone screens from the Edge app: the market pulse, the day's likely movers and a research view" width={1122} height={1402} loading="lazy" decoding="async" />
      <div className="tilt__badge" aria-hidden="true">
        <b>Edge, by SAM</b>
        <span>Calm by design. Honest about what it knows.</span>
      </div>
    </motion.div>
  )
}

export default function AppBand() {
  return (
    <section id="app" className="appband" aria-labelledby="app-title">
      <div className="wrap appband__grid">
        <Reveal>
          <Tilt />
        </Reveal>
        <Reveal className="appband__copy" delay={0.1}>
          <span className="eyebrow">The app</span>
          <h2 id="app-title">
            Join our <span className="grad">waitlist.</span>
          </h2>
          <p className="lede">
            Edge is the app SAM lives in. One screen for the market's pulse, the names likely to move, and the research behind both. Built for people who want to understand, not just react.
          </p>
          <ul className="perks">
            <li>
              <span className="icon"><Pulse /></span>
              <b>Market pulse</b>
              <span>Indexes, breadth and the day's shape, at a glance.</span>
            </li>
            <li>
              <span className="icon"><Radar /></span>
              <b>Likely movers</b>
              <span>The names with something real behind them, and the evidence for each.</span>
            </li>
            <li>
              <span className="icon"><Doc /></span>
              <b>Research and wire</b>
              <span>Company sheets, filings and the tape, explained rather than dumped.</span>
            </li>
          </ul>
          <div>
            <a className="btn btn--primary" href="#waitlist" data-magnetic>
              Reserve your place
              <Arrow />
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
