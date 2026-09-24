import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const doc = await io.read(process.argv[2])
const root = doc.getRoot()
const T = Number(process.argv[3] ?? 1.6)
const want = /UpLeg$|^Hips$|Leg$|Foot$/
for (const a of root.listAnimations()) {
  for (const ch of a.listChannels()) {
    const n = ch.getTargetNode()?.getName() ?? '?'
    if (!want.test(n)) continue
    const s = ch.getSampler(); const inp = s.getInput().getArray(); const out = s.getOutput().getArray()
    const path = ch.getTargetPath(); const k = path === 'rotation' ? 4 : path === 'scale' ? 3 : 3
    if (path === 'scale') continue
    let i = 0; while (i < inp.length - 1 && inp[i + 1] < T) i++
    const first = Array.from(out.slice(0, k)).map((v) => v.toFixed(3)).join(',')
    const at = Array.from(out.slice(i * k, i * k + k)).map((v) => v.toFixed(3)).join(',')
    console.log(a.getName().padEnd(6), n.padEnd(11), path.padEnd(11), 'f0', first.padEnd(28), `t${T}`, at, `n=${inp.length} dur=${inp[inp.length - 1].toFixed(2)}`)
  }
}
for (const n of root.listNodes()) if (/UpLeg$|^Hips$|Leg$|Foot$|^Spine$|^Head$|Arm$|^Armature/.test(n.getName())) console.log('rest', n.getName().padEnd(11), 'rot', n.getRotation().map((v) => v.toFixed(3)).join(','), 'tr', n.getTranslation().map((v) => v.toFixed(3)).join(','), 'sc', n.getScale().map((v) => v.toFixed(3)).join(','))
