// Reduces a dense generated mesh for rigging and the web while keeping UVs, normals and
// PBR maps: node scripts/simplify-model.mjs <in.glb> <out.glb> [ratio=0.15] [error=0.001] [texSize=4096]
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { simplify, weld, dedup, prune, textureCompress } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { statSync } from 'node:fs'

const [input, output, ratioArg = '0.15', errorArg = '0.001', texArg = '4096'] = process.argv.slice(2)
if (!input || !output) throw new Error('usage: simplify-model.mjs <in.glb> <out.glb> [ratio] [error] [texSize]')
await MeshoptSimplifier.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(input)
const before = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0)
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratioArg), error: Number(errorArg), lockBorder: false }),
  dedup(),
  prune(),
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [Number(texArg), Number(texArg)], quality: 90, slots: /^(baseColor|emissive|metallicRoughness|occlusion)/ }),
)
await io.write(output, doc)
const after = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0)
console.log(`${input}: ${before} -> ${after} vertices; wrote ${output} ${(statSync(output).size / 1e6).toFixed(1)} MB; textures ${doc.getRoot().listTextures().map((t) => t.getMimeType() + ' ' + t.getSize()).join(', ')}`)
