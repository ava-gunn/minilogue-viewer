import { expect, test } from '@playwright/test'

const TONE = 'test-tone.wav'

const knobAngle = (page: import('@playwright/test').Page, key: string) =>
  page
    .locator(`xd-knob[data-param-key="${key}"]`)
    .first()
    .evaluate((el) => el.style.getPropertyValue('--knob-angle'))

const oledName = (page: import('@playwright/test').Page) =>
  page
    .locator('#oled')
    .evaluate((el) => el.shadowRoot?.querySelector('.name')?.textContent ?? '')

test('uploading audio sound-matches and animates the panel', async ({
  page,
}) => {
  const logs: string[] = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  await page.goto('/')

  const before = await knobAngle(page, 'cutoff')
  await page.locator('input[type="file"]').first().setInputFiles(TONE)
  await page.waitForTimeout(10000)
  const status = await page.locator('#status-bar').textContent()
  console.log('STATUS BAR:', JSON.stringify(status))
  console.log('LOGS:\n', logs.join('\n'))

  await expect.poll(() => oledName(page), { timeout: 20000 }).toBe('AI MATCH')
  expect(await knobAngle(page, 'cutoff')).not.toBe(before)
})
