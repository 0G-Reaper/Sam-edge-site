import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/intro'
import { Eye, Gauge, Scale } from './Icons'

const IDEAS = [
  {
    n: '01',
    title: 'It reads, not predicts',
    body: 'Filings, releases, prices and the wire, as they land. SAM works from the primary record, not from what someone said about it.',
    Icon: Eye,
  },
  {
    n: '02',
    title: 'It weighs, not shouts',
    body: 'Every headline claims to matter. SAM measures which ones actually moved prices, and by how much, so context arrives with a weight attached.',
    Icon: Scale,
  },
  {
    n: '03',
    title: 'It measures itself',
    body: 'Every conclusion is scored against what happened next. Confidence is earned from a track record, never asserted.',
    Icon: Gauge,
  },
]

export default function Explainer() {
  const ref = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const barRef = useRef<HTMLElement>(null)
  const [step, setStep] = useState(0)

  useEffect(() => {
    const el = ref.current
    const v = videoRef.current
    if (!el || !v) return
    const reduced = prefersReducedMotion()
    v.src = window.innerWidth < 768 ? '/film/mobile.mp4' : '/film/desktop.mp4'
    v.load()
    let target = 0
    let current = 0
    let raf = 0
    let ticking = false
    let lastStep = -1
    const tick = () => {
      current += (target - current) * 0.16
      if (Number.isFinite(v.duration) && v.duration > 0 && v.readyState >= 1) {
        const t = current * Math.max(0, v.duration - 0.06)
        if (Math.abs(v.currentTime - t) > 0.015) {
          try {
            v.currentTime = t
          } catch {
            /* seeking not ready yet */
          }
        }
      }
      if (Math.abs(target - current) > 0.0015) raf = requestAnimationFrame(tick)
      else ticking = false
    }
    const onScroll = () => {
      const r = el.getBoundingClientRect()
      const total = r.height - window.innerHeight
      const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0
      target = p
      if (barRef.current) barRef.current.style.width = `${p * 100}%`
      const s = p < 0.34 ? 0 : p < 0.67 ? 1 : 2
      if (s !== lastStep) {
        lastStep = s
        setStep(s)
      }
      if (!reduced && !ticking) {
        ticking = true
        raf = requestAnimationFrame(tick)
      }
    }
    const unlock = () => {
      v.play()
        .then(() => v.pause())
        .catch(() => {})
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('touchstart', unlock, { passive: true, once: true })
    onScroll()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('touchstart', unlock)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <section id="what" className="explainer" aria-labelledby="what-title">
      <div className="scrub" ref={ref}>
        <div className="scrub__sticky">
          <video ref={videoRef} className="scrub__video" poster="/film/poster.jpg" muted playsInline preload="auto" aria-hidden="true" />
          <div className="scrub__shade" />
          <div className="scrub__progress" aria-hidden="true">
            <i ref={barRef} />
          </div>
          <div className="wrap scrub__copy">
            <span className="eyebrow">What a synthetic analyst model is</span>
            <h2 id="what-title">
              An analyst that never sleeps, never guesses, <span className="grad">and always shows its work.</span>
            </h2>
            <p className="lede">
              A synthetic analyst model is software that does what a good analyst does, at a scale no desk can match: it reads the record, separates signal from noise, and explains itself in plain language. It does not predict. It informs.
            </p>
          </div>
          <div className="wrap ideas">
            {IDEAS.map((idea, i) => (
              <article key={idea.n} className={`card idea${i === step ? ' is-active' : ''}`}>
                <span className="idea__n">{idea.n} / 03</span>
                <div className="icon">
                  <idea.Icon />
                </div>
                <h3>{idea.title}</h3>
                <p>{idea.body}</p>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
