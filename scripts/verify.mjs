// Headless-browser smoke test: loads the built site, records console errors (CSP violations
// included) and saves screenshots for review. Run with the server listening on :8080.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { readdirSync } from 'node:fs'

const base = process.env.SITE_URL ?? 'http://localhost:8080'
const out = 'raw-assets/shots'
mkdirSync(out, { recursive: true })
const dir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'))
const executablePath = `/opt/pw-browsers/${dir}/chrome-linux/chrome`
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
})
const errors = []
async function shoot(name, width, height, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: opts.reducedMotion ?? 'no-preference' })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${name}] ${m.type()}: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`))
  if (opts.seen) await ctx.addInitScript(() => localStorage.setItem('sam-intro-seen-v1', '1'))
  await page.goto(base + (opts.path ?? '/'), { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(opts.wait ?? 2500)
  if (opts.full) {
    await page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto'
      const step = Math.max(300, Math.floor(window.innerHeight * 0.7))
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)) }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(900)
  }
  if (opts.scrollTo !== undefined) { await page.evaluate((y) => window.scrollTo(0, y), opts.scrollTo); await page.waitForTimeout(1200) }
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: opts.full ?? false })
  const info = await page.evaluate(() => ({ title: document.title, h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, intro: !!document.querySelector('.intro'), globe: !!document.querySelector('.globe canvas'), cards: document.querySelectorAll('.idx').length }))
  console.log(name, JSON.stringify(info))
  await ctx.close()
}
await shoot('intro-first-visit', 1440, 900, { wait: 3500 })
await shoot('desktop-hero', 1440, 900, { seen: true })
await shoot('desktop-full', 1440, 900, { seen: true, full: true, wait: 3000 })
await shoot('desktop-explainer', 1440, 900, { seen: true, scrollTo: 1600 })
await shoot('mobile-hero', 390, 844, { seen: true })
await shoot('mobile-full', 390, 844, { seen: true, full: true, wait: 3000 })
await browser.close()
console.log('console issues:', errors.length)
for (const e of errors.slice(0, 40)) console.log(' -', e)
