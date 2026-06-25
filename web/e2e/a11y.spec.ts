import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Automated WCAG A/AA audit (axe-core) over the two web-served views. Catches contrast,
// ARIA, label and landmark regressions in a real browser (the vitest specs cover structure +
// keyboard; axe adds layout-dependent checks like contrast). The Ableton embed reuses the
// same components/CSS and is covered structurally by views.a11y.test.ts.

const views = [
  { name: 'viewer', path: '/' },
  { name: 're-synth', path: '/resynth.html' },
]

for (const { name, path } of views) {
  test(`${name}: no WCAG A/AA axe violations`, async ({ page }) => {
    await page.goto(path)
    await page.locator('main#main').waitFor()
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    // Surface the rule ids + counts in the failure message for quick triage.
    expect(
      violations,
      JSON.stringify(
        violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          n: v.nodes.length,
        })),
        null,
        2,
      ),
    ).toEqual([])
  })
}

test('viewer: skip link is the first tab stop and targets main', async ({
  page,
}) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  const focused = page.locator(':focus')
  await expect(focused).toHaveClass(/skip-link/)
  await expect(focused).toHaveAttribute('href', '#main')
})
