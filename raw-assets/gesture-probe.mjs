// Watches the intro's gesture scheduler on the built site: prints the sequence of gestures she plays.
import { chromium } from 'playwright-core'
import { readdirSync } from 'node:fs'
const dir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'))
const browser = await chromium.launch({ executablePath: `/opt/pw-browsers/${dir}/chrome-linux/chrome`, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage()
await page.goto(process.env.SITE_URL ?? 'http://localhost:8080/', { waitUntil: 'networkidle', timeout: 60000 })
const seq = []
const t0 = Date.now()
while (Date.now() - t0 < 70000 && seq.length < 7) {
  const g = await page.evaluate(() => document.documentElement.dataset.samGesture ?? '')
  if (g && seq[seq.length - 1] !== g) seq.push(g)
  await page.waitForTimeout(150)
}
const parts = seq.map((g) => g.split('#')[0].split('@'))
let ok = parts.length >= 3
for (let i = 1; i < parts.length; i++) if (parts[i][0] === parts[i - 1][0] || parts[i][1] === parts[i - 1][1]) ok = false
console.log(JSON.stringify(seq), ok ? 'OK: no consecutive repeat of clip or speed' : 'FAIL')
await browser.close()
process.exit(ok ? 0 : 1)
