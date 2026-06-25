import { expect, test } from '@playwright/test'

const PROG = 'replicant-example.mnlgxdprog'
const LIB = 'example-library.mnlgxdlib'

const knobAngle = (page: import('@playwright/test').Page, key: string) =>
  page
    .locator(`xd-knob[data-param-key="${key}"]`)
    .first()
    .evaluate((el) => el.style.getPropertyValue('--knob-angle'))

const oledName = (page: import('@playwright/test').Page) =>
  page
    .locator('#oled')
    .evaluate((el) => el.shadowRoot?.querySelector('.name')?.textContent ?? '')

test('dropping a .mnlgxdprog animates the panel to the patch', async ({
  page,
}) => {
  await page.goto('/')

  const before = await knobAngle(page, 'cutoff')
  await page.locator('input[type="file"]').first().setInputFiles(PROG)

  // Cutoff knob rotates away from its default once the patch loads.
  await expect.poll(() => knobAngle(page, 'cutoff')).not.toBe(before)

  expect(await oledName(page)).toBe('Replicant xd')
  await expect(
    page.locator('xd-wave-selector[data-section="vco1"]'),
  ).toHaveAttribute('aria-label', 'WAVE: SAW')
})

test('dropping a .mnlgxdlib opens the library and switches programs', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles(LIB)

  const panel = page.locator('#library-panel')
  await expect(panel).not.toHaveAttribute('hidden', /.*/)

  const items = page.locator('#program-list [role="option"]')
  await expect.poll(() => items.count()).toBeGreaterThan(1)

  // Clicking a program updates the OLED.
  const target = items.nth(2)
  const label = (await target.textContent()) ?? ''
  const name = label.replace(/^\d+\s+/, '').trim()
  await target.click()
  await expect.poll(() => oledName(page)).toBe(name)
  await expect(target).toHaveAttribute('aria-selected', 'true')
})
