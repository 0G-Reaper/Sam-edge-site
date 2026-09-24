import { test, expect } from '@playwright/test'

const KEY = /SAM(?:-[0-9A-HJKMNP-TV-Z]{4}){4}/

test.describe('waitlist', () => {
  test('issues a member key once and recognises a repeat signup', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('sam-intro-seen-v1', '1'))
    await page.goto('/')
    const stamp = Date.now().toString(36)
    await page.locator('#waitlist').scrollIntoViewIfNeeded()
    await page.locator('#wl-user').fill(`e2e_${stamp}`)
    await page.locator('#wl-email').fill(`e2e-${stamp}@example.com`)
    // The server rejects forms submitted faster than a human could fill them.
    await page.waitForTimeout(2700)
    await page.locator('#waitlist button[type="submit"]').click()
    const card = page.locator('#waitlist').getByText(KEY)
    await expect(card.first()).toBeVisible({ timeout: 15_000 })
    const first = (await card.first().textContent())?.match(KEY)?.[0]
    expect(first).toBeTruthy()

    await page.reload()
    await page.locator('#waitlist').scrollIntoViewIfNeeded()
    await page.locator('#wl-user').fill(`e2e_${stamp}`)
    await page.locator('#wl-email').fill(`e2e-${stamp}@example.com`)
    await page.waitForTimeout(2700)
    await page.locator('#waitlist button[type="submit"]').click()
    // A repeat signup is acknowledged without minting a second key.
    await expect(page.locator('#waitlist').getByText(/already on the list/i)).toBeVisible({ timeout: 15_000 })
  })
})
