// Tileable skin micro-detail normal map: a field of shallow pores and fine creases turned into
// tangent-space normals. node scripts/pore-normal.mjs <out.png> [size]
import sharp from 'sharp'
const [out = 'raw-assets/pores-normal.png', sizeArg = '1024'] = process.argv.slice(2)
const N = Number(sizeArg)
let seed = 1337
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const height = new Float32Array(N * N)
// pores: small gaussian dips scattered at ~60 px spacing on a 1024 map (tile ≈ 3 cm of skin)
const pores = Math.round((N / 1024) ** 2 * 5200)
for (let i = 0; i < pores; i++) {
  const cx = rand() * N, cy = rand() * N, rad = 1.6 + rand() * 2.2, depth = 0.35 + rand() * 0.65
  const r2 = Math.ceil(rad * 3)
  for (let dy = -r2; dy <= r2; dy++) for (let dx = -r2; dx <= r2; dx++) {
    const x = ((Math.round(cx) + dx) % N + N) % N, y = ((Math.round(cy) + dy) % N + N) % N
    const f = Math.exp(-(dx * dx + dy * dy) / (2 * rad * rad))
    height[y * N + x] -= depth * f
  }
}
// fine creases: two families of faint, slightly wavy lines
const creases = Math.round((N / 1024) ** 2 * 260)
for (let i = 0; i < creases; i++) {
  const x0 = rand() * N, y0 = rand() * N, ang = rand() * Math.PI, len = 40 + rand() * 120, amp = 0.08 + rand() * 0.1
  const dx = Math.cos(ang), dy = Math.sin(ang)
  for (let t = 0; t < len; t++) {
    const wob = Math.sin(t * 0.15 + i) * 1.5
    const x = ((Math.round(x0 + dx * t - dy * wob) % N) + N) % N, y = ((Math.round(y0 + dy * t + dx * wob) % N) + N) % N
    height[y * N + x] -= amp
  }
}
// low-frequency skin cells: gentle bumps between the pores
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const v = Math.sin(x * 0.19 + Math.sin(y * 0.07) * 2) * Math.cos(y * 0.17 + Math.sin(x * 0.05) * 2)
  height[y * N + x] += v * 0.05
}
const rgb = Buffer.alloc(N * N * 3)
const strength = 2.2
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const l = height[y * N + ((x - 1 + N) % N)], r = height[y * N + ((x + 1) % N)]
  const u = height[((y - 1 + N) % N) * N + x], d = height[((y + 1) % N) * N + x]
  let nx = -(r - l) * strength, ny = -(d - u) * strength, nz = 1
  const inv = 1 / Math.hypot(nx, ny, nz); nx *= inv; ny *= inv; nz *= inv
  const i = (y * N + x) * 3
  rgb[i] = Math.round((nx * 0.5 + 0.5) * 255); rgb[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); rgb[i + 2] = Math.round((nz * 0.5 + 0.5) * 255)
}
await sharp(rgb, { raw: { width: N, height: N, channels: 3 } }).png().toFile(out)
console.log('wrote', out, N, 'x', N, 'pores', pores, 'creases', creases)
