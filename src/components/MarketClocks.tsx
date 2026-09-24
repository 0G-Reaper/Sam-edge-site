import { useEffect, useState } from 'react'

interface Clock {
  city: string
  tz: string
  open: [number, number]
  pos: string
}

const CLOCKS: Clock[] = [
  { city: 'New York', tz: 'America/New_York', open: [9.5, 16], pos: 'nyc' },
  { city: 'London', tz: 'Europe/London', open: [8, 16.5], pos: 'ldn' },
  { city: 'Tokyo', tz: 'Asia/Tokyo', open: [9, 15], pos: 'tyo' },
]

function read(clock: Clock, now: Date): { time: string; open: boolean } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: clock.tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const h = Number(get('hour')) + Number(get('minute')) / 60
  const weekend = /^(Sat|Sun)/.test(get('weekday'))
  return { time: `${get('hour')}:${get('minute')}`, open: !weekend && h >= clock.open[0] && h < clock.open[1] }
}

/** Local time and session status for three exchanges, refreshed every half minute. */
export default function MarketClocks() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <ul className="clocks" aria-label="Exchange sessions">
      {CLOCKS.map((c) => {
        const r = read(c, now)
        return (
          <li key={c.city} className={`clock clock--${c.pos}`}>
            <i className={r.open ? 'is-open' : ''} aria-hidden="true" />
            <span className="clock__city">{c.city}</span>
            <span className="clock__time mono">{r.time}</span>
            <span className="clock__state">{r.open ? 'Open' : 'Closed'}</span>
          </li>
        )
      })}
    </ul>
  )
}
