import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DEMO = ['pulse', 'connect', 'understood', 'replay', 'pr', 'keeps-up', 'monday', 'moonshot'];
const STORY = DEMO.slice(0, -1);
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1512, height: 982 },
];
const SITE_DATA = join(import.meta.dirname, '..', 'data');
const readJson = (name: string) => JSON.parse(readFileSync(join(SITE_DATA, name), 'utf8'));
const screen = (page: Page, id: string) => page.locator(`[data-screen="${id}"]`);

/** Forward until a screen appears, counting presses: the walk a clicker makes. */
async function forwardTo(page: Page, id: string, key = 'ArrowRight', max = 12): Promise<number> {
  for (let press = 0; press < max; press += 1) {
    if (await screen(page, id).count()) return press;
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
  }
  throw new Error(`Never reached ${id}`);
}

async function forwardToStop(page: Page, stop: string, max = 10): Promise<void> {
  for (let press = 0; press < max; press += 1) {
    if ((await screen(page, 'replay').getAttribute('data-stop')) === stop) return;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(40);
  }
  throw new Error(`Never reached stop ${stop}`);
}

const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);

for (const viewport of VIEWPORTS) {
  test(`every story screen fits the stage at ${viewport.width}x${viewport.height}, in every beat`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewport);
    await page.goto('/?present#pulse');
    for (const id of STORY) {
      await forwardTo(page, id);
      for (let beat = 0; beat < 8; beat += 1) {
        expect(await pageOverflow(page), `${id} beat ${beat}`).toBeLessThanOrEqual(2);
        const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(width, `${id} beat ${beat} sideways`).toBeLessThanOrEqual(0);
        if (!(await page.locator('[data-present-beat]').count())) break;
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(40);
      }
    }
  });
}

test('?present with no screen named starts on the pulse', async ({ page }) => {
  await page.goto('/?present');
  await expect(screen(page, 'pulse')).toBeVisible();
  expect(page.url()).toContain('#pulse');
});

test('a new screen opens at its top, whatever the last was scrolled to', async ({ page }) => {
  await page.goto('/#replay');
  await page.getByTestId('replay-headline').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await page.locator('[data-testid="timeline"] a[href^="#pr/"]').first().click();
  await expect(screen(page, 'pr')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('the one forward key plays every beat, in order, on arrow, space and PageDown alike', async ({ page }) => {
  for (const key of ['ArrowRight', ' ', 'PageDown']) {
    await page.goto('about:blank');
    await page.goto('/?present#connect');
    await expect(page.getByTestId('connect-first')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('reading-steps')).toBeVisible();
    await forwardTo(page, 'understood', key);
    await expect(page.getByTestId('reveal-payoff')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('collapse-canvas')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('payoff-line')).toBeVisible();
    await page.keyboard.press(key);
    await expect(screen(page, 'replay')).toBeVisible();
    await expect(page.getByTestId('lead-story')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-date', '2026-09-22');
    await page.keyboard.press(key);
    await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-date', '2026-10-07');
    await page.keyboard.press(key);
    await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-date', '2026-10-27');
    await page.keyboard.press(key);
    await expect(page.getByTestId('replay-headline')).toBeVisible();
    await expect(page.getByTestId('gap-chart')).toBeVisible();
    await expect(page.getByTestId('gap-lead')).toBeVisible();
    await page.keyboard.press(key);
    await expect(screen(page, 'pr')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('moment-update')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('moment-claude')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('plan-new')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('moment-grows')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('brief')).toBeVisible();
    await page.keyboard.press(key);
    await expect(page.getByTestId('tagline-screen')).toBeVisible();
    await page.keyboard.press(key);
    await page.waitForTimeout(80);
    await expect(page.getByTestId('tagline-screen'), 'a stray press holds on the tagline').toBeVisible();
    await page.keyboard.press('8');
    await expect(screen(page, 'moonshot')).toBeVisible();
  }
});

test('clicking the switch with the mouse leaves the presenter keys working', async ({ page }) => {
  await page.goto('/?present#keeps-up');
  await expect(screen(page, 'keeps-up')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.locator('.toggle').click();
  await expect(page.getByTestId('claude-only-title')).toContainText('Jev');
  await page.waitForTimeout(40);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('moment-grows')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/is-present/);
});

test('Esc works from a number field, and arrows still move', async ({ page }) => {
  await page.goto('/?present#moonshot');
  await page.getByTestId('assume-messages').click();
  await page.keyboard.press('ArrowLeft');
  await expect(screen(page, 'monday')).toBeVisible();
  await page.goto('/?present#moonshot');
  await page.getByTestId('assume-messages').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/is-present/);
});

test('T and N leave the climb running; forward finishes it without leaving', async ({ page }) => {
  const total = readJson('pulse.json').total.toLocaleString('en-US');
  await page.goto('/?present#pulse');
  await page.keyboard.press('t');
  await page.keyboard.press('n');
  await page.keyboard.press('n');
  const counter = page.getByTestId('pulse-counter');
  await expect(counter).not.toHaveText(total, { timeout: 200 });
  await page.keyboard.press('ArrowRight');
  await expect(counter).toHaveText(total);
  await expect(screen(page, 'pulse')).toBeVisible();
  await expect(page.getByTestId('pulse-line')).toHaveCSS('opacity', /^(0\.[1-9]|1)/, { timeout: 2000 });
});

test('Enter and Space work the control that has focus', async ({ page }) => {
  await page.goto('/?present#understood');
  await page.getByRole('button', { name: 'AURA' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveAttribute('aria-pressed', 'true');
  await expect(screen(page, 'understood')).toBeVisible();
});

test('Connect opens on the name and one button; A switches the repo, and the App asks in a panel', async ({ page }) => {
  await page.goto('/?present#connect');
  await expect(page.getByTestId('connect-first')).toContainText('AnythingLLM');
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(page.getByTestId('connect-first')).toContainText('AURA');
  await page.getByTestId('connect-asks').click();
  await expect(page.getByTestId('present-detail')).toContainText('What the keepup App asks for');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('connect-repo')).toBeVisible();
});

test('the repo chosen on one screen carries to the next', async ({ page }) => {
  await page.goto('/?present#connect');
  await page.keyboard.press('a');
  await page.keyboard.press('3');
  await expect(screen(page, 'understood').locator('h1')).toContainText('AURA');
  await page.keyboard.press('4');
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lead-story')).toContainText('137');
  await expect(page.getByTestId('gap-lead-days')).toContainText('137');
  await page.keyboard.press('7');
  await expect(page.getByTestId('keepup-check')).toContainText('aura');
  await expect(page.getByTestId('keepup-check')).not.toContainText('tmp/');
});

test('back undoes one beat, and leaves a screen only from its first', async ({ page }) => {
  await page.goto('/?present#replay');
  await expect(page.getByTestId('lead-story')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-date', '2026-10-07');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('replay-stop')).toHaveAttribute('data-date', '2026-09-22');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('lead-story')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(screen(page, 'understood')).toBeVisible();
  await expect(page.getByTestId('payoff-line'), 'it lands on the beat it ended on, without the collapse').toBeVisible();
  await expect(page.getByTestId('collapse-canvas')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('reveal-payoff')).toBeVisible();
});

test('back across It keeps up keeps the flip, and back from the tagline goes to the brief', async ({ page }) => {
  await page.goto('/?present#keeps-up');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('plan-new')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('moment-grows')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('plan-new')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('moment-claude')).toBeVisible();
  await expect(page.getByTestId('plan-new')).toHaveCount(0);
  await page.goto('/?present#monday');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tagline-screen')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('brief')).toBeVisible();
});

test('a refresh keeps the screen, the repo, the beat and the clock', async ({ page }) => {
  await page.goto('/?present#replay');
  await page.keyboard.press('a');
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowRight');
  const stop = await screen(page, 'replay').getAttribute('data-stop');
  await page.keyboard.press('t');
  await expect(page.getByTestId('present-timer')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveAttribute('aria-pressed', 'true');
  await expect(screen(page, 'replay')).toHaveAttribute('data-stop', stop ?? '');
  await expect(page.getByTestId('present-timer')).not.toHaveText('2:00');
});

test('a fresh load starts fresh, even in the same tab', async ({ page }) => {
  await page.goto('/?present#monday');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tagline-screen')).toBeVisible();
  await page.goto('about:blank');
  await page.goto('/?present#monday');
  await expect(page.getByTestId('brief')).toBeVisible();
});

test('the timer takes no clicks and covers no control', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?present#replay');
  await page.keyboard.press('t');
  await expect(page.getByTestId('present-timer')).toBeVisible();
  await expect(page.getByTestId('present-timer')).toHaveCSS('pointer-events', 'none');
  await page.getByRole('button', { name: 'AURA' }).click({ timeout: 2000 });
  await expect(page.getByRole('button', { name: 'AURA' })).toHaveAttribute('aria-pressed', 'true');
});

test('a ?present link stays in present mode through hydration, with no dashboard frame', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    const watch = () => {
      if (document.documentElement) seen.push(document.documentElement.classList.contains('is-present'));
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await page.goto('/?present#pulse');
  await expect(screen(page, 'pulse')).toBeVisible();
  await page.waitForTimeout(400);
  const seen = await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen);
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.filter((on) => !on)).toEqual([]);
});

test('the bonus fits the stage on both its beats, and its levers are one row each', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await page.goto('about:blank');
    await page.goto('/?present#moonshot');
    await expect(page.getByTestId('fleet')).toHaveCount(0);
    expect(await pageOverflow(page)).toBeLessThanOrEqual(2);
    await expect(page.locator('.formula')).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('fleet')).toBeVisible();
    expect(await pageOverflow(page)).toBeLessThanOrEqual(2);
  }
  await page.goto('about:blank');
  await page.goto('/?present#moonshot');
  await page.keyboard.press('d');
  await expect(page.getByTestId('present-detail').locator('.formula').first()).toBeVisible();
  await expect(page.getByTestId('usage-later')).toContainText('stays projected');
});

test('the replay ends on its sentence, under the same chart, with what the engine raised', async ({ page }) => {
  const anything = readJson('replay.json').repos[0].headline_parts;
  await page.goto('/?present#replay');
  await forwardToStop(page, 'end');
  await expect(page.getByTestId('replay-headline')).toContainText(anything.big);
  await expect(page.getByTestId('replay-headline')).toContainText(anything.short);
  await expect(page.getByTestId('replay-headline')).toContainText(/The engine raised 1, and its pull request was written by hand; the other 2 were specified by hand/);
  await expect(page.getByTestId('replay-headline')).toContainText('one commit');
  await expect(page.getByTestId('gap-lead-days')).toBeVisible();
});

test('the lead carries its label, and says the judge run was hindsight', async ({ page }) => {
  await page.goto('/?present#replay');
  await expect(page.getByTestId('lead-label')).toContainText('not measured yet');
  await expect(page.getByTestId('lead-label')).toContainText('chats with no model set');
  await expect(page.getByTestId('lead-story')).toContainText('today’s pattern list');
});

test('a refusal and the pull request that overrides it say so on both screens', async ({ page }) => {
  await page.goto('/?present#understood');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('refusal-exception')).toContainText('PR 06');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('engine-conflict')).toContainText('hand-written exception');
});

test('the dead Gemini default carries no pull request', async ({ page }) => {
  await page.goto('/#understood');
  const row = page.locator('.payoff__list li', { hasText: 'gemini-2.0-flash-lite' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('a[href^="#pr/"]')).toHaveCount(0);
});

test('PR 04 labels what it measured and shows what it has not', async ({ page }) => {
  await page.goto('/?present#pr/04');
  await expect(page.getByTestId('pr-measured-caption')).toContainText('Measured');
  await expect(page.getByTestId('pr-lab-table')).toContainText('Tools the agent gets');
  await expect(page.getByTestId('pr-absent-row')).toContainText('Sentry');
  await expect(page.getByTestId('pr-absent-row')).toContainText('Not measured yet');
});

test('the two sets of counts on a pull request say what they cover', async ({ page }) => {
  await page.goto('/?present#pr/01');
  await expect(page.getByTestId('pr-facts')).toContainText('whole pull request');
  await expect(page.locator('.diff-scope')).toContainText('this commit');
  await expect(page.getByTestId('diff-more-files')).toContainText('+4 more files');
});

test('It keeps up: the title holds still, and the flip drops the OpenAI plan', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?present#keeps-up');
  const top = () => page.locator('.keeps h1').evaluate((element) => element.getBoundingClientRect().top);
  const first = await top();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.moment__diff')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('plan-dropped')).toContainText('Needs OpenAI');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('moment-grows')).toBeVisible();
  expect(await top()).toBe(first);
});

test('the pulse field paints with reduced motion on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?present#pulse');
  await page.waitForTimeout(300);
  const lit = await page.getByTestId('pulse-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? new Uint8ClampedArray();
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) count += 1;
    return count / (canvas.width * canvas.height);
  });
  expect(lit).toBeGreaterThan(0.15);
});

test('the pulse holds its line back until the counter lands', async ({ page }) => {
  await page.goto('/?present#pulse');
  await expect(page.getByTestId('pulse-line')).toHaveCSS('opacity', '0');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('pulse-line')).toHaveCSS('opacity', '1', { timeout: 2000 });
});

test('the collapse runs alone, and the answer shows only after it', async ({ page }) => {
  await page.goto('/?present#understood');
  await page.getByTestId('reveal-payoff').click();
  await expect(page.getByTestId('collapse-canvas')).toBeVisible();
  await expect(page.getByTestId('payoff-line')).toHaveCount(0);
  await expect(page.getByTestId('payoff-line')).toBeVisible({ timeout: 5000 });
  const run = readJson('runs.json').runs.find((item: { file: string }) => item.file === 'anything-llm.json').run;
  await expect(page.getByTestId('refusals')).toContainText(`${run.held_back.length} held back`);
});

test('Monday ends on the tagline alone', async ({ page }) => {
  await page.goto('/?present#monday');
  await expect(page.getByTestId('tagline')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tagline')).toBeVisible();
  await expect(page.getByTestId('brief')).toHaveCount(0);
});

test('unmeasured outcomes never read as facts', async ({ page }) => {
  await page.goto('/?present#pr/01');
  await expect(page.getByTestId('pr-card')).not.toContainText(/\bcheaper\b|\bfaster\b/);
  await page.goto('/#pr/01');
  await expect(page.locator('.pr-chips')).toContainText('expected: cheaper, faster');
});

test('D opens the detail, and Esc closes it before it exits', async ({ page }) => {
  await page.goto('/?present#pr/01');
  await expect(page.getByTestId('present-detail')).toHaveCount(0);
  await page.keyboard.press('d');
  await expect(page.getByTestId('present-detail')).toContainText('Risks');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('present-detail')).toHaveCount(0);
  await expect(page.locator('html')).toHaveClass(/is-present/);
});
