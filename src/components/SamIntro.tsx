import { useCallback, useEffect, useRef, useState } from 'react'
import { markIntroSeen } from '../lib/intro'
import { Logo, Mute, Play, Sound } from './Icons'
import welcomeVideo from '../assets/intro/sam-welcome.mp4'
import welcomePoster from '../assets/intro/poster.jpg'

export default function SamIntro({ onDone, startWithSound = false }: { onDone: () => void; startWithSound?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const finished = useRef(false)
  const [sound, setSound] = useState(startWithSound)
  const [needsPlay, setNeedsPlay] = useState(false)
  const [failed, setFailed] = useState(false)

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    videoRef.current?.pause()
    markIntroSeen()
    dialogRef.current?.close()
    onDone()
  }, [onDone])

  useEffect(() => {
    const dialog = dialogRef.current
    const video = videoRef.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.documentElement.classList.add('intro-open')
    // The native modal contains keyboard focus and makes the background inert.
    dialog?.showModal()
    if (video) {
      video.muted = !startWithSound
      void video.play().catch(() => {
        if (!finished.current) setNeedsPlay(true)
      })
    }
    return () => {
      video?.pause()
      dialog?.close()
      document.documentElement.classList.remove('intro-open')
      previousFocus?.focus({ preventScroll: true })
    }
  }, [startWithSound])

  const play = () => {
    const video = videoRef.current
    if (!video) return
    void video.play().catch(() => setNeedsPlay(true))
  }

  const toggleSound = () => {
    const video = videoRef.current
    if (!video) return
    if (video.muted || video.volume === 0) {
      // Hear the entire welcome instead of joining mid-sentence after muted autoplay.
      video.currentTime = 0
      video.muted = false
      video.volume = 1
      setSound(true)
      play()
    } else {
      video.muted = true
      setSound(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="intro"
      aria-label="An introduction from SAM"
      onCancel={(event) => { event.preventDefault(); finish() }}
    >
      <div className="intro__content">
        <div className="intro__top">
          <div className="brand">
            <Logo />
            <span className="brand__name">SAM</span>
            <span className="brand__tag">Welcome</span>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={finish} autoFocus>
            {startWithSound ? 'Close video' : 'Skip intro'}
          </button>
        </div>
        <div className="intro__player">
          <video
            ref={videoRef}
            src={welcomeVideo}
            poster={welcomePoster}
            aria-label="SAM welcome video"
            controls
            playsInline
            muted={!sound}
            preload="auto"
            onPlay={() => setNeedsPlay(false)}
            onEnded={finish}
            onError={() => setFailed(true)}
            onVolumeChange={(event) => setSound(!event.currentTarget.muted && event.currentTarget.volume > 0)}
          >
            Your browser does not support video. <a href={welcomeVideo}>Open SAM’s introduction</a>.
          </video>
          {needsPlay && !failed && (
            <button type="button" className="btn btn--primary intro__play" onClick={play}>
              <Play /> Play introduction
            </button>
          )}
        </div>
        <div className="intro__bottom">
          {failed ? (
            <p role="alert">The video could not load. <a href={welcomeVideo}>Open the video directly</a> or continue to the site.</p>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={toggleSound} aria-pressed={sound}>
              {sound ? <Mute /> : <Sound />}
              {sound ? 'Mute' : 'Hear SAM from the start'}
            </button>
          )}
          <button type="button" className="intro__continue" onClick={finish}>Explore the site →</button>
        </div>
      </div>
    </dialog>
  )
}
