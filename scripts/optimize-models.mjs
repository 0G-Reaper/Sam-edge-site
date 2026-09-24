// Builds public/models/sam.glb from the raw rigged exports:
//   node scripts/optimize-models.mjs raw-assets/sam-walk.glb raw-assets/sam-talk.glb [out.glb] \
//        [--basecolor img] [--roughness img] [--normal img] [--size 3072] [--quality 82]
// The walk file supplies the mesh, skin and walk clip; the talk file's clip is
// retargeted onto the same skeleton by joint name. Textures are resized to WebP
// and the geometry is meshopt-compressed. Optional flags replace the generated
// base colour with a photo-projected one, add a roughness map (grey image, packed
// into the glTF metallic-roughness green channel) and a normal map, and set the
// material to a physically sensible non-metallic, non-emissive skin/cloth response.
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, meshopt, prune, resample, textureCompress } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import { readFileSync, statSync } from 'node:fs'

const args = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) flags[args[i].slice(2)] = args[++i]
    else flags[args[i].slice(2)] = true
  } else positional.push(args[i])
}
const [walkPath, talkPath, outPath = 'public/models/sam.glb'] = positional
if (!walkPath) throw new Error('usage: optimize-models.mjs <walk.glb> [talk.glb] [out.glb] [--basecolor img] [--roughness img] [--normal img] [--size N] [--quality Q] [--smooth-normals]')
const size = Number(flags.size ?? 2048)
const quality = Number(flags.quality ?? 84)

await MeshoptEncoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })

const doc = await io.read(walkPath)
const root = doc.getRoot()
const walkAnim = root.listAnimations()[0]
if (walkAnim) walkAnim.setName('walk')
for (const extra of root.listAnimations().slice(1)) extra.dispose()

if (talkPath) {
  const talkDoc = await io.read(talkPath)
  const src = talkDoc.getRoot().listAnimations()[0]
  if (!src) throw new Error('talk file has no animation')
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]))
  const buffer = root.listBuffers()[0] ?? doc.createBuffer()
  const anim = doc.createAnimation('talk')
  let copied = 0
  for (const ch of src.listChannels()) {
    const target = ch.getTargetNode()
    const node = target && byName.get(target.getName())
    const s = ch.getSampler()
    if (!node || !s) continue
    const input = doc.createAccessor().setType('SCALAR').setArray(s.getInput().getArray().slice()).setBuffer(buffer)
    const output = doc.createAccessor().setType(s.getOutput().getType()).setArray(s.getOutput().getArray().slice()).setBuffer(buffer)
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation())
    const channel = doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(sampler)
    anim.addSampler(sampler).addChannel(channel)
    copied++
  }
  console.log(`talk clip: ${copied}/${src.listChannels().length} channels retargeted`)
}

// Material normalisation. The generator exports metallic=1 with the colour map
// wired to emission, which renders as lit chrome; people are dielectric.
const png = async (path) => ({ data: await sharp(readFileSync(path)).png().toBuffer(), mime: 'image/png' })
const targetName = flags.material ?? 'Material_1'
for (const mat of root.listMaterials()) {
  mat.setMetallicFactor(0).setEmissiveFactor([0, 0, 0])
  const isTarget = mat.getName() === targetName || root.listMaterials().length === 1
  const em = mat.getEmissiveTexture()
  if (em) mat.setEmissiveTexture(null)
  for (const ext of mat.listExtensions()) ext.dispose()
  if (flags.basecolor && isTarget) {
    const { data, mime } = await png(flags.basecolor)
    const tex = doc.createTexture('basecolor').setImage(data).setMimeType(mime)
    mat.setBaseColorTexture(tex)
  }
  if (flags.roughness && isTarget) {
    // glTF packs occlusion/roughness/metallic into R/G/B; keep R=1 (no AO), B=0 (dielectric).
    const g = await sharp(readFileSync(flags.roughness)).greyscale().raw().toBuffer({ resolveWithObject: true })
    const { width, height } = g.info
    const rgb = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) {
      rgb[i * 3] = 255
      rgb[i * 3 + 1] = g.data[i]
      rgb[i * 3 + 2] = 0
    }
    const data = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
    const tex = doc.createTexture('roughness').setImage(data).setMimeType('image/png')
    mat.setMetallicRoughnessTexture(tex).setRoughnessFactor(1)
  } else if (!mat.getMetallicRoughnessTexture()) {
    mat.setRoughnessFactor(Number(flags['rough-factor'] ?? 0.62))
  }
  if (flags.normal && isTarget) {
    const { data, mime } = await png(flags.normal)
    const tex = doc.createTexture('normal').setImage(data).setMimeType(mime)
    mat.setNormalTexture(tex).setNormalScale(Number(flags['normal-scale'] ?? 0.6))
  }
  console.log(`material ${mat.getName()}: metallic ${mat.getMetallicFactor()} roughness ${mat.getRoughnessFactor()} emissive ${mat.getEmissiveFactor()}`)
}

// Seam-aware smooth normals: vertices split by UV seams share a position, so averaging by
// position gives one continuous normal field across the seam instead of a visible crease.
function smoothNormals(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      const idx = prim.getIndices()
      if (!pos || !idx) continue
      const p = pos.getArray()
      const ind = idx.getArray()
      const n = pos.getCount()
      const acc = new Float32Array(n * 3)
      const key = new Array(n)
      const byKey = new Map()
      for (let i = 0; i < n; i++) {
        const k = `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`
        key[i] = k
        let list = byKey.get(k)
        if (!list) byKey.set(k, (list = []))
        list.push(i)
      }
      const fn = new Float32Array(3)
      for (let t = 0; t < ind.length; t += 3) {
        const a = ind[t], b = ind[t + 1], c = ind[t + 2]
        const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2]
        const bx = p[b * 3] - ax, by = p[b * 3 + 1] - ay, bz = p[b * 3 + 2] - az
        const cx = p[c * 3] - ax, cy = p[c * 3 + 1] - ay, cz = p[c * 3 + 2] - az
        fn[0] = by * cz - bz * cy
        fn[1] = bz * cx - bx * cz
        fn[2] = bx * cy - by * cx
        for (const v of [a, b, c]) {
          acc[v * 3] += fn[0]
          acc[v * 3 + 1] += fn[1]
          acc[v * 3 + 2] += fn[2]
        }
      }
      const out = new Float32Array(n * 3)
      for (const list of byKey.values()) {
        let x = 0, y = 0, z = 0
        for (const v of list) { x += acc[v * 3]; y += acc[v * 3 + 1]; z += acc[v * 3 + 2] }
        const len = Math.hypot(x, y, z) || 1
        for (const v of list) { out[v * 3] = x / len; out[v * 3 + 1] = y / len; out[v * 3 + 2] = z / len }
      }
      const existing = prim.getAttribute('NORMAL')
      const normal = doc.createAccessor('smooth-normals').setType('VEC3').setArray(out).setBuffer(pos.getBuffer())
      prim.setAttribute('NORMAL', normal)
      if (existing && existing.listParents().length <= 1) existing.dispose()
      console.log(`smooth normals: ${mesh.getName()} ${n} vertices, ${byKey.size} unique positions`)
    }
  }
}

if ('smooth-normals' in flags) smoothNormals(doc)

const before = root.listTextures().map((t) => `${t.getName() || 'tex'} ${t.getSize()?.join('x')} ${t.getMimeType()}`)
console.log('textures before:', before)

await doc.transform(
  dedup(),
  prune({ keepLeaves: true, keepAttributes: false }),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
)
await io.write(outPath, doc)
console.log(`wrote ${outPath}: ${(statSync(outPath).size / 1e6).toFixed(2)} MB; clips: ${root.listAnimations().map((a) => `${a.getName()} (${a.listChannels().length} ch)`).join(', ')}; textures: ${root.listTextures().map((t) => `${t.getName()} ${t.getSize()?.join('x')}`).join(', ')}`)
