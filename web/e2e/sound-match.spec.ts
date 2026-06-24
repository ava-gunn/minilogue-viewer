import { expect, test } from '@playwright/test'

const TONE = 'test-tone.wav'

const oledName = (page: import('@playwright/test').Page) =>
  page
    .locator('#oled')
    .evaluate((el) => el.shadowRoot?.querySelector('.name')?.textContent ?? '')

test('uploading audio sound-matches and animates the panel', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('input[type="file"]').first().setInputFiles(TONE)

  // The model runs in-browser (onnxruntime-web); the matched patch drives the panel.
  await expect.poll(() => oledName(page), { timeout: 20000 }).toBe('AI MATCH')

  // At least one knob leaves its default (−135°) position — the panel reflects the match.
  const angles = await page
    .locator('xd-knob[data-param-key]')
    .evaluateAll((els) =>
      els.map((el) =>
        (el as HTMLElement).style.getPropertyValue('--knob-angle'),
      ),
    )
  expect(angles.some((a) => a !== '' && a !== '-135deg')).toBe(true)
})
