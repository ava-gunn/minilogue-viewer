import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Automated WCAG A/AA audit (axe-core). The viewer is the single web view; the re-synth form
// lives in it behind the (feature-flagged) Resynthesis button, so it's audited with the form
// open. The Ableton embed reuses the same components/CSS and is covered structurally by
// views.a11y.test.ts.

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const summary = (
  violations: { id: string; impact?: string | null; nodes: unknown[] }[],
): string =>
  JSON.stringify(
    violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })),
    null,
    2,
  )

test('viewer: no WCAG A/AA axe violations', async ({ page }) => {
  await page.goto('/')
  await page.locator('main#main').waitFor()
  const { violations } = await new AxeBuilder({ page }).withTags(wcag).analyze()
  expect(violations, summary(violations)).toEqual([])
})

test('re-synth form: no WCAG A/AA axe violations', async ({ page }) => {
  await page.goto('/')
  await page.locator('main#main').waitFor()
  const open = page.locator('#resynth-open')
  // Skipped when the feature flag is off (the button is disabled and the form never loads).
  test.skip(await open.isDisabled(), 'Resynthesis disabled (VITE_RESYNTH_ENABLED off)')
  await open.click()
  await page.locator('#resynth-form:not([hidden])').waitFor()
  const { violations } = await new AxeBuilder({ page }).withTags(wcag).analyze()
  expect(violations, summary(violations)).toEqual([])
})

test('viewer: skip link is the first tab stop and targets main', async ({
  page,
}) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  const focused = page.locator(':focus')
  await expect(focused).toHaveClass(/skip-link/)
  await expect(focused).toHaveAttribute('href', '#main')
})
