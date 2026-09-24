export const INTRO_KEY = 'sam-intro-seen-v1'

export interface Line {
  text: string
  ms: number
}

/** What SAM says on the first visit. Timings match the narration files in public/audio plus a short pause. */
export const SCRIPT: Line[] = [
  { text: 'Welcome to SAM.', ms: 3100 },
  { text: "I'm here to help you make sense of the market. Not by telling you what to think, but by giving you better information to think with.", ms: 7300 },
  { text: 'Every day, thousands of filings, prices and headlines move through the market. Most of it is noise. Some of it matters.', ms: 10700 },
  { text: 'I read all of it, weigh what actually moved prices, and hand you calibrated context: what happened, why it likely happened, and how sure anyone should be.', ms: 10800 },
  { text: 'Explore companies. Understand the forces moving markets. Turn complexity into clarity.', ms: 6900 },
  { text: 'No tips. No hype. Just better information, and a community learning to use it well.', ms: 9000 },
  { text: 'Let me show you around.', ms: 4100 },
]

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
  return !prefersReducedMotion() && hasWebGL()
}
