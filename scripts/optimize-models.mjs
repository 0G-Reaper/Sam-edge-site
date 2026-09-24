// Builds public/models/sam.glb from the raw rigged exports:
//   node scripts/optimize-models.mjs raw-assets/sam-walk.glb raw-assets/sam-talk.glb
// The walk file supplies the mesh, skin and walk clip; the talk file's clip is
// retargeted onto the same skeleton by joint name. Textures are resized to WebP
// and the geometry is meshopt-compressed.
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, meshopt, prune, resample, textureCompress } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import { statSync } from 'node:fs'

const [walkPath, talkPath, outPath = 'public/models/sam.glb'] = process.argv.slice(2)
if (!walkPath) throw new Error('usage: optimize-models.mjs <walk.glb> [talk.glb] [out.glb]')

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

const before = root.listTextures().map((t) => `${t.getName() || 'tex'} ${t.getSize()?.join('x')} ${t.getMimeType()}`)
console.log('textures before:', before)

await doc.transform(
  dedup(),
  prune({ keepLeaves: true, keepAttributes: false }),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [2048, 2048], quality: 84 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
)
await io.write(outPath, doc)
console.log(`wrote ${outPath}: ${(statSync(outPath).size / 1e6).toFixed(2)} MB; clips: ${root.listAnimations().map((a) => `${a.getName()} (${a.listChannels().length} ch)`).join(', ')}`)
