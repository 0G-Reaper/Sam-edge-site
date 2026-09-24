/**
 * Daily closes for three headline indexes, cached in memory.
 * Sources are tried in order; if none answers, a clearly labelled sample shape is
 * returned so the page never breaks and never pretends sample data is live.
 */
export interface IndexSeries {
  key: string
  name: string
  dates: string[]
  closes: number[]
  last: number
  changePct: number
  source: 'live' | 'illustrative'
}

export interface MarketsPayload {
  asOf: string
  items: IndexSeries[]
}

interface IndexSpec {
  key: string
  name: string
  csvSymbol: string
  chartSymbol: string
}

const INDEXES: IndexSpec[] = [
  { key: 'DJI', name: 'Dow Jones', csvSymbol: '^dji', chartSymbol: '^DJI' },
  { key: 'IXIC', name: 'NASDAQ', csvSymbol: '^ndq', chartSymbol: '^IXIC' },
  { key: 'RUT', name: 'Russell 2000', csvSymbol: '^rut', chartSymbol: '^RUT' },
]

const POINTS = 30
const LIVE_TTL_MS = 30 * 60_000
const FALLBACK_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 6_000

export interface MarketDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

let cache: { at: number; ttl: number; payload: MarketsPayload } | null = null

export function resetMarketsCache(): void {
  cache = null
}

export async function getMarkets(deps: MarketDeps = {}): Promise<MarketsPayload> {
  const now = deps.now ?? Date.now
  const t = now()
  if (cache && t - cache.at < cache.ttl) return cache.payload
  const fetchImpl = deps.fetchImpl ?? fetch
  const items = await Promise.all(INDEXES.map((spec) => loadIndex(spec, fetchImpl)))
  const allLive = items.every((i) => i.source === 'live')
  const payload: MarketsPayload = { asOf: new Date(t).toISOString(), items }
  cache = { at: t, ttl: allLive ? LIVE_TTL_MS : FALLBACK_TTL_MS, payload }
  return payload
}

async function loadIndex(spec: IndexSpec, fetchImpl: typeof fetch): Promise<IndexSeries> {
  const attempts: Array<() => Promise<Series | null>> = [
    () => fromCsv(spec.csvSymbol, fetchImpl),
    () => fromChart(spec.chartSymbol, fetchImpl),
  ]
  for (const attempt of attempts) {
    try {
      const series = await attempt()
      if (series && series.closes.length >= 5) return finish(spec, series, 'live')
    } catch {
      // try the next source
    }
  }
  return finish(spec, illustrative(spec.key), 'illustrative')
}

interface Series {
  dates: string[]
  closes: number[]
}

function finish(spec: IndexSpec, series: Series, source: IndexSeries['source']): IndexSeries {
  const dates = series.dates.slice(-POINTS)
  const closes = series.closes.slice(-POINTS)
  const last = closes[closes.length - 1] ?? 0
  const prev = closes[closes.length - 2] ?? last
  const changePct = prev ? ((last - prev) / prev) * 100 : 0
  return { key: spec.key, name: spec.name, dates, closes, last, changePct, source }
}

async function fromCsv(symbol: string, fetchImpl: typeof fetch): Promise<Series | null> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'text/csv,*/*' } })
  if (!res.ok) return null
  const text = await res.text()
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2 || !/^date/i.test(lines[0]!)) return null
  const dates: string[] = []
  const closes: number[] = []
  for (const line of lines.slice(1)) {
    const cols = line.split(',')
    const close = Number(cols[4])
    if (!cols[0] || !Number.isFinite(close)) continue
    dates.push(cols[0])
    closes.push(close)
  }
  return { dates, closes }
}

async function fromChart(symbol: string, fetchImpl: typeof fetch): Promise<Series | null> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (compatible; sam-edge-site/1.0)' },
  })
  if (!res.ok) return null
  const json = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> }
  }
  const result = json.chart?.result?.[0]
  const stamps = result?.timestamp ?? []
  const raw = result?.indicators?.quote?.[0]?.close ?? []
  const dates: string[] = []
  const closes: number[] = []
  stamps.forEach((s, i) => {
    const c = raw[i]
    if (typeof c === 'number' && Number.isFinite(c)) {
      dates.push(new Date(s * 1000).toISOString().slice(0, 10))
      closes.push(c)
    }
  })
  return { dates, closes }
}

/** A deterministic random walk, normalised to 100, used only when no source answers. */
export function illustrative(seedText: string): Series {
  let seed = 0
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
  const rand = mulberry32(seed || 1)
  const closes: number[] = []
  const dates: string[] = []
  let v = 100
  const day = 86_400_000
  const start = Date.now() - POINTS * day
  for (let i = 0; i < POINTS; i++) {
    v = v * (1 + (rand() - 0.48) * 0.018)
    closes.push(Number(v.toFixed(2)))
    dates.push(new Date(start + i * day).toISOString().slice(0, 10))
  }
  return { dates, closes }
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
