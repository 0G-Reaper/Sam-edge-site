import { test, expect, type Page } from '@playwright/test'

async function skipIntro(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sam-intro-seen-v1', '1'))
}

test.describe('landing page', () => {
  test('renders the hero, the sections and the live index cards without console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await skipIntro(page)
    await page.goto('/')
    await expect(page).toHaveTitle(/SAM/)
    await expect(page.locator('#top h1')).toContainText(/Synthetic\s+Analyst\s+Model/)
    for (const id of ['#what', '#how', '#app', '#who', '#waitlist']) await expect(page.locator(id)).toHaveCount(1)
    await expect(page.locator('.idx')).toHaveCount(3)
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible()
    await expect(page.locator('footer.footer')).toBeAttached()
    expect(errors, errors.join('\n')).toEqual([])
  })

  test('never scrolls sideways and keeps every section reachable', async ({ page }) => {
    await skipIntro(page)
    await page.goto('/')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)
    await page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto'
      const step = Math.max(300, Math.floor(window.innerHeight * 0.7))
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)) }
    })
    const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflowAfter).toBeLessThanOrEqual(0)
    await expect(page.locator('#waitlist')).toBeInViewport({ ratio: 0.1 })
  })

  test('the intro plays once for a first visit and can be skipped', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'desktop-only check')
    await page.goto('/')
    const intro = page.getByRole('dialog', { name: 'An introduction from SAM' }).or(page.locator('[aria-label="An introduction from SAM"]'))
    await expect(intro.first()).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: /skip intro/i }).click()
    await expect(intro.first()).toBeHidden({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('sam-intro-seen-v1'))).toBeTruthy()
    await page.reload()
    await expect(page.locator('[aria-label="An introduction from SAM"]')).toHaveCount(0)
  })
})
