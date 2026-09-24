import { Book, Shield, Users } from './Icons'
import Reveal from './Reveal'

const PILLARS = [
  { Icon: Book, title: 'Education first', body: 'Every screen teaches something. We would rather you understand a move than follow one.' },
  { Icon: Users, title: 'A community, not an audience', body: 'Traders learning together, comparing notes, and holding each other to a higher standard of evidence.' },
  { Icon: Shield, title: 'No tips, ever', body: 'We give you context and the confidence behind it. What you do with it is yours, and it should be.' },
]

export default function WhoWeAre() {
  return (
    <section id="who" className="who" aria-labelledby="who-title">
      <div className="wrap who__grid">
        <Reveal className="who__copy">
          <span className="eyebrow">Who we are</span>
          <h2 id="who-title">
            Built by people from the desk, <span className="grad">for everyone outside it.</span>
          </h2>
          <p>
            We are financial industry professionals who spent years watching good information reach the wrong people first. In markets like these, that gap is expensive, and it is paid by the people who can least afford it.
          </p>
          <p>
            <strong>So we built SAM to close it.</strong> Our mission is to give the public the same calibrated, source-backed context a professional desk takes for granted, and to grow a community of traders who learn together instead of guessing alone.
          </p>
          <p>We do not sell signals. We do not manage money. We teach, we explain, and we show our work.</p>
          <ul className="values" aria-label="Our values">
            <li>Transparency</li>
            <li>Calibration over confidence</li>
            <li>Plain language</li>
            <li>Community first</li>
          </ul>
        </Reveal>
        <div className="pillars">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={0.08 * i}>
              <article className="card pillar">
                <div className="icon">
                  <p.Icon />
                </div>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
