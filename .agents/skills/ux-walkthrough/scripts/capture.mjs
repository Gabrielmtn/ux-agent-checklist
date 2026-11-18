#!/usr/bin/env node
// Look at a thread's page the way the reviewer saw it.
//
//   capture.mjs <thread-id> [--out DIR] [--width W --height H] [--theme light|dark] [--settle-ms 400]
//
// Opens context.url through the review server at the reviewer's viewport, DPR
// and colour scheme, hides the review panel, and writes:
//   page.png      what was on screen
//   full.png      the whole page
//   element.png   the picked element, if there is one and it still matches
//   capture.json  conditions, the element's box and key computed styles, console errors
//
// Needs Playwright in the site's repo (an optional dependency of this skill):
//   npm i -D playwright && npx playwright install chromium
// Exit 2 if Playwright or the page isn't available: the step then falls back
// to your own browser, or to the source.
import fs from 'node:fs';
import path from 'node:path';
import { BASE, fail, getThread, parseArgs, workDir } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const thread = await getThread(args._[0]);
const ctx = thread.context || {};
const out = path.resolve(args.out || path.join(workDir(thread.id), 'capture'));
fs.mkdirSync(out, { recursive: true });

let pw = null;
for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
  try { pw = await import(name); break; } catch (_) { /* try the next one */ }
}
const chromium = pw && (pw.chromium || (pw.default && pw.default.chromium));
if (!chromium) fail(2, 'Playwright not found. Install it in the site repo (npm i -D playwright && npx playwright install chromium), or look with your own browser.');

const [vw, vh] = String(ctx.viewport || '1280x800').split('x').map(Number);
const conditions = {
  url: BASE + (ctx.url || '/'),
  width: Number(args.width) || vw || 1280,
  height: Number(args.height) || vh || 800,
  dpr: Number(ctx.dpr) || 1,
  theme: args.theme || ctx.theme || 'light',
};

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  fail(2, 'Could not start Chromium: ' + e.message.split('\n')[0] + '. Try: npx playwright install chromium');
}
const result = { thread: thread.id, conditions, console: [], element: null };
try {
  const context = await browser.newContext({
    viewport: { width: conditions.width, height: conditions.height },
    deviceScaleFactor: conditions.dpr,
    colorScheme: conditions.theme === 'dark' ? 'dark' : 'light',
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') result.console.push(m.text().slice(0, 500)); });
  page.on('pageerror', (e) => result.console.push('pageerror: ' + String(e.message).slice(0, 500)));
  try {
    await page.goto(conditions.url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    await browser.close();
    fail(2, 'Could not load ' + conditions.url + ': ' + e.message.split('\n')[0]);
  }
  // The panel is not part of the site: keep it out of the pixels.
  await page.addStyleTag({ content: '#ux-review-host{display:none!important}' });
  await page.waitForTimeout(Number(args['settle-ms']) || 400);
  await page.screenshot({ path: path.join(out, 'page.png') });
  await page.screenshot({ path: path.join(out, 'full.png'), fullPage: true });

  const sel = ctx.element && ctx.element.selector;
  if (sel) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    result.element = { selector: sel, label: ctx.element.label, matches: count };
    if (count) {
      const first = loc.first();
      result.element.box = await first.boundingBox();
      result.element.styles = await first.evaluate((el) => {
        const cs = getComputedStyle(el);
        const keys = ['display', 'position', 'width', 'height', 'margin', 'padding', 'font-family', 'font-size', 'font-weight',
          'line-height', 'color', 'background-color', 'border', 'border-radius', 'overflow', 'white-space', 'text-overflow', 'opacity', 'z-index'];
        const o = {};
        for (const k of keys) o[k] = cs.getPropertyValue(k);
        o.scrollOverflow = { x: el.scrollWidth > el.clientWidth, y: el.scrollHeight > el.clientHeight };
        o.text = (el.innerText || '').trim().slice(0, 200);
        return o;
      });
      await first.screenshot({ path: path.join(out, 'element.png') }).catch(() => {});
    }
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(result, null, 2));
console.log('Captured ' + conditions.url + ' at ' + conditions.width + 'x' + conditions.height + ' @' + conditions.dpr + 'x ' + conditions.theme + ' → ' + out);
if (result.element) console.log('Element ' + (result.element.matches ? 'matched (' + result.element.matches + ')' : 'NOT found: the page may have changed since the thread started'));
