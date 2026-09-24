// Builds src/assets/sam.glb (bundled with a content hash) from the raw rigged exports:
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
const [walkPath, talkPath, outPath = 'src/assets/sam.glb'] = positional
if (!walkPath) throw new Error('usage: optimize-models.mjs <walk.glb> [talk.glb] [out.glb] [--basecolor img] [--roughness img] [--normal img] [--orm img] [--size N] [--quality Q] [--smooth-normals] [--mirror-talk] [--material name] [--pump-color r,g,b]')
const size = Number(flags.size ?? 2048)
const quality = Number(flags.quality ?? 84)

await MeshoptEncoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })

const doc = await io.read(walkPath)
const root = doc.getRoot()
// Clip naming: the walk file may already carry both clips (a Blender export); otherwise the
// first clip is the walk and the talk clip comes from the second file.
const anims = root.listAnimations()
const byHint = (hint) => anims.find((a) => a.getName().toLowerCase().includes(hint))
const walkAnim = byHint('walk') ?? anims[0]
if (walkAnim) walkAnim.setName('walk')
const talkInWalkFile = byHint('talk')
if (talkInWalkFile && talkInWalkFile !== walkAnim) talkInWalkFile.setName('talk')
for (const extra of anims) if (extra !== walkAnim && extra !== talkInWalkFile) extra.dispose()

if (talkPath && talkPath !== '-') {
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

// A left-right mirrored copy of a clip (reflection across the x=0 plane): left and right bones swap,
// rotations become (x, -y, -z, w) and root translations flip x. Gives a second, different gesture
// clip from one rigging job on a symmetric skeleton.
function mirrorClip(doc, source, name) {
  const root = doc.getRoot()
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]))
  const swap = (n) => (n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n)
  const buffer = root.listBuffers()[0]
  const anim = doc.createAnimation(name)
  for (const ch of source.listChannels()) {
    const target = ch.getTargetNode()
    const node = target && byName.get(swap(target.getName()))
    const s = ch.getSampler()
    if (!node || !s) continue
    const out = s.getOutput().getArray().slice()
    const path = ch.getTargetPath()
    if (path === 'rotation') for (let i = 0; i < out.length; i += 4) { out[i + 1] = -out[i + 1]; out[i + 2] = -out[i + 2] }
    else if (path === 'translation') for (let i = 0; i < out.length; i += 3) out[i] = -out[i]
    const input = doc.createAccessor().setType('SCALAR').setArray(s.getInput().getArray().slice()).setBuffer(buffer)
    const output = doc.createAccessor().setType(s.getOutput().getType()).setArray(out).setBuffer(buffer)
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation())
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler))
  }
  return anim
}

// Vertical grounding. A clip retargeted from another rig can carry that rig's hip height, which
// leaves the feet floating or sunk. Forward kinematics over the leg chains at the clip's first
// frame, compared with the rest pose, gives the hip offset that puts the lower foot on the floor.
const quatMul = (a, b) => {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}
const rotate = ([x, y, z, w], [vx, vy, vz]) => {
  const cx = y * vz - z * vy + w * vx
  const cy = z * vx - x * vz + w * vy
  const cz = x * vy - y * vx + w * vz
  return [vx + 2 * (y * cz - z * cy), vy + 2 * (z * cx - x * cz), vz + 2 * (x * cy - y * cx)]
}
function groundClip(doc, clip) {
  const root = doc.getRoot()
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]))
  const hips = byName.get('Hips')
  const sides = ['Left', 'Right'].map((s) => ({ foot: byName.get(`${s}Foot`), toe: byName.get(`${s}ToeBase`) })).filter((s) => s.foot && s.toe)
  if (!hips || !sides.length) return { dy: 0 }
  // The floor is the lowest vertex of the rest pose: the shoe soles and heel tips.
  let floor = Infinity
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const a = prim.getAttribute('POSITION')
      if (a) floor = Math.min(floor, a.getMin([0, 0, 0])[1])
    }
  }
  if (!Number.isFinite(floor)) return { dy: 0 }
  // Mesh vertices are in scene units; the joints live under the armature node, so convert.
  const armature = hips.getParentNode()
  if (armature) floor = (floor - armature.getTranslation()[1]) / (armature.getScale()[1] || 1)
  const tracks = new Map()
  let duration = 0
  for (const ch of clip.listChannels()) {
    const n = ch.getTargetNode()
    const s = ch.getSampler()
    const path = ch.getTargetPath()
    if (!n || !s || (path !== 'translation' && path !== 'rotation')) continue
    const e = tracks.get(n) ?? {}
    e[path === 'translation' ? 't' : 'r'] = s
    tracks.set(n, e)
    const inp = s.getInput().getArray()
    duration = Math.max(duration, inp[inp.length - 1])
  }
  const sample = (s, time, k) => {
    const inp = s.getInput().getArray()
    const out = s.getOutput().getArray()
    let i = 0
    while (i < inp.length - 2 && inp[i + 1] <= time) i++
    const j = Math.min(i + 1, inp.length - 1)
    const f = inp[j] > inp[i] ? Math.min(1, Math.max(0, (time - inp[i]) / (inp[j] - inp[i]))) : 0
    const v = []
    for (let c = 0; c < k; c++) v.push(out[i * k + c] * (1 - f) + out[j * k + c] * f)
    if (k === 4) {
      const l = Math.hypot(...v) || 1
      return v.map((x) => x / l)
    }
    return v
  }
  const stop = hips.getParentNode()
  const fk = (node, time) => {
    const chain = []
    for (let n = node; n && n !== stop; n = n.getParentNode()) chain.unshift(n)
    let p = [0, 0, 0]
    let q = [0, 0, 0, 1]
    for (const n of chain) {
      const tr = tracks.get(n)
      const t = time === null || !tr?.t ? n.getTranslation() : sample(tr.t, time, 3)
      const r = time === null || !tr?.r ? n.getRotation() : sample(tr.r, time, 4)
      const rt = rotate(q, t)
      p = [p[0] + rt[0], p[1] + rt[1], p[2] + rt[2]]
      q = quatMul(q, r)
    }
    return { p, q }
  }
  const conj = ([x, y, z, w]) => [-x, -y, -z, w]
  // Each shoe's contact points (heel tip, ball of the foot) fixed in its foot's frame, from the rest pose.
  const contacts = sides.map((s) => {
    const a = fk(s.foot, null)
    const t = fk(s.toe, null)
    const world = [[a.p[0], floor, a.p[2] - 3.5], [t.p[0], floor, t.p[2]]]
    return { foot: s.foot, pts: world.map((p) => rotate(conj(a.q), [p[0] - a.p[0], p[1] - a.p[1], p[2] - a.p[2]])) }
  })
  const lowest = (time) => {
    let y = Infinity
    for (const c of contacts) {
      const a = fk(c.foot, time)
      for (const l of c.pts) y = Math.min(y, a.p[1] + rotate(a.q, l)[1])
    }
    return y
  }
  const offsets = []
  for (let time = 0; time <= duration; time += 1 / 30) offsets.push(floor - lowest(time))
  offsets.sort((a, b) => a - b)
  const dy = offsets[Math.floor(offsets.length / 2)] ?? 0
  for (const ch of clip.listChannels()) {
    if (ch.getTargetNode() !== hips || ch.getTargetPath() !== 'translation') continue
    const acc = ch.getSampler().getOutput()
    const arr = acc.getArray().slice()
    for (let i = 1; i < arr.length; i += 3) arr[i] += dy
    acc.setArray(arr)
  }
  return { dy, restGap: lowest(null) - floor, lo: offsets[0], hi: offsets[offsets.length - 1] }
}
for (const a of root.listAnimations()) {
  const g = groundClip(doc, a)
  console.log(`grounded ${a.getName()}: hips ${g.dy >= 0 ? '+' : ''}${g.dy.toFixed(2)} (per-frame offsets ${g.lo?.toFixed(2)}..${g.hi?.toFixed(2)}, rest gap ${g.restGap?.toFixed(3)})`)
}

if ('mirror-talk' in flags) {
  const talk = root.listAnimations().find((a) => a.getName() === 'talk')
  if (talk) console.log(`talk2: ${mirrorClip(doc, talk, 'talk2').listChannels().length} mirrored channels`)
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
  } else if (isTarget && !mat.getMetallicRoughnessTexture()) {
    // Other materials (the shoes) keep the roughness they were exported with.
    mat.setRoughnessFactor(Number(flags['rough-factor'] ?? 0.62))
  }
  if (flags.orm && isTarget) {
    // An occlusion/roughness/metallic pack (R=AO, G=roughness, B=metallic) is exactly the glTF layout.
    const { data, mime } = await png(flags.orm)
    const tex = doc.createTexture('orm').setImage(data).setMimeType(mime)
    mat.setMetallicRoughnessTexture(tex).setRoughnessFactor(1).setOcclusionTexture(tex).setOcclusionStrength(Number(flags['ao-strength'] ?? 0.6))
  }
  if (flags.normal && isTarget) {
    const { data, mime } = await png(flags.normal)
    const tex = doc.createTexture('normal').setImage(data).setMimeType(mime)
    mat.setNormalTexture(tex).setNormalScale(Number(flags['normal-scale'] ?? 0.6))
  }
  if (flags['pump-color'] && /pump/i.test(mat.getName())) {
    // The shoes carry a plain colour, given as linear r,g,b so it can be tuned without a re-export.
    const [r, g, b] = String(flags['pump-color']).split(',').map(Number)
    mat.setBaseColorFactor([r, g, b, 1])
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
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality, slots: /^(baseColor|emissive)/ }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [Number(flags['data-size'] ?? 2048), Number(flags['data-size'] ?? 2048)], quality: Number(flags['data-quality'] ?? 90), slots: /^(normal|metallicRoughness|occlusion)/ }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
)
await io.write(outPath, doc)
console.log(`wrote ${outPath}: ${(statSync(outPath).size / 1e6).toFixed(2)} MB; clips: ${root.listAnimations().map((a) => `${a.getName()} (${a.listChannels().length} ch)`).join(', ')}; textures: ${root.listTextures().map((t) => `${t.getName()} ${t.getSize()?.join('x')}`).join(', ')}`)
