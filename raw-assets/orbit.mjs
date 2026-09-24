// Renders a GLB from several yaw angles around its bounding box with three.js in headless Chromium:
//   node raw-assets/orbit.mjs /raw-assets/model.glb tag [clipIndex] [time] [fovHeightFraction]
import { chromium } from 'playwright-core'
import { readdirSync } from 'node:fs'
const dir = readdirSync('/opt/pw-browsers').find((d) => d.startsWith('chromium-'))
const browser = await chromium.launch({ executablePath: `/opt/pw-browsers/${dir}/chrome-linux/chrome`, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] })
const [src = '/raw-assets/sam-walk.glb', tag = 'orbit', clip = '0', t = '0', frac = '1'] = process.argv.slice(2)
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
await page.goto(`http://localhost:8090/raw-assets/orbit.html?src=${src}&clip=${clip}&t=${t}&frac=${frac}`)
await page.waitForFunction(() => window.__done, null, { timeout: 120000 })
await page.screenshot({ path: `raw-assets/shots/orbit-${tag}.png` })
console.log(tag, await page.evaluate(() => window.__info), errs.slice(0, 2).join(' | '))
await browser.close()
