// Derives a roughness map from the photo-projected base colour by classifying each texel as
// skin, hair, blouse or suit cloth: node scripts/roughness-from-basecolor.mjs <basecolor.png> <out.png> [size]
import sharp from 'sharp'
import { readFileSync } from 'node:fs'

const [input, output = 'raw-assets/sam-roughness.png', sizeArg = '2048'] = process.argv.slice(2)
const size = Number(sizeArg)
const { data, info } = await sharp(readFileSync(input)).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const out = Buffer.alloc(info.width * info.height)
const counts = { skin: 0, hair: 0, blouse: 0, cloth: 0, other: 0 }
for (let i = 0; i < info.width * info.height; i++) {
  const r = data[i * 3] / 255, g = data[i * 3 + 1] / 255, b = data[i * 3 + 2] / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h = (h * 60 + 360) % 360
  }
  let rough, kind
  if (l < 0.22) { rough = 0.78; kind = 'cloth' }
  else if (h >= 8 && h <= 48 && sat >= 0.14 && l >= 0.42 && l <= 0.9) { rough = 0.5; kind = 'skin' }
  else if (h >= 8 && h <= 55 && sat >= 0.12 && l >= 0.22 && l < 0.42) { rough = 0.56; kind = 'hair' }
  else if (l > 0.62 && sat < 0.22) { rough = 0.72; kind = 'blouse' }
  else { rough = 0.7; kind = 'other' }
  out[i] = Math.round(rough * 255)
  counts[kind]++
}
await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).blur(1.6).png().toFile(output)
console.log('roughness map', output, info.width, 'x', info.height, counts)
