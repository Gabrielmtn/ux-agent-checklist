// Shared helpers for the ux-walkthrough scripts. Zero dependencies (Node 18+).
// Exit codes: 0 done, 1 bad input or refused, 2 infrastructure.
import fs from 'node:fs';
import path from 'node:path';

// Where the review runs: $UX_REVIEW_URL, else the session `ux-review up` wrote
// (.ux-review/session.json in this folder or a parent), else the default port.
function sessionUrl() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, '.ux-review', 'session.json'), 'utf8'));
      if (s && s.url) return s.url;
    } catch (_) { /* keep looking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
export const BASE = String(process.env.UX_REVIEW_URL || sessionUrl() || 'http://127.0.0.1:3997').replace(/\/$/, '');

export function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) out[key] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !['json'].includes(key)) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

export async function api(p, opts) {
  let r;
  try {
    r = await fetch(BASE + '/__review/api' + p, opts);
  } catch (e) {
    fail(2, 'Review server not reachable at ' + BASE + ' (' + (e.cause && e.cause.code || e.message) + '). Start it with `node <kit folder>/bin/ux-review.js up` from the project (see the kit\'s START.md), or set UX_REVIEW_URL.');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) fail(1, (body.error || 'HTTP ' + r.status) + ' (' + p + ')');
  return body;
}

export async function getThread(id) {
  if (!id) fail(1, 'Give a thread id.');
  return (await api('/threads/' + encodeURIComponent(id))).thread;
}

// .ux-review/ in the site repo: scratch space that ignores itself, so nothing
// in it is ever committed and the site's own .gitignore stays untouched.
export function workDir(id, root) {
  const base = path.resolve(root || process.env.UX_REVIEW_WORK || '.ux-review');
  fs.mkdirSync(base, { recursive: true });
  const gi = path.join(base, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# UX walkthrough scratch space (reports, captures). Never committed.\n*\n');
  const dir = path.join(base, String(id).replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function whereLine(ctx = {}) {
  const bits = [];
  if (ctx.url) bits.push(ctx.url);
  if (ctx.element && ctx.element.selector) bits.push('element "' + (ctx.element.label || ctx.element.tag || '') + '" ' + ctx.element.selector);
  if (ctx.viewport) bits.push(ctx.viewport + (ctx.dpr ? ' @' + ctx.dpr + 'x' : '') + (ctx.theme ? ' ' + ctx.theme : ''));
  return bits.join(' · ');
}
