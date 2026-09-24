import { useId } from 'react'

interface Props {
  values: number[]
  up: boolean
  height?: number
}

function smooth(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  let d = `M${points[0]![0]},${points[0]![1]}`
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!
    const [x1, y1] = points[i]!
    const mx = (x0 + x1) / 2
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`
  }
  return d
}

export default function Sparkline({ values, up, height = 72 }: Props) {
  const id = useId().replace(/:/g, '')
  const w = 300
  const h = height
  const pad = 6
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts: Array<[number, number]> = values.map((v, i) => [
    pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2),
    pad + (1 - (v - min) / span) * (h - pad * 2),
  ])
  const line = smooth(pts)
  const last = pts[pts.length - 1]
  const area = `${line} L${last ? last[0] : w},${h} L${pts[0] ? pts[0][0] : 0},${h} Z`
  const color = up ? 'var(--up)' : 'var(--down)'
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${values.length} sessions, ${up ? 'up' : 'down'} on the day`}>
      <defs>
        <linearGradient id={`a${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.36" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={`f${id}`} x="-10%" y="-40%" width="120%" height="180%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={area} fill={`url(#a${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" filter={`url(#f${id})`} vectorEffect="non-scaling-stroke" />
      {last && (
        <>
          <circle className="spark__pulse" cx={last[0]} cy={last[1]} r="6" fill={color} opacity="0.35" />
          <circle cx={last[0]} cy={last[1]} r="3" fill={color} />
        </>
      )}
    </svg>
  )
}
