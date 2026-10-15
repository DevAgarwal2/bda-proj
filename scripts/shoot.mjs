/* Capture every dashboard page at desktop and mobile for the inspection round.
   node scripts/shoot.mjs [--only desktop|mobile|page] [--page /cab] [--wait 1400]
   Writes .impeccable/review/<page>-<viewport>.png and reports console errors. */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 ? process.argv[i + 1] : d;
};
const WAIT = Number(arg('wait', 1800));
const ONLY = arg('only', null);
const ONLYPAGE = arg('page', null);
const BASE = arg('url', 'http://localhost:4321');
const OUT = '.impeccable/review';
mkdirSync(OUT, { recursive: true });

const PAGES = [
  { path: '/', name: 'overview' },
  { path: '/cab', name: 'cab' },
  { path: '/weather', name: 'weather' },
  { path: '/interaction', name: 'interaction' },
  { path: '/zones', name: 'zones' },
  { path: '/flow', name: 'flow' },
  { path: '/method', name: 'method' },
].filter((p) => !ONLYPAGE || p.path === ONLYPAGE);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000, full: true },
  { name: 'mobile', width: 390, height: 844, full: true },
].filter((v) => !ONLY || v.name === ONLY);

const browser = await chromium.launch();
const problems = [];

for (const vp of VIEWPORTS) {
  for (const pg of PAGES) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const local = [];
    page.on('console', (m) => { if (m.type() === 'error') local.push('console: ' + m.text().slice(0, 200)); });
    page.on('pageerror', (e) => local.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('requestfailed', (r) => local.push(`failed: ${r.url().replace(BASE, '')} ${r.failure()?.errorText}`));

    await page.goto(BASE + pg.path, { waitUntil: 'load' });
    // wait until no panel is still loading, or 20s
    await page.waitForFunction(
      () => !document.querySelector('[data-state="loading"]'),
      { timeout: 20000 },
    ).catch(() => local.push('timeout waiting for panels'));

    await page.waitForTimeout(WAIT);

    const info = await page.evaluate(() => {
      const states = [...document.querySelectorAll('[data-state]')].map((e) => e.dataset.state);
      const bad = states.filter((s) => s !== 'ready');
      const de = document.documentElement;
      const over = [];
      if (de.scrollWidth > de.clientWidth + 1) over.push(`page ${de.scrollWidth}>${de.clientWidth}`);
      for (const el of document.querySelectorAll('.panel, .chart, .kpis, .topbar, .content')) {
        if (el.scrollWidth > el.clientWidth + 2) over.push(`${el.className.split(' ')[0]} ${el.scrollWidth}>${el.clientWidth}`);
      }
      const empties = [...document.querySelectorAll('.chart, .panel__body')].filter((e) => e.children.length === 0).length;
      return { states: states.length, bad, over, empties, title: document.querySelector('h1')?.textContent };
    });

    const file = `${OUT}/${pg.name}-${vp.name}.png`;
    await page.screenshot({ path: file, fullPage: vp.full });
    const tag = `${pg.name}/${vp.name}`;
    console.log(`${tag.padEnd(22)} panels=${info.states} ${info.bad.length ? 'NOT-READY:' + info.bad.join(',') : 'all ready'}${info.over.length ? ' OVERFLOW: ' + info.over.join(' | ') : ''}${info.empties ? ' EMPTY-BODIES:' + info.empties : ''}`);
    for (const l of [...new Set(local)]) problems.push(`[${tag}] ${l}`);
    await ctx.close();
  }
}

await browser.close();
if (problems.length) {
  console.log('\nPROBLEMS');
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nclean: no console errors, no failed requests, no overflow');
}
