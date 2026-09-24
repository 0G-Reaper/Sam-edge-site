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
  const videoRef = useRef<HTMLVideoElement>(null)
  const [step, setStep] = useState(0)

  // The film plays on its own inside a bounded frame, only while it is on screen; with reduced
  // motion the poster stands in for it.
  useEffect(() => {
    const v = videoRef.current
    if (!v || prefersReducedMotion()) return
    v.src = window.innerWidth < 768 ? '/film/mobile.mp4' : '/film/desktop.mp4'
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) v.play().catch(() => {})
        else v.pause()
      },
      { threshold: 0.3 },
    )
    io.observe(v)
    return () => io.disconnect()
  }, [])

  // The highlighted idea follows the film: one idea per third of the loop.
  const onTime = () => {
    const v = videoRef.current
    if (!v || !(v.duration > 0)) return
    const s = Math.min(2, Math.floor((v.currentTime / v.duration) * 3))
    setStep((p) => (p === s ? p : s))
  }

  return (
    <section id="what" className="explainer" aria-labelledby="what-title">
      <div className="wrap explainer__grid">
        <div className="explainer__copy">
          <span className="eyebrow">What a synthetic analyst model is</span>
          <h2 id="what-title">
            An analyst that never sleeps, never guesses, <span className="grad">and always shows its work.</span>
          </h2>
          <p className="lede">
            A synthetic analyst model is software that does what a good analyst does, at a scale no desk can match: it reads the record, separates signal from noise, and explains itself in plain language. It does not predict. It informs.
          </p>
        </div>
        <figure className="film" aria-hidden="true">
          <video ref={videoRef} poster="/film/poster.jpg" muted loop playsInline preload="metadata" onTimeUpdate={onTime} />
          <div className="film__shade" />
          <figcaption className="film__cap">
            <i />
            Signal, separated from noise
          </figcaption>
        </figure>
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
    </section>
  )
}
