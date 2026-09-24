import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, useAnimations, useGLTF, useProgress } from '@react-three/drei'
import { AnimatePresence, motion } from 'motion/react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { SCRIPT, markIntroSeen } from '../lib/intro'
import { Logo, Mute, Sound } from './Icons'

const MODEL_URL = '/models/sam.glb'
const audioUrl = (i: number) => `/audio/sam-${i}.mp3`

const START_X = 3.4
const END_X = 0.05
const EXIT_X = -3.9
const SPEED = 1.05
const FACE_LEFT = -Math.PI / 2
const FACE_CAMERA = 0

type Phase = 'loading' | 'enter' | 'talk' | 'exit' | 'done'

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

function Env() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = tex
    scene.environmentIntensity = 0.75
    return () => {
      scene.environment = null
      tex.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

// Two framings: a wide shot for the walk-in and walk-off, and a medium shot while she speaks
// so her face carries the introduction. Portrait phones keep a little more distance.
const SHOT_WIDE = { pos: [0, 1.2, 4.8], look: [0, 0.95, 0] } as const
const SHOT_TALK = { pos: [0.1, 1.36, 2.7], look: [0.02, 1.22, 0] } as const

function CameraRig({ phase }: { phase: Phase }) {
  const { camera, size } = useThree()
  const look = useRef(new THREE.Vector3(SHOT_WIDE.look[0], SHOT_WIDE.look[1], SHOT_WIDE.look[2]))
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1)
    const talk = phase === 'talk'
    const shot = talk ? SHOT_TALK : SHOT_WIDE
    const zoomOut = size.height > size.width ? 1.22 : 1
    const k = talk ? 1.6 : 2.4
    camera.position.x = THREE.MathUtils.damp(camera.position.x, shot.pos[0], k, d)
    camera.position.y = THREE.MathUtils.damp(camera.position.y, shot.pos[1], k, d)
    camera.position.z = THREE.MathUtils.damp(camera.position.z, shot.pos[2] * zoomOut, k, d)
    look.current.x = THREE.MathUtils.damp(look.current.x, shot.look[0], k, d)
    look.current.y = THREE.MathUtils.damp(look.current.y, shot.look[1], k, d)
    look.current.z = THREE.MathUtils.damp(look.current.z, shot.look[2], k, d)
    const t = state.clock.elapsedTime
    const sway = talk ? 0.012 : 0
    camera.lookAt(look.current.x + Math.sin(t * 0.7) * sway, look.current.y + Math.sin(t * 0.9 + 1) * sway * 0.6, look.current.z)
  })
  return null
}

function Loaded({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    onReady()
  }, [onReady])
  return null
}

function Sam({ phase, onArrived, onExited }: { phase: Phase; onArrived: () => void; onExited: () => void }) {
  const group = useRef<THREE.Group>(null)
  const walk = useGLTF(MODEL_URL, false, true)
  const clips = useMemo(() => {
    const all = walk.animations
    const byName = (n: string) => all.find((c) => c.name === n)
    const out: THREE.AnimationClip[] = []
    const w = byName('walk') ?? all[0]
    if (w) {
      const c = w.clone()
      c.name = 'walk'
      out.push(c)
    }
    const t = byName('talk') ?? all[1]
    if (t) {
      const c = t.clone()
      c.name = 'talk'
      out.push(c)
    }
    return out
  }, [walk.animations])
  const { actions } = useAnimations(clips, group)
  const model = useMemo(() => {
    const s = walk.scene
    const box = new THREE.Box3().setFromObject(s)
    const size = box.getSize(new THREE.Vector3())
    const k = size.y > 0 ? 1.72 / size.y : 1
    s.scale.setScalar(k)
    box.setFromObject(s)
    const c = box.getCenter(new THREE.Vector3())
    s.position.set(-c.x, -box.min.y, -c.z)
    s.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
        m.frustumCulled = false
        const mat = m.material as THREE.MeshStandardMaterial
        if (mat && 'roughness' in mat) {
          mat.envMapIntensity = 0.9
          if (mat.emissive) mat.emissive.setScalar(0)
          mat.needsUpdate = true
        }
      }
    })
    return s
  }, [walk.scene])
  const arrived = useRef(false)
  const exited = useRef(false)
  const phaseStart = useRef<number | null>(null)
  const lastPhase = useRef<Phase>('loading')

  useEffect(() => {
    const a = actions as Record<string, THREE.AnimationAction | null>
    const w = a.walk ?? null
    const t = a.talk ?? null
    if (phase === 'enter' || phase === 'exit') {
      t?.fadeOut(0.35)
      if (w) {
        w.paused = false
        w.reset().fadeIn(0.35).play()
      }
    } else if (phase === 'talk') {
      if (t) {
        w?.fadeOut(0.45)
        t.reset().fadeIn(0.45).play()
      } else if (w) {
        w.paused = true
      }
    }
  }, [phase, actions])

  // Motion is driven by wall-clock time, so the walk takes the same seconds on a slow phone as on a desktop.
  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    const now = state.clock.elapsedTime
    if (lastPhase.current !== phase) {
      lastPhase.current = phase
      phaseStart.current = now
    }
    const t = now - (phaseStart.current ?? now)
    const d = Math.min(dt, 0.1)
    if (phase === 'enter') {
      g.position.x = Math.max(END_X, START_X - SPEED * t)
      if (g.position.x <= END_X && !arrived.current) {
        arrived.current = true
        onArrived()
      }
    } else if (phase === 'talk') {
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, FACE_CAMERA, 5, d)
    } else if (phase === 'exit') {
      const turn = Math.min(1, t / 0.5)
      g.rotation.y = FACE_CAMERA + (FACE_LEFT - FACE_CAMERA) * (turn * turn * (3 - 2 * turn))
      if (t > 0.35) g.position.x = END_X - SPEED * (t - 0.35)
      if (g.position.x < EXIT_X && !exited.current) {
        exited.current = true
        onExited()
      }
    }
  })

  return (
    <group ref={group} position={[START_X, 0, 0]} rotation={[0, FACE_LEFT, 0]}>
      <primitive object={model} />
    </group>
  )
}

export default function SamIntro({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [line, setLine] = useState(-1)
  const [sound, setSound] = useState(false)
  const [audioOk, setAudioOk] = useState(false)
  const [closing, setClosing] = useState(false)
  const { progress } = useProgress()
  const audios = useRef<Map<number, HTMLAudioElement>>(new Map())
  const lineStart = useRef(0)
  const finished = useRef(false)

  const audioFor = useCallback((i: number) => {
    let a = audios.current.get(i)
    if (!a) {
      a = new Audio(audioUrl(i))
      a.preload = 'auto'
      audios.current.set(i, a)
    }
    return a
  }, [])

  const stopAudio = useCallback(() => {
    audios.current.forEach((a) => a.pause())
  }, [])

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    markIntroSeen()
    stopAudio()
    setClosing(true)
    setPhase('done')
    window.setTimeout(onDone, 700)
  }, [onDone, stopAudio])

  useEffect(() => {
    document.documentElement.classList.add('intro-open')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    const probe = new Audio(audioUrl(0))
    probe.preload = 'metadata'
    probe.addEventListener('loadedmetadata', () => setAudioOk(true), { once: true })
    probe.addEventListener('error', () => setAudioOk(false), { once: true })
    audios.current.set(0, probe)
    const all = audios.current
    return () => {
      document.documentElement.classList.remove('intro-open')
      window.removeEventListener('keydown', onKey)
      all.forEach((a) => a.pause())
    }
  }, [finish])

  // Caption timeline while SAM talks.
  useEffect(() => {
    if (phase !== 'talk') return
    setLine(0)
    lineStart.current = Date.now()
    const timers: number[] = []
    let acc = 0
    SCRIPT.forEach((l, i) => {
      acc += l.ms
      const next = i + 1
      timers.push(
        window.setTimeout(() => {
          if (next < SCRIPT.length) {
            lineStart.current = Date.now()
            setLine(next)
          } else {
            setPhase('exit')
          }
        }, acc),
      )
    })
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [phase])

  // Narration follows the captions when sound is on.
  useEffect(() => {
    if (!sound || !audioOk || phase !== 'talk' || line < 0) return
    stopAudio()
    const a = audioFor(line)
    const offset = (Date.now() - lineStart.current) / 1000
    try {
      a.currentTime = offset > 0.4 ? offset : 0
    } catch {
      /* not seekable yet */
    }
    a.play().catch(() => setSound(false))
    if (line + 1 < SCRIPT.length) audioFor(line + 1)
  }, [sound, audioOk, phase, line, audioFor, stopAudio])

  const toggleSound = () => {
    if (sound) {
      stopAudio()
      setSound(false)
    } else {
      setSound(true)
    }
  }

  const onReady = useCallback(() => setPhase((p) => (p === 'loading' ? 'enter' : p)), [])
  const onArrived = useCallback(() => setPhase('talk'), [])
  const onExited = useCallback(() => finish(), [finish])

  return (
    <div className={`intro${closing ? ' intro--closing' : ''}`} role="dialog" aria-modal="true" aria-label="An introduction from SAM">
      <div className="intro__stage">
        <Boundary onError={finish}>
          <Canvas
            shadows="soft"
            dpr={[1, 1.5]}
            camera={{ position: [0, 1.2, 4.8], fov: 27 }}
            gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', toneMapping: THREE.AgXToneMapping, toneMappingExposure: 1.05 }}
            onCreated={({ camera }) => camera.lookAt(0, 0.95, 0)}
          >
            <Env />
            <CameraRig phase={phase} />
            <hemisphereLight args={['#dfe9ff', '#0a1220', 0.9]} />
            <directionalLight
              position={[2.2, 4.2, 3.2]}
              intensity={2.6}
              color="#fff1e0"
              castShadow
              shadow-mapSize={[2048, 2048]}
              shadow-bias={-0.0002}
              shadow-normalBias={0.02}
            />
            <directionalLight position={[-2.6, 2.4, 3]} intensity={0.8} color="#cfe3ff" />
            <directionalLight position={[-3, 2.5, -2]} intensity={1.2} color="#4fd8c7" />
            <directionalLight position={[3, 1.5, -3]} intensity={0.6} color="#8b7cff" />
            <Suspense fallback={null}>
              <Sam phase={phase} onArrived={onArrived} onExited={onExited} />
              <Loaded onReady={onReady} />
            </Suspense>
            <ContactShadows position={[0, 0.001, 0]} opacity={0.6} scale={7} blur={2.2} far={2.4} />
            <mesh rotation-x={-Math.PI / 2} position={[0, 0.0005, 0]}>
              <ringGeometry args={[1.32, 1.35, 96]} />
              <meshBasicMaterial color="#3fd8c7" transparent opacity={0.35} />
            </mesh>
          </Canvas>
        </Boundary>
      </div>
      <div className="intro__ui">
        <div className="intro__top">
          <div className="brand">
            <Logo />
            <span className="brand__name">SAM</span>
            <span className="brand__tag">Live intro</span>
          </div>
          <div className="intro__actions">
            {audioOk && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={toggleSound} aria-pressed={sound}>
                {sound ? <Mute /> : <Sound />}
                {sound ? 'Mute' : 'Hear SAM'}
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--sm" onClick={finish}>
              Skip intro
            </button>
          </div>
        </div>
        {phase === 'loading' && (
          <div className="intro__loading" aria-live="polite">
            <div className="intro__bar">
              <i style={{ width: `${Math.max(4, Math.min(100, progress))}%` }} />
            </div>
            <span>Preparing SAM · {Math.round(progress)}%</span>
          </div>
        )}
        <div className="intro__caption" aria-live="polite">
          <AnimatePresence mode="wait">
            {phase === 'talk' && line >= 0 && (
              <motion.p
                key={line}
                initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
                transition={{ duration: 0.45 }}
              >
                {SCRIPT[line]!.text}
              </motion.p>
            )}
            {phase === 'enter' && (
              <motion.span key="enter" className="intro__hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                SAM is on her way
              </motion.span>
            )}
          </AnimatePresence>
          {phase === 'talk' && (
            <div className="intro__dots" aria-hidden="true">
              {SCRIPT.map((_, i) => (
                <i key={i} className={i <= line ? 'is-on' : ''} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

useGLTF.preload(MODEL_URL, false, true)
