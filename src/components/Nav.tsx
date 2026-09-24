import { useEffect, useState } from 'react'
import { Logo } from './Icons'

const LINKS: Array<[string, string]> = [
  ['#what', 'What SAM is'],
  ['#how', 'How it thinks'],
  ['#app', 'The app'],
  ['#who', 'Who we are'],
]

export default function Nav({ onMeetSam }: { onMeetSam: () => void }) {
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [solid, setSolid] = useState(false)

  useEffect(() => {
    let last = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      setHidden(y > last && y > 140 && !open)
      setSolid(y > 24)
      last = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [open])

  return (
    <header className={`nav${hidden ? ' nav--hidden' : ''}${solid ? ' nav--solid' : ''}${open ? ' nav--open' : ''}`}>
      <div className="wrap nav__bar">
        <a href="#top" className="brand" aria-label="SAM, back to top">
          <Logo />
          <span className="brand__name">SAM</span>
          <span className="brand__tag">Edge</span>
        </a>
        <nav className="nav__links" aria-label="Sections">
          {LINKS.map(([href, label]) => (
            <a key={href} href={href} onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
          <button
            type="button"
            className="nav__meet"
            onClick={() => {
              setOpen(false)
              onMeetSam()
            }}
          >
            Meet SAM
          </button>
        </nav>
        <a href="#waitlist" className="btn btn--primary btn--sm nav__cta" data-magnetic>
          Join the waitlist
        </a>
        <button
          type="button"
          className="nav__burger"
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((o) => !o)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </header>
  )
}
