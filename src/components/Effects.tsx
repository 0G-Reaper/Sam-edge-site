import { useEffect } from 'react'

/** Pointer-driven polish: a soft cursor glow, card borders that light up under the pointer, magnetic buttons. */
export default function Effects() {
  useEffect(() => {
    if (!matchMedia('(pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const glow = document.createElement('div')
    glow.className = 'cursor-glow'
    document.body.appendChild(glow)
    let raf = 0
    let px = -1000
    let py = -1000

    const frame = () => {
      raf = 0
      glow.style.transform = `translate3d(${px}px, ${py}px, 0)`
      for (const el of document.querySelectorAll<HTMLElement>('.card')) {
        const r = el.getBoundingClientRect()
        if (px >= r.left - 120 && px <= r.right + 120 && py >= r.top - 120 && py <= r.bottom + 120) {
          el.style.setProperty('--mx', `${px - r.left}px`)
          el.style.setProperty('--my', `${py - r.top}px`)
        }
      }
      for (const el of document.querySelectorAll<HTMLElement>('[data-magnetic]')) {
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const dx = px - cx
        const dy = py - cy
        const reach = Math.max(r.width, r.height) * 0.9
        if (Math.hypot(dx, dy) < reach) {
          el.style.setProperty('--tx', `${dx * 0.18}px`)
          el.style.setProperty('--ty', `${dy * 0.22}px`)
        } else {
          el.style.setProperty('--tx', '0px')
          el.style.setProperty('--ty', '0px')
        }
      }
    }
    const move = (e: PointerEvent) => {
      px = e.clientX
      py = e.clientY
      glow.classList.add('is-on')
      if (!raf) raf = requestAnimationFrame(frame)
    }
    const leave = () => glow.classList.remove('is-on')
    document.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerleave', leave)
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerleave', leave)
      cancelAnimationFrame(raf)
      glow.remove()
    }
  }, [])
  return null
}
