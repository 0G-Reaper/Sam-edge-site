// Preserve the existing once-per-browser preference. Meet SAM always offers a replay.
export const INTRO_KEY = 'sam-intro-seen-v1'

export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === '1'
  } catch {
    return false
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_KEY, '1')
  } catch {
    /* private mode: the intro simply plays again next time */
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas')
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

export function canPlayIntro(): boolean {
  // Only gate the automatic welcome. Explicit playback remains available to everyone.
  return !prefersReducedMotion()
}
