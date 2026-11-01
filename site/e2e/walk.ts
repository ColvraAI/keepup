// The presenter's walk, by keyboard, with real motion: one screenshot after each press, to tmp/shots/walk.
// npm --prefix site run walk. Needs a running dashboard (KEEPUP_URL, default :4317).
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.KEEPUP_URL ?? 'http://127.0.0.1:4317';
const OUT = join(import.meta.dirname, '..', '..', 'tmp', 'shots', 'walk');
const SETTLE_MS = 2600;
const PRESSES = 19;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
await page.goto(`${BASE}/?present#pulse`);
await page.waitForTimeout(4200);
await page.screenshot({ path: join(OUT, '00-start.png') });
for (let press = 1; press <= PRESSES; press += 1) {
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(SETTLE_MS);
  const stop = await page.evaluate(() => {
    const element = document.querySelector('[data-screen]');
    return `${element?.getAttribute('data-screen') ?? 'none'}-${element?.getAttribute('data-stop') ?? ''}`;
  });
  const name = `${String(press).padStart(2, '0')}-${stop.replace(/[^a-z0-9-]/gi, '')}.png`;
  await page.screenshot({ path: join(OUT, name) });
  process.stdout.write(`${name} ${await page.evaluate(() => document.documentElement.scrollHeight)}\n`);
}
process.stdout.write(`errors: ${JSON.stringify(errors)}\n`);
await browser.close();
