import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { useInView } from 'motion/react'
import * as THREE from 'three'
import type { Line2 } from 'three-stdlib'
import { prefersReducedMotion } from '../lib/intro'

const R = 1

/** Financial centres the arcs travel between (lat, lon). */
const HUBS: Array<[number, number]> = [
  [40.71, -74.01], // New York
  [51.51, -0.13], // London
  [50.11, 8.68], // Frankfurt
  [35.68, 139.69], // Tokyo
  [22.32, 114.17], // Hong Kong
  [1.35, 103.82], // Singapore
  [-33.87, 151.21], // Sydney
  [-23.55, -46.63], // Sao Paulo
  [43.65, -79.38], // Toronto
  [19.08, 72.88], // Mumbai
  [25.2, 55.27], // Dubai
  [41.88, -87.63], // Chicago
  [47.38, 8.54], // Zurich
  [31.23, 121.47], // Shanghai
]
const ROUTES: Array<[number, number]> = [
  [0, 1], [0, 3], [1, 2], [1, 4], [3, 4], [4, 6], [0, 7], [1, 9], [9, 4], [10, 1], [8, 0], [11, 0], [12, 1], [13, 3], [5, 4], [7, 1],
]

function toVec3(lat: number, lon: number, r = R): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}

const POINT_VERT = /* glsl */ `
uniform float uSize;
uniform float uPixelRatio;
varying float vFacing;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normalize(position));
  vFacing = smoothstep(-0.25, 0.45, n.z);
  gl_PointSize = uSize * uPixelRatio * (3.2 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`

const POINT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
varying float vFacing;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.16, d);
  vec3 col = mix(uColor2, uColor, vFacing);
  gl_FragColor = vec4(col, a * (0.1 + 0.9 * vFacing));
}`

const ATMO_VERT = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const ATMO_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec3 vNormal;
void main() {
  float t = clamp(-vNormal.z / 0.55, 0.0, 1.0);
  float i = pow(t, 2.6) * 0.9;
  gl_FragColor = vec4(uColor * i, i);
}`

function useLandPoints(): Float32Array | null {
  const [pts, setPts] = useState<Float32Array | null>(null)
  useEffect(() => {
    let alive = true
    fetch('/globe/land.bin')
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        const v = new Int16Array(buf)
        const out = new Float32Array((v.length / 2) * 3)
        for (let i = 0, j = 0; i + 1 < v.length; i += 2, j += 3) {
          const p = toVec3(v[i]! / 100, v[i + 1]! / 100, R)
          out[j] = p.x
          out[j + 1] = p.y
          out[j + 2] = p.z
        }
        if (alive) setPts(out)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return pts
}

function Land({ positions }: { positions: Float32Array }) {
  const { gl } = useThree()
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [positions])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uSize: { value: 2.7 },
          uPixelRatio: { value: 1 },
          uColor: { value: new THREE.Color('#62ead9') },
          uColor2: { value: new THREE.Color('#17414d') },
        },
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  )
  useEffect(() => {
    material.uniforms.uPixelRatio!.value = gl.getPixelRatio()
  }, [gl, material])
  useEffect(() => () => {
    geometry.dispose()
    material.dispose()
  }, [geometry, material])
  return <points geometry={geometry} material={material} />
}

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#3fd8c7') } },
        vertexShader: ATMO_VERT,
        fragmentShader: ATMO_FRAG,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh material={material} scale={1.19}>
      <sphereGeometry args={[R, 48, 48]} />
    </mesh>
  )
}

function Arc({ a, b, offset, speed }: { a: THREE.Vector3; b: THREE.Vector3; offset: number; speed: number }) {
  const ref = useRef<Line2>(null)
  const points = useMemo(() => {
    const dist = a.distanceTo(b)
    const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(R + dist * 0.42)
    return new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(48)
  }, [a, b])
  useFrame((_, dt) => {
    const m = ref.current?.material
    if (m) m.dashOffset -= dt * speed
  })
  return <Line ref={ref} points={points} color="#9af3e6" lineWidth={1.4} dashed dashSize={0.32} gapSize={2.6} dashOffset={offset} transparent opacity={0.85} />
}

function Hubs({ points }: { points: THREE.Vector3[] }) {
  return (
    <>
      {points.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.013, 10, 10]} />
          <meshBasicMaterial color="#dbfff9" />
        </mesh>
      ))}
    </>
  )
}

function Scene({ positions, animate }: { positions: Float32Array | null; animate: boolean }) {
  const group = useRef<THREE.Group>(null)
  const hubs = useMemo(() => HUBS.map(([lat, lon]) => toVec3(lat, lon, R * 1.003)), [])
  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    if (animate) g.rotation.y += dt * 0.07
    const tx = 0.32 + state.pointer.y * -0.14
    const tz = state.pointer.x * 0.07
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, tx, 3, dt)
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, tz, 3, dt)
  })
  return (
    <group ref={group} rotation={[0.32, -1.15, 0]}>
      <mesh>
        <sphereGeometry args={[R * 0.985, 48, 48]} />
        <meshBasicMaterial color="#060f1c" />
      </mesh>
      {positions && <Land positions={positions} />}
      <Hubs points={hubs} />
      {ROUTES.map(([i, j], k) => (
        <Arc key={k} a={hubs[i]!} b={hubs[j]!} offset={(k * 0.37) % 3} speed={0.26 + (k % 4) * 0.05} />
      ))}
      <Atmosphere />
    </group>
  )
}

export default function Globe() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '120px' })
  const positions = useLandPoints()
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  const animate = !prefersReducedMotion()
  const active = inView && visible
  return (
    <div ref={ref} className="globe" aria-hidden="true">
      <Canvas
        flat
        dpr={[1, 1.75]}
        frameloop={active ? 'always' : 'never'}
        camera={{ position: [0, 0, 3.1], fov: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}
      >
        <Scene positions={positions} animate={animate} />
      </Canvas>
    </div>
  )
}
