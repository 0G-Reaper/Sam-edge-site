import { useEffect, useState } from 'react'

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

export function useMarkets(): { data: MarketsPayload | null; error: boolean } {
  const [data, setData] = useState<MarketsPayload | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const ac = new AbortController()
    fetch('/api/markets', { signal: ac.signal, headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<MarketsPayload>) : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => {
        if (!ac.signal.aborted) setError(true)
      })
    return () => ac.abort()
  }, [])
  return { data, error }
}

export function formatLevel(v: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: v >= 10_000 ? 0 : 2, minimumFractionDigits: v >= 10_000 ? 0 : 2 }).format(v)
}

export function formatPct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(2)}%`
}
