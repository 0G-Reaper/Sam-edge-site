import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const doc = await io.read(process.argv[2]); const root = doc.getRoot()
const quatMul = (a, b) => { const [ax, ay, az, aw] = a; const [bx, by, bz, bw] = b; return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz] }
const rotate = ([x, y, z, w], [vx, vy, vz]) => { const cx = y * vz - z * vy + w * vx, cy = z * vx - x * vz + w * vy, cz = x * vy - y * vx + w * vz; return [vx + 2 * (y * cz - z * cy), vy + 2 * (z * cx - x * cz), vz + 2 * (x * cy - y * cx)] }
const byName = new Map(root.listNodes().map((n) => [n.getName(), n]))
const hips = byName.get('Hips'); const stop = hips.getParentNode()
const clip = root.listAnimations().find((a) => a.getName() === process.argv[3])
const first = new Map()
if (clip) for (const ch of clip.listChannels()) { const n = ch.getTargetNode(); const out = ch.getSampler().getOutput().getArray(); const e = first.get(n) ?? {}; if (ch.getTargetPath() === 'translation') e.t = [out[0], out[1], out[2]]; if (ch.getTargetPath() === 'rotation') e.r = [out[0], out[1], out[2], out[3]]; first.set(n, e) }
const fk = (node, posed) => { const chain = []; for (let n = node; n && n !== stop; n = n.getParentNode()) chain.unshift(n); let p = [0, 0, 0], q = [0, 0, 0, 1]; for (const n of chain) { const e = posed ? first.get(n) : undefined; const rt = rotate(q, e?.t ?? n.getTranslation()); p = [p[0] + rt[0], p[1] + rt[1], p[2] + rt[2]]; q = quatMul(q, e?.r ?? n.getRotation()) } return p }
let floor = Infinity; for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) { const a = prim.getAttribute('POSITION'); if (a) floor = Math.min(floor, a.getMin([0, 0, 0])[1]) }
console.log('floor', floor.toFixed(2), 'stop node', stop?.getName(), 'chain', (() => { const c = []; for (let n = byName.get('LeftToeBase'); n && n !== stop; n = n.getParentNode()) c.unshift(n.getName()); return c.join('>') })())
for (const n of ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightFoot', 'RightToeBase', 'Head']) console.log(n.padEnd(13), 'rest', fk(byName.get(n), false).map((v) => v.toFixed(2)).join(','), clip ? ' posed@0 ' + fk(byName.get(n), true).map((v) => v.toFixed(2)).join(',') : '')
