#!/usr/bin/env node
// Rank the site's source files by how much of a thread's element they mention.
//
//   find-source.mjs <thread-id> [--root .] [--limit 15] [--json]
//
// The rendered element gives away an id, test id, class names, its label
// text and the page route. Files that contain more of those rank higher. These
// are leads for the locate step, not answers: generated class names and
// translated labels won't match the source (see ../locate.md).
import fs from 'node:fs';
import path from 'node:path';
import { fail, getThread, parseArgs } from './lib.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.astro', '.output',
  'coverage', '.cache', '.turbo', '.vercel', '.netlify', 'vendor', 'target', '.ux-review', '.agents', '.claude']);
const EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.css', '.scss',
  '.sass', '.less', '.styl', '.md', '.mdx', '.json', '.yml', '.yaml', '.liquid', '.hbs', '.njk', '.ejs', '.erb', '.php', '.twig',
  '.py', '.rb', '.go', '.cshtml', '.razor']);
const MAX_FILE = 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const thread = await getThread(args._[0]);
const root = path.resolve(args.root || '.');
const limit = Number(args.limit) || 15;
if (!fs.existsSync(root)) fail(1, 'No such folder: ' + root);

// ── what the element gives away ──
const ctx = thread.context || {};
const el = ctx.element || {};
const terms = []; // { kind, value, weight }
const add = (kind, value, weight) => {
  value = String(value || '').trim();
  if (value.length >= 2 && !terms.some((t) => t.kind === kind && t.value === value)) terms.push({ kind, value, weight });
};
const sel = el.selector || '';
for (const m of sel.matchAll(/#((?:\\.|[\w-])+)/g)) add('id', m[1].replace(/\\(.)/g, '$1'), 5);
for (const m of sel.matchAll(/\[data-(?:testid|test|cy)="([^"]+)"\]/g)) add('test id', m[1], 5);
for (const m of sel.matchAll(/\.((?:\\.|[\w-])+)/g)) {
  const c = m[1].replace(/\\(.)/g, '$1');
  if (!/^(is-|has-)|\d{3,}|^[a-z]{1,2}\d|__[a-z0-9]{5,}$/i.test(c)) add('class', c, 2);
}
const label = String(el.label || '').trim();
if (label.length >= 3) {
  add('label', label, 4);
  // Long labels are often split across lines or interpolated; also try the first few words.
  const words = label.split(/\s+/);
  if (words.length > 4) add('label start', words.slice(0, 4).join(' '), 2);
}
const route = String(ctx.url || '').split(/[?#]/)[0];
for (const seg of route.split('/').filter((s) => s && !/^\d+$/.test(s))) add('route', seg.replace(/\.html?$/, ''), 1);
if (thread.check && !terms.length) for (const w of String(thread.check.text || '').match(/\b[a-z]{6,}\b/gi) || []) add('checklist word', w, 1);
if (!terms.length) fail(1, 'Thread ' + thread.id + ' has no element or route to search for. Read the thread and search by hand.');

// ── walk and score ──
const results = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(fp); continue; }
    if (!EXTS.has(path.extname(e.name).toLowerCase())) continue;
    let text;
    try { if (fs.statSync(fp).size > MAX_FILE) continue; text = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    let score = 0;
    const lines = text.split(/\r?\n/);
    const rel = path.relative(root, fp).replace(/\\/g, '/');
    const byLine = new Map(); // line number -> kinds that matched there (each line shown once)
    let pathHit = false;
    for (const t of terms) {
      if (t.kind === 'route') {
        if (rel.toLowerCase().includes(t.value.toLowerCase())) { score += 2; pathHit = true; }
        continue; // a route segment in file contents is mostly noise (nav links)
      }
      const test = matcher(t);
      if (!test(text)) continue;
      score += t.weight;
      let shown = 0;
      for (let i = 0; i < lines.length && shown < 3; i++) {
        if (!test(lines[i])) continue;
        if (!byLine.has(i + 1)) byLine.set(i + 1, new Set());
        byLine.get(i + 1).add(t.kind);
        shown++;
      }
    }
    const hits = [...byLine].sort((x, y) => y[1].size - x[1].size || x[0] - y[0])
      .map(([line, kinds]) => ({ line, kinds: [...kinds], text: lines[line - 1].trim().slice(0, 160) }));
    if (pathHit) hits.unshift({ line: 0, kinds: ['route'], text: '(file path matches the page route)' });
    if (score) results.push({ file: rel, score, hits });
  }
})(root);

function matcher(t) {
  const esc = t.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (t.kind === 'class' || t.kind === 'id' || t.kind === 'test id') {
    const re = new RegExp('(^|[^\\w-])' + esc + '($|[^\\w-])'); // whole name: "plan" must not match "plans"
    return (s) => re.test(s);
  }
  const needle = t.value.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
const top = results.slice(0, limit);

if (args.json) {
  console.log(JSON.stringify({ thread: thread.id, root, terms, results: top }, null, 2));
} else {
  console.log('Searching ' + root + ' for: ' + terms.map((t) => t.kind + ' "' + t.value + '"').join(', '));
  console.log('');
  if (!top.length) console.log('No matches. The names are probably generated or the text comes from data; search by component or route instead.');
  for (const r of top) {
    console.log(String(r.score).padStart(3) + '  ' + r.file);
    for (const h of r.hits.slice(0, 6)) console.log('       ' + (h.line ? (':' + h.line).padEnd(6) : '      ') + ' [' + h.kinds.join(', ') + '] ' + h.text);
  }
}
