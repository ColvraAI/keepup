import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SCREENS = ['overview', 'pulse', 'connect', 'understood', 'replay', 'pr', 'keeps-up', 'monday', 'moonshot', 'real'];
const DEMO = ['pulse', 'connect', 'understood', 'replay', 'pr', 'keeps-up', 'monday', 'moonshot'];
const SITE_DATA = join(import.meta.dirname, '..', 'data');
const BUDGET_MS = 30_000;

const readJson = (name: string) => JSON.parse(readFileSync(join(SITE_DATA, name), 'utf8'));

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

for (const screen of SCREENS) {
  test(`${screen} renders with no console errors or outside requests`, async ({ page, baseURL }) => {
    const errors = watchErrors(page);
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(baseURL ?? '') && !request.url().startsWith('data:')) outside.push(request.url());
    });
    await page.goto(`/#${screen}`);
    await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  });
}

test('the pulse shows the total from the data', async ({ page }) => {
  const pulse = readJson('pulse.json');
  await page.goto('/#pulse');
  await page.locator('[data-screen="pulse"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('pulse-counter')).toHaveText(pulse.total.toLocaleString('en-US'));
});

test('present mode moves through every screen by keyboard, inside the budget', async ({ page }) => {
  const errors = watchErrors(page);
  const start = Date.now();
  await page.goto('/?present#pulse');
  await expect(page.locator('[data-screen="pulse"]')).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/is-present/);
  for (const screen of DEMO.slice(1)) {
    for (let press = 0; press < 12; press += 1) {
      if (await page.locator(`[data-screen="${screen}"]`).count()) break;
      await page.keyboard.press('ArrowRight');
    }
    // The story holds on the tagline: the bonus is reached only by its number.
    if (screen === 'moonshot') await page.keyboard.press('8');
    await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
  }
  expect(Date.now() - start).toBeLessThan(BUDGET_MS);
  await page.keyboard.press('1');
  await expect(page.locator('[data-screen="pulse"]')).toBeVisible();
  await page.keyboard.press('4');
  await expect(page.locator('[data-screen="replay"]')).toBeVisible();
  expect(page.url()).toContain('#replay');
  expect(errors).toEqual([]);
});

test('present mode: notes, timer and exit', async ({ page }) => {
  await page.goto('/?present#replay');
  await expect(page.getByTestId('present-notes')).toHaveCount(0);
  await page.keyboard.press('n');
  // The presenter's script isn't in a public checkout, so the pane only has this text where the script is.
  if (existsSync(join(process.cwd(), '..', 'docs', 'script.md'))) await expect(page.getByTestId('present-notes')).toContainText('fix came 4 days later');
  await page.keyboard.press('t');
  await expect(page.getByTestId('present-timer')).toContainText(/1:5\d|2:00/);
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/is-present/);
  await page.keyboard.press('p');
  await expect(page.locator('html')).toHaveClass(/is-present/);
});

test('no text under 20px in present mode', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const screen of DEMO) {
    await page.goto(`/?present#${screen}`);
    await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
    const small = await page.evaluate(() => {
      const seen = new Set<string>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node.parentElement;
        if (!element || !node.textContent?.trim() || element.closest('script, style')) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < 19.9) seen.add(`${size}px: ${node.textContent.trim().slice(0, 40)}`);
      }
      return [...seen];
    });
    expect(small, screen).toEqual([]);
  }
});

test('the Claude-only toggle re-plans onto the second pull request and its real patch', async ({ page }) => {
  const prs = readJson('prs.json').prs;
  const variant = prs.find((pr: { id: string }) => pr.id === '01-jev');
  await page.goto('/#keeps-up');
  await page.getByTestId('moment-tab-claude').click();
  await expect(page.getByTestId('claude-only-title')).toContainText('Decisions API');
  await page.getByTestId('claude-only-toggle').check({ force: true });
  await expect(page.getByTestId('plan-new')).toBeVisible();
  await expect(page.getByTestId('claude-only-title')).toContainText('Jev');
  await expect(page.getByTestId('moment-claude')).toContainText(variant.title);
  await expect(page.getByTestId('diff-body')).toBeVisible();
  await expect(page.getByTestId('moment-claude')).toContainText(variant.stages[0].diff.patches[0].subject);
});

test('every external link is https, and none points at a pull request or issue the data does not hold', async ({ page }) => {
  const prs = readJson('prs.json').prs;
  const weekly = readJson('weekly.json').briefs;
  const allowed = new Set<string>([
    ...prs.flatMap((pr: { github: { url: string } | null }) => (pr.github ? [pr.github.url] : [])),
    ...weekly.flatMap((brief: { issue: { url: string } | null }) => (brief.issue ? [brief.issue.url] : [])),
  ]);
  for (const screen of SCREENS) {
    await page.goto(`/#${screen}`);
    await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      if (href.startsWith('#')) continue;
      expect(href, `${screen}: ${href}`).toMatch(/^https:\/\//);
      if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/.test(href)) {
        expect(allowed.has(href), `${screen}: ${href} is not in github-objects`).toBe(true);
      }
    }
  }
});

test('nothing claims to be on GitHub while the data says it is not', async ({ page }) => {
  const manifest = readJson('manifest.json');
  test.skip(manifest.github.exists, 'github-objects.json has entries');
  await page.goto('/#pr');
  await expect(page.getByTestId('pr-card')).toContainText('Ready to open');
  await expect(page.getByRole('link', { name: 'Open on GitHub' })).toHaveCount(0);
  await page.goto('/#real');
  await expect(page.getByTestId('github-state')).toContainText('Nothing');
});

test('an unmeasured lab shows no number', async ({ page }) => {
  const prs = readJson('prs.json').prs;
  const unmeasured = prs.find((pr: { lab: { status: string } }) => pr.lab.status === 'not_run');
  test.skip(!unmeasured, 'every lab has run');
  await page.goto(`/#pr/${unmeasured.id}`);
  await expect(page.getByTestId('pr-not-measured')).toContainText('Not measured yet');
  await expect(page.getByTestId('pr-number')).toHaveCount(0);
});

test('the replay switches repo, plays, pauses in place, and computes its headline', async ({ page }) => {
  await page.goto('/#replay');
  await expect(page.getByTestId('lead-story')).toContainText('gpt-4.1-nano');
  await expect(page.getByTestId('replay-headline')).toContainText('one commit');
  await expect(page.getByTestId('gap-chart')).toContainText('56 days');
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveText('Pause');
  await expect(page.locator('.week--dim').first()).toBeVisible();
  await page.getByTestId('timeline').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('replay-play')).toHaveText(/^Resume from/);
  await expect(page.locator('.week--dim').first()).toBeVisible();
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-play')).toHaveText('Pause');
  await page.getByTestId('replay-play').click();
  await page.getByRole('button', { name: 'AURA' }).click();
  await expect(page.getByTestId('lead-story')).toContainText('137');
});

test('team lines say what the commit really did', async ({ page }) => {
  await page.goto('/#replay');
  const row = page.getByTestId('replay-row').filter({ hasText: 'GPT-6 Sol and GPT-6 Luna released' });
  await expect(row).toContainText('35 days later');
  await expect(row).toContainText('gpt-6-sol was never added');
  await expect(row).toContainText('only used when the live model list call fails');
  await expect(row).toContainText('specified by hand');
  await expect(page.getByTestId('replay-row').filter({ hasText: 'gpt-4.1-nano' })).toContainText('engine run');
});

test('the words on the patches are counted, never a constant', async ({ page }) => {
  const prs = readJson('prs.json').prs;
  const recorded = prs.filter((pr: { repo_tests: unknown }) => pr.repo_tests).length;
  await page.goto('/#real');
  await expect(page.getByTestId('github-state')).toContainText(`${prs.length} built patches, ${recorded} with the repo’s tests recorded`);
  await expect(page.locator('[data-screen="real"]')).not.toContainText('tested patch');
  await expect(page.locator('[data-screen="real"]')).toContainText('specified by hand');
});

test('Monday says what share of weeks were quiet, from the data', async ({ page }) => {
  const briefs = readJson('weekly.json').briefs;
  const quiet = briefs.filter((brief: { body: string }) => !brief.body.includes('\n')).length;
  await page.goto('/#monday');
  await expect(page.getByTestId('quiet-count')).toContainText(`${quiet} of the ${briefs.length}`);
  await expect(page.locator('[data-screen="monday"]')).not.toContainText('things checked');
  await expect(page.locator('[data-screen="monday"]')).not.toContainText('Most weeks');
});

test('moonshot: changing an assumption changes the projection, and it stays labelled', async ({ page }) => {
  await page.goto('/#moonshot');
  const result = page.getByTestId('goal-result');
  await expect(result).toContainText('projected');
  const before = await result.textContent();
  await page.getByTestId('assume-cheapShare').fill('0');
  await expect(result).not.toHaveText(before ?? '');
  await expect(result).toContainText('projected');
});

test('connect replays the real steps', async ({ page }) => {
  const runs = readJson('runs.json').runs;
  const run = runs.find((item: { file: string }) => item.file === 'anything-llm.json').run;
  await page.goto('/#connect');
  await page.getByTestId('connect-repo').click();
  await page.locator('[data-screen="connect"]').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('reading-steps').locator('li')).toHaveCount(run.steps.length);
  await expect(page.getByTestId('reading-steps')).toContainText(run.steps[0].name);
  await expect(page.getByTestId('reading-steps')).toContainText('saved answer');
  await expect(page.getByTestId('connect-title')).toContainText('Read:');
  await expect(page.getByTestId('reading-steps')).not.toContainText('1 findings');
});

test('the local server is detected, and the scan box refuses a bad name', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.getByTestId('live-input')).toBeVisible();
  await page.getByTestId('live-input').fill('../etc');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('.live__error')).toContainText('owner/name');
});

test('the scan box says the truth about where code goes', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.getByTestId('live-privacy')).toContainText('within 20 minutes');
  await expect(page.getByTestId('live-privacy')).toContainText('masked excerpts to Anthropic');
  await expect(page.getByTestId('live-judge')).toHaveCount(0);
});

test('the API refuses a foreign origin', async ({ request, baseURL }) => {
  const response = await request.post(`${baseURL}/api/scan`, { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, data: { repo: 'a/b' } });
  expect(response.status()).toBe(403);
});

for (const width of [390, 1440, 1920]) {
  test(`no sideways scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const screen of SCREENS) {
      await page.goto(`/#${screen}`);
      await expect(page.locator(`[data-screen="${screen}"]`)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, screen).toBeLessThanOrEqual(0);
    }
  });
}

test('Stop stops: pressing it never starts a second scan', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/scan', async (route) => {
    posts += 1;
    await new Promise((done) => setTimeout(done, 1500));
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'done' })}\n` }).catch(() => undefined);
  });
  await page.goto('/#overview');
  await page.getByTestId('live-input').fill('mezmo/aura');
  await page.getByTestId('live-scan-go').click();
  await page.getByTestId('live-stop').click();
  await expect(page.getByTestId('live-scan-go')).toBeVisible();
  await page.waitForTimeout(300);
  expect(posts).toBe(1);
});

test('the home is the tool: add a repo, then your repos, with the replay in one group', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Add a repo' })).toBeVisible();
  await expect(page.getByTestId('repo-row').first()).toBeVisible();
  await expect(page.locator('.overview__tagline')).toHaveCount(0);
  await expect(page.locator('nav').getByRole('link', { name: 'The 60-day replay' })).toBeVisible();
  await expect(page.locator('nav').getByRole('link', { name: 'Pull requests' })).toBeVisible();
});

test('a repo page shows findings to change and what was held back', async ({ page }) => {
  const run = JSON.parse(readFileSync(join(SITE_DATA, '..', '..', 'data', 'runs', 'aura.json'), 'utf8'));
  await page.goto('/');
  await page.getByRole('link', { name: 'mezmo/aura' }).click();
  await expect(page.getByTestId('finding')).toHaveCount(run.findings.length);
  await expect(page.getByTestId('held-back')).toHaveCount(run.held_back.length);
  await expect(page.getByTestId('make-change').first()).toBeVisible();
});


test('the repo page works out a lever\'s ROI live, for the model the person picks', async ({ page }) => {
  await page.goto('/#repo/Mintplex-Labs%2Fanything-llm');
  const card = page.locator('[data-testid="finding"]').first();
  const lines = card.locator('[data-testid="roi-line"]');
  await expect(lines).toHaveCount(2);
  await expect(lines.first()).toContainText('[projected, example]');
  await expect(card.locator('[data-testid="roi-option"]').first()).toContainText('TypeSafe Jev');
  await expect(card.locator('[data-testid="roi-option"]').nth(1)).toContainText('OpenAI Decisions API');
  await expect(card.locator('[data-testid="roi-formula"]')).toContainText('payback = cost of change');
  const before = await lines.first().textContent();
  await card.locator('[data-testid="roi-calls"]').fill('2000000');
  await expect(lines.first()).toContainText('at 2,000,000 calls');
  await expect(lines.first()).toContainText('pays back in');
  await card.locator('[data-testid="roi-model"]').selectOption('gpt-6-luna');
  await expect(lines.first()).toContainText('[projected]');
  expect(await lines.first().textContent()).not.toEqual(before);
  await expect(page.locator('[data-testid="value-absent"]').first()).toContainText('no money figure');
});

test('a published repo page shows the value line, Measure, For your team and one Also line', async ({ page }) => {
  await page.goto('/#repo/Mintplex-Labs%2Fanything-llm');
  await expect(page.locator('[data-screen="repo"]')).toBeVisible();
  await expect(page.getByTestId('biggest-lever').or(page.getByTestId('nothing-big'))).toHaveCount(1);
  await expect(page.locator('[data-testid="lever-value"], [data-testid="value-absent"]').first()).toBeVisible();
  await expect(page.getByTestId('measure-now').first()).toBeVisible();
  await expect(page.getByTestId('also-retired')).toHaveCount(1);
  await expect(page.getByTestId('also-retired').locator('summary')).toContainText('Also:');
  await expect(page.getByTestId('also-retired').getByTestId('finding').first()).toBeHidden();
  await page.goto('/#repo/mezmo%2Faura');
  await expect(page.getByTestId('for-your-team')).toBeVisible();
});

test('with no local API, the buttons say they need npm run dashboard', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.goto('/#repo/mezmo%2Faura');
  await expect(page.getByTestId('make-absent').first()).toContainText('npm run dashboard');
  await expect(page.getByTestId('make-change').first()).toBeDisabled();
  await page.goto('/');
  await page.reload();
  await expect(page.getByTestId('live-absent')).toContainText('npm run dashboard');
});
