// The photo projection paints whatever the camera saw onto the first surface it hit, so hair
// strands hanging in front of the face pick up skin (and strands over the chest pick up blouse).
// Where the generator's own texture was hair-coloured and the projection turned it much brighter,
// fall back to the generator's texel: node scripts/fix-projection.mjs <raw.glb> <projected.png> <out.png>
import sharp from 'sharp'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { readFileSync } from 'node:fs'

const [rawGlb, projected, out = 'raw-assets/sam-basecolor-4k-fixed.png'] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(rawGlb)
const tex = doc.getRoot().listTextures()[0]
const size = 4096
const orig = await sharp(Buffer.from(tex.getImage())).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer()
const proj = await sharp(readFileSync(projected)).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer()
const hsl = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min)) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h = (h * 60 + 360) % 360
  }
  return [h, sat, l]
}
const mask = Buffer.alloc(size * size)
let flagged = 0
for (let i = 0; i < size * size; i++) {
  const [ho, so, lo] = hsl(orig[i * 3] / 255, orig[i * 3 + 1] / 255, orig[i * 3 + 2] / 255)
  const [hn, sn, ln] = hsl(proj[i * 3] / 255, proj[i * 3 + 1] / 255, proj[i * 3 + 2] / 255)
  const hairLike = lo < 0.5 && (so < 0.3 || (ho >= 8 && ho <= 55))
  const skinNew = hn >= 8 && hn <= 48 && sn >= 0.14 && ln >= 0.45
  const brightNew = ln > 0.66 && sn < 0.3
  if (hairLike && ln - lo > 0.16 && (skinNew || brightNew)) { mask[i] = 255; flagged++ }
}
const soft = await sharp(mask, { raw: { width: size, height: size, channels: 1 } }).blur(2).raw().toBuffer()
const result = Buffer.alloc(size * size * 3)
for (let i = 0; i < size * size; i++) {
  const m = soft[i] / 255
  for (let c = 0; c < 3; c++) result[i * 3 + c] = Math.round(proj[i * 3 + c] * (1 - m) + orig[i * 3 + c] * m)
}
await sharp(result, { raw: { width: size, height: size, channels: 3 } }).png().toFile(out)
console.log(`reverted ${(100 * flagged / (size * size)).toFixed(2)}% of texels to the generator's hair; wrote ${out}`)
