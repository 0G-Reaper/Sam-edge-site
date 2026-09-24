// Bakes the generator's node transform into the vertices, turns the figure to face +Z (glTF front),
// and thins the mesh so an auto-rigger accepts it: node scripts/prepare-for-rig.mjs <in.glb> <out.glb> [yawDeg=-90] [ratio=0.4]
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { simplify, weld, dedup, prune, transformMesh } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import { statSync } from 'node:fs'

const [input, output, yawArg = '-90', ratioArg = '0.4'] = process.argv.slice(2)
await MeshoptSimplifier.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(input)
const root = doc.getRoot()
const yaw = (Number(yawArg) * Math.PI) / 180
const c = Math.cos(yaw), s = Math.sin(yaw)
// column-major 4x4 for a rotation about +Y
const rotY = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
const mul = (a, b) => {
  const out = new Array(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) out[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]
  return out
}
for (const node of root.listNodes()) {
  const mesh = node.getMesh()
  if (!mesh) continue
  const world = node.getWorldMatrix()
  transformMesh(mesh, mul(rotY, world))
  node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1])
}
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratioArg), error: 0.0008 }), dedup(), prune())
await io.write(output, doc)
const prim = root.listMeshes()[0].listPrimitives()[0]
const pos = prim.getAttribute('POSITION')
console.log(`wrote ${output} ${(statSync(output).size / 1e6).toFixed(1)} MB, ${pos.getCount()} verts, min ${pos.getMin([]).map((v) => v.toFixed(2))} max ${pos.getMax([]).map((v) => v.toFixed(2))}`)
