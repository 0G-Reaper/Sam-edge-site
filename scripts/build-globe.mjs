// Samples a Fibonacci sphere and keeps the points that fall on land, packed as
// int16 lat/lon pairs (hundredths of a degree) for the hero globe.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { geoContains } from 'd3-geo'
import { feature } from 'topojson-client'

const require = createRequire(import.meta.url)
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-110m.json'), 'utf8'))
const land = feature(topo, topo.objects.land)

const N = 30000
const golden = Math.PI * (3 - Math.sqrt(5))
const out = []
for (let i = 0; i < N; i++) {
  const y = 1 - (i / (N - 1)) * 2
  const r = Math.sqrt(1 - y * y)
  const theta = golden * i
  const x = Math.cos(theta) * r
  const z = Math.sin(theta) * r
  const lat = (Math.asin(y) * 180) / Math.PI
  const lon = (Math.atan2(z, x) * 180) / Math.PI
  if (geoContains(land, [lon, lat])) out.push(Math.round(lat * 100), Math.round(lon * 100))
}
mkdirSync('public/globe', { recursive: true })
writeFileSync('public/globe/land.bin', Buffer.from(new Int16Array(out).buffer))
console.log(`globe: ${out.length / 2} land points`)
