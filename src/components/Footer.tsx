import { readSiteConfig } from '../lib/site'
import { Discord, Instagram, Logo } from './Icons'

export default function Footer({ onMeetSam, memberMode = false }: { onMeetSam: () => void; memberMode?: boolean }) {
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
          {memberMode ? <>
            <a href="#member-quests">Your quests</a>
            <a href="#member-invites">Invitations</a>
            <a href="#member-research">Research inbox</a>
            <a href="#member-discord">Member Discord</a>
          </> : <>
            <a href="#what">What SAM is</a>
            <a href="#how">How it thinks</a>
            <a href="#app">The app</a>
            <a href="#who">Who we are</a>
          </>}
          <a href={memberMode ? '#profile' : '#waitlist'}>{memberMode ? 'Member profile' : 'Join the waitlist'}</a>
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
          {memberMode ? (
            <a className="social" href="#member-discord"><Discord /> Member Discord</a>
          ) : cfg.discord ? (
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
