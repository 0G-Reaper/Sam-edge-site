import { formatLevel, formatPct, useMarkets, type IndexSeries } from '../lib/markets'
import Sparkline from './Sparkline'

const SKELETON: Array<{ key: string; name: string }> = [
  { key: 'DJI', name: 'Dow Jones' },
  { key: 'IXIC', name: 'NASDAQ' },
  { key: 'RUT', name: 'Russell 2000' },
]

export default function IndexCharts() {
  const { data, error } = useMarkets()
  const items = data?.items
  return (
    <div className="idx-row" aria-label="Index quick charts" aria-busy={!items && !error}>
      {(items ?? SKELETON).map((it, i) => (
        <IndexCard key={it.key} item={'closes' in it ? (it as IndexSeries) : null} name={it.name} symbol={it.key} failed={error} index={i} />
      ))}
    </div>
  )
}

function IndexCard({ item, name, symbol, failed, index }: { item: IndexSeries | null; name: string; symbol: string; failed: boolean; index: number }) {
  const live = item?.source === 'live'
  const up = (item?.changePct ?? 0) >= 0
  const asOf = item?.dates[item.dates.length - 1]
  return (
    <article className="card idx" style={{ animationDelay: `${index * 90}ms` }}>
      <header className="idx__head">
        <span className="idx__name">{name}</span>
        <span className="idx__sym mono">{symbol}</span>
      </header>
      <div className="idx__val">
        {item && live ? (
          <>
            <strong className="mono">{formatLevel(item.last)}</strong>
            <span className={`chip ${up ? 'chip--up' : 'chip--down'}`}>{formatPct(item.changePct)}</span>
          </>
        ) : (
          <>
            <strong className="mono idx__dash">{failed ? 'offline' : item ? 'sample' : '· · ·'}</strong>
            <span className="chip chip--muted">{item ? 'shape only' : failed ? 'no feed' : 'loading'}</span>
          </>
        )}
      </div>
      {item ? <Sparkline values={item.closes} up={up} /> : <div className="spark spark--skeleton" />}
      <footer className="idx__foot">
        {item && live ? `${item.closes.length} sessions · to ${asOf}` : item ? 'Sample shape while the feed is unavailable' : failed ? 'Index feed unavailable right now' : 'Fetching the last 30 sessions'}
      </footer>
    </article>
  )
}
