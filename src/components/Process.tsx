import Reveal from './Reveal'

const STEPS = [
  { n: '01', title: 'Observe', body: 'Filings, prices, releases and the wire land continuously. SAM takes them in as they happen, from the source.' },
  { n: '02', title: 'Weigh', body: 'Not every story moves a stock. SAM separates the ones that did from the ones that only made noise.' },
  { n: '03', title: 'Calibrate', body: 'Each conclusion carries a confidence that was earned against outcomes, not asserted in a headline.' },
  { n: '04', title: 'Explain', body: 'You get plain-language context: what happened, why it likely happened, and how sure to be. Then the decision stays yours.' },
]

export default function Process() {
  return (
    <section id="how" className="process" aria-labelledby="how-title">
      <div className="wrap">
        <Reveal className="section-head">
          <span className="eyebrow">How SAM thinks</span>
          <h2 id="how-title">
            Four moves, <span className="grad">every single day.</span>
          </h2>
          <p className="lede">The same discipline a good desk runs on, applied to the whole market at once and written down for everyone.</p>
        </Reveal>
        <div className="process__grid">
          <div className="process__line" aria-hidden="true" />
          {STEPS.map((s, i) => (
            <Reveal key={s.n} className="step" delay={i * 0.12}>
              <div className="step__n">{s.n}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
