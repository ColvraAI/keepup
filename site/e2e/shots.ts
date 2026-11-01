// Screenshots of every screen: npm run shots [-- <screen> ...] [--mode present|desktop|phone] [--full].
// Writes to tmp/shots at the repo root. Needs a running dashboard (KEEPUP_URL, default :4317).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.KEEPUP_URL ?? 'http://127.0.0.1:4317';
const OUT = join(import.meta.dirname, '..', '..', 'tmp', 'shots');
const SCREENS = ['overview', 'pulse', 'connect', 'understood', 'replay', 'pr', 'keeps-up', 'monday', 'moonshot', 'real'];
const PRESENT_SKIP = new Set(['overview', 'real']);
const MODES = {
  present: { width: 1920, height: 1080, query: '?present', full: false },
  desktop: { width: 1440, height: 900, query: '', full: true },
  phone: { width: 390, height: 844, query: '', full: true },
} as const;

type ModeName = keyof typeof MODES;

/** Screens have more than one state worth looking at. Each walks by the presenter's own key. */
const forward = (times: number) => async (page: Page) => {
  for (let press = 0; press < times; press += 1) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
  }
};

const STATES: readonly { name: string; screen: string; act: (page: Page) => Promise<void>; wait?: number }[] = [
  { name: 'connect-reading', screen: 'connect', act: forward(1) },
  { name: 'understood-payoff', screen: 'understood', act: forward(1) },
  { name: 'replay-2', screen: 'replay', act: forward(1) },
  { name: 'replay-3', screen: 'replay', act: forward(2) },
  { name: 'replay-4', screen: 'replay', act: forward(3) },
  { name: 'replay-end', screen: 'replay', act: forward(4) },
  { name: 'replay-aura', screen: 'replay', act: async (page) => { await page.getByRole('button', { name: 'AURA' }).click(); } },
  { name: 'replay-aura-end', screen: 'replay', act: async (page) => { await page.keyboard.press('a'); await page.waitForTimeout(100); while ((await page.locator('[data-screen="replay"]').getAttribute('data-stop')) !== 'end') await forward(1)(page); } },
  { name: 'connect-app', screen: 'connect', act: async (page) => { await page.getByTestId('connect-asks').click(); } },
  { name: 'pr-04', screen: 'pr/04', act: async () => undefined },
  { name: 'pr-05', screen: 'pr/05', act: async () => undefined },
  { name: 'pr-07', screen: 'pr/07', act: async () => undefined },
  { name: 'pr-03', screen: 'pr/03', act: async () => undefined },
  { name: 'pr-detail', screen: 'pr/01', act: async (page) => { await page.keyboard.press('d'); } },
  { name: 'keeps-claude', screen: 'keeps-up', act: forward(2) },
  { name: 'keeps-grows', screen: 'keeps-up', act: forward(3) },
  { name: 'monday-end', screen: 'monday', act: forward(1) },
  { name: 'moonshot-fleet', screen: 'moonshot', act: forward(1) },
  { name: 'pulse-notes', screen: 'pulse', act: async (page) => { await page.keyboard.press('n'); await page.keyboard.press('t'); } },
];

function parse(argv: string[]) {
  const modeIndex = argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? (argv[modeIndex + 1] as ModeName) : null;
  const screens = argv.filter((arg, index) => !arg.startsWith('--') && (modeIndex < 0 || index !== modeIndex + 1));
  const onlyStates = argv.includes('--states') && screens.length === 0;
  return { modes: mode ? [mode] : (Object.keys(MODES) as ModeName[]), screens: onlyStates ? [] : screens.length ? screens : SCREENS, full: argv.includes('--full') };
}

const { modes, screens, full } = parse(process.argv.slice(2));
const statesToo = process.argv.includes('--states') || process.argv.length === 2;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const name of modes) {
    const mode = MODES[name];
    const context = await browser.newContext({ viewport: { width: mode.width, height: mode.height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    for (const screen of screens) {
      if (name === 'present' && PRESENT_SKIP.has(screen)) continue;
      await page.goto('about:blank');
      await page.goto(`${BASE}/${mode.query}#${screen}`);
      await page.waitForSelector(`[data-screen="${screen}"]`, { timeout: 10_000 });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(OUT, `${name}-${screen}.png`), fullPage: mode.full || full });
    }
    if (name === 'present' && statesToo) {
      for (const state of STATES) {
        await page.goto('about:blank');
        await page.goto(`${BASE}/${mode.query}#${state.screen}`);
        await page.waitForSelector(`[data-screen="${state.screen.split('/')[0]}"]`, { timeout: 10_000 });
        await state.act(page);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, `present-state-${state.name}.png`) });
      }
    }
    await context.close();
  }
  if (process.argv.includes('--motion')) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/?present#pulse`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'motion-pulse-early.png') });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(OUT, 'motion-pulse-mid.png') });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, 'motion-pulse-landed.png') });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, 'motion-connect-cut.png') });
    await page.goto(`${BASE}/?present#understood`);
    await page.getByTestId('reveal-payoff').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, 'motion-payoff-start.png') });
    await page.waitForTimeout(1400);
    await page.screenshot({ path: join(OUT, 'motion-payoff-mid.png') });
    await page.waitForTimeout(1050);
    await page.screenshot({ path: join(OUT, 'motion-payoff-dots.png') });
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(OUT, 'motion-payoff-travel.png') });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(OUT, 'motion-payoff-end.png') });
    await context.close();
  }
} finally {
  await browser.close();
}
process.stdout.write(`Shots in ${OUT}\n`);
