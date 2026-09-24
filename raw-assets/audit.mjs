// Design-quality audit of the built site (pointer cursors, focus styles, contrast, tap targets,
// alt text, reduced motion, heading order). Run with the server on :8080.
import { chromium } from 'playwright-core'
import { readdirSync, readFileSync } from 'node:fs'
const dir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'))
const browser = await chromium.launch({ executablePath: `/opt/pw-browsers/${dir}/chrome-linux/chrome`, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })
const css = readFileSync('src/styles.css', 'utf8')
const out = {}
out.focusVisibleRules = (css.match(/:focus-visible/g) || []).length
out.reducedMotionRules = (css.match(/prefers-reduced-motion/g) || []).length
const lum = (hex) => { const c = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return ((l1 + 0.05) / (l2 + 0.05)).toFixed(2) }
const token = (name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) || [])[1]
const bg = token('bg'), text = token('text'), muted = token('muted'), dim = token('dim'), accent = token('accent'), accent2 = token('accent-2')
out.tokens = { bg, text, muted, dim, accent, accent2 }
out.contrast = { text: contrast(text, bg), muted: contrast(muted, bg), dim: contrast(dim, bg), accent: contrast(accent, bg), accent2: contrast(accent2, bg) }
for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: name === 'mobile' })
  await ctx.addInitScript(() => localStorage.setItem('sam-intro-seen-v1', '1'))
  const page = await ctx.newPage()
  await page.goto('http://localhost:8080/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1500)
  out[name] = await page.evaluate(() => {
    const clickables = [...document.querySelectorAll('a[href], button, [role=button], input, select, textarea, label')]
    const noPointer = clickables.filter((el) => { const cs = getComputedStyle(el); return ['a', 'button'].includes(el.tagName.toLowerCase()) && cs.cursor !== 'pointer' && el.offsetParent !== null }).map((el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' "' + (el.textContent || '').trim().slice(0, 24) + '"')
    const small = clickables.filter((el) => { const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.width > 0 && (r.height < 40 || r.width < 40) && ['a', 'button'].includes(el.tagName.toLowerCase()) }).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent || '').trim().slice(0, 20)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`)
    const imgs = [...document.images]
    const noAlt = imgs.filter((i) => !i.hasAttribute('alt')).map((i) => i.src.split('/').pop())
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => h.tagName + ': ' + h.textContent.trim().slice(0, 40))
    const emoji = document.body.innerText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []
    const overflow = document.documentElement.scrollWidth - window.innerWidth
    const fontSizes = [...new Set([...document.querySelectorAll('p, li, a, button, span, h1, h2, h3')].filter((e) => e.offsetParent !== null).map((e) => parseFloat(getComputedStyle(e).fontSize)))].sort((a, b) => a - b)
    const tiny = [...document.querySelectorAll('p, li, a, button, span, small')].filter((e) => e.offsetParent !== null && parseFloat(getComputedStyle(e).fontSize) < 12 && (e.textContent || '').trim().length > 0).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${getComputedStyle(e).fontSize}`)
    return { clickables: clickables.length, noPointer: [...new Set(noPointer)].slice(0, 12), smallTargets: [...new Set(small)].slice(0, 12), imgs: imgs.length, noAlt, headings, emoji: emoji.length, overflow, fontSizes, tiny: [...new Set(tiny)].slice(0, 10) }
  })
  await ctx.close()
}
console.log(JSON.stringify(out, null, 1))
await browser.close()
