import { readSiteConfig } from '../lib/site'
import { Discord, Instagram, Logo } from './Icons'

export default function Footer({ onMeetSam }: { onMeetSam: () => void }) {
  const cfg = readSiteConfig()
  return (
    <footer className="footer">
      <div className="wrap footer__grid">
        <div className="footer__brand">
          <div className="brand">
            <Logo />
            <div>
              <strong>SAM</strong>
              <span>Synthetic Analyst Model</span>
            </div>
          </div>
          <p className="footer__disc">
            For informational and educational purposes only. Nothing on this site is financial advice, a recommendation, or an offer to buy or sell any security. Markets carry risk; decisions stay yours.
          </p>
        </div>
        <nav className="footer__links" aria-label="Footer">
          <a href="#what">What SAM is</a>
          <a href="#how">How it thinks</a>
          <a href="#app">The app</a>
          <a href="#who">Who we are</a>
          <a href="#waitlist">Join the waitlist</a>
          <button type="button" onClick={onMeetSam}>Replay the introduction</button>
        </nav>
        <div className="footer__social">
          <span className="eyebrow">Find us</span>
          {cfg.instagram ? (
            <a className="social" href={cfg.instagram} target="_blank" rel="noopener noreferrer">
              <Instagram /> Instagram
            </a>
          ) : (
            <span className="social social--soon">
              <Instagram /> Instagram <em>coming soon</em>
            </span>
          )}
          {cfg.discord ? (
            <a className="social" href={cfg.discord} target="_blank" rel="noopener noreferrer">
              <Discord /> Discord
            </a>
          ) : (
            <span className="social social--soon">
              <Discord /> Discord <em>opening soon</em>
            </span>
          )}
        </div>
      </div>
      <div className="wrap footer__bottom">
        <span>© {new Date().getFullYear()} SAM. All rights reserved.</span>
        <span>Built with care by people from the desk.</span>
      </div>
    </footer>
  )
}
