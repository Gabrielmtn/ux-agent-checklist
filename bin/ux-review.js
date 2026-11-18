#!/usr/bin/env node
'use strict';
// ux-review: one CLI for both sides of the review. Run with --help for the list.
//
//   Start:   ux-review up        (from a project the kit was copied into: does everything)
//   Agent:   ux-review inbox | wait | reply <id> <status> "text" | …

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let val = eq > 0 ? a.slice(eq + 1) : true;
    if (val === true && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && !BOOL.has(key)) val = argv[++i];
    if (key === 'checklist') (out.checklist = out.checklist || []).push(val);
    else out[key] = val;
  }
  return out;
}
const BOOL = new Set(['json', 'spa', 'help', 'no-open', 'no-skill']);

function loadConfig(args) {
  const file = path.resolve(args.config || path.join(ROOT, 'review.config.json'));
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('Could not parse ' + file + ': ' + e.message); }
  }
  const base = path.dirname(file);
  const merged = {
    target: cfg.target || null,
    static: cfg.static || null,
    spa: !!cfg.spa,
    port: Number(cfg.port) || 3997,
    host: cfg.host || '127.0.0.1',
    checklists: cfg.checklists && cfg.checklists.length ? cfg.checklists : ['checklists/default.json'],
    outDir: cfg.outDir || 'review',
    names: Object.assign({ reviewer: 'You', agent: 'Agent' }, cfg.names || {}),
    rootDir: base,
  };
  if (args.target) { merged.target = args.target; merged.static = null; }
  if (args.static) { merged.static = args.static; merged.target = null; }
  if (args.spa) merged.spa = true;
  if (args.port) merged.port = Number(args.port);
  if (args.host) merged.host = args.host;
  if (args.checklist) { merged.checklists = args.checklist; merged.rootDir = process.cwd(); }
  if (args.out) merged.outDir = path.resolve(args.out);
  merged.outDir = path.resolve(base, merged.outDir);
  if (merged.static) merged.static = path.resolve(args.static ? process.cwd() : base, merged.static);
  return merged;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function baseUrl(args, cfg) {
  const { findSite, readSession } = require('../server/up');
  const s = readSession(findSite(ROOT, args.site)) || readSession(process.cwd());
  return String(args.url || process.env.UX_REVIEW_URL || (s && s.url) || 'http://127.0.0.1:' + cfg.port).replace(/\/$/, '');
}

// ── serve ──
function serve(args) {
  const cfg = loadConfig(args);
  if (!cfg.target && !cfg.static) die('Nothing to review. Run `up` to detect and start your project automatically, or pass --target <dev server URL> / --static <folder> (or set them in review.config.json).');
  if (cfg.static && !fs.existsSync(cfg.static)) die('Static folder not found: ' + cfg.static);
  if (cfg.target) {
    try { new URL(cfg.target); } catch (_) { die('target is not a URL: ' + cfg.target); }
  }
  const { createServer } = require('../server');
  const server = createServer(cfg);
  server.on('error', (e) => die(e.code === 'EADDRINUSE' ? 'Port ' + cfg.port + ' is in use. Pass --port or change it in review.config.json.' : e.message));
  server.listen(cfg.port, cfg.host, () => {
    const url = 'http://' + (cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host) + ':' + cfg.port + '/';
    const rel = (p) => path.relative(process.cwd(), p) || '.';
    console.log('');
    console.log('  UX review kit');
    console.log('  Reviewing  ' + (cfg.target || rel(cfg.static) + (cfg.spa ? ' (SPA fallback)' : '')));
    console.log('  Open       ' + url);
    console.log('  Checklist  ' + cfg.checklists.join(', '));
    console.log('  Output     ' + rel(cfg.outDir) + path.sep + '{review.md, state.json, events.ndjson}');
    console.log('');
    console.log('  Agent side: the ux-walkthrough skill (npm run install-skill -- <site repo>)');
    console.log('              or by hand: npm run inbox · npm run wait · npm run reply -- <thread> fixed "text"');
    console.log('');
  });
}

// ── agent side: one client, the skill's own (.agents/skills/ux-walkthrough/scripts) ──
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'ux-walkthrough');

function agent(args) {
  const cfg = loadConfig(args);
  const { spawnSync } = require('child_process');
  const raw = process.argv.slice(2);
  const script = args._[0] === 'find-source' || args._[0] === 'capture' ? args._[0] + '.mjs' : 'review.mjs';
  const rest = script === 'review.mjs' ? raw : raw.slice(1);
  const r = spawnSync(process.execPath, [path.join(SKILL_DIR, 'scripts', script), ...rest], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { UX_REVIEW_URL: baseUrl(args, cfg) }),
  });
  process.exit(r.status == null ? 2 : r.status);
}

// Copy the skill into the site's repo, so an agent opened there discovers it:
// .agents/skills/ (the cross-agent convention) and .claude/skills/ (Claude Code).
function copySkill(root, to, opts) {
  const dests = [];
  if (to === 'agents' || to === 'both') dests.push(path.join(root, '.agents', 'skills', 'ux-walkthrough'));
  if (to === 'claude' || to === 'both') dests.push(path.join(root, '.claude', 'skills', 'ux-walkthrough'));
  if (!dests.length) die('--to must be agents, claude or both');
  for (const d of dests) {
    if (path.resolve(d) === path.resolve(SKILL_DIR)) continue; // reviewing the kit itself
    fs.rmSync(d, { recursive: true, force: true }); // this folder is the kit's own; re-running updates it
    fs.cpSync(SKILL_DIR, d, { recursive: true });
    if (!(opts && opts.quiet)) console.log('Installed ' + path.relative(process.cwd(), d));
  }
  return dests;
}

function installSkill(args) {
  const { findSite } = require('../server/up');
  const site = args._[1] || findSite(ROOT, args.site);
  if (!site) die('Usage: ux-review install-skill <site-repo> [--to agents|claude|both]');
  const root = path.resolve(site);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die('Not a folder: ' + root);
  copySkill(root, args.to || 'both');
  console.log('\nIn ' + root + ', ask your agent to run the ux-walkthrough skill.');
  console.log('Its scratch folder is .ux-review/ (it ignores itself; your .gitignore is untouched).');
}

// ── up / status / stop ──
function helpers() {
  return { kitDir: ROOT, loadConfig, die, createServer: require('../server').createServer, installSkill: copySkill };
}
const upCmd = (args) => require('../server/up').up(args, helpers());
const statusCmd = (args) => require('../server/up').status(args, helpers());
const stopCmd = (args) => require('../server/up').stop(args, helpers());

async function summary(args) {
  const cfg = loadConfig(args);
  try {
    const r = await fetch(baseUrl(args, cfg) + '/__review/api/summary');
    process.stdout.write(await r.text());
  } catch (_) {
    const fp = path.join(cfg.outDir, 'review.md');
    if (!fs.existsSync(fp)) die('No review yet.');
    process.stdout.write(fs.readFileSync(fp, 'utf8'));
  }
}

const HELP = `ux-review

Start (from a project the kit was copied into)
  up             Find the project, start its dev server if needed, start the review,
                 install the skill, open the browser. Prints READY <url>.
                   --site DIR     the project, if the kit isn't inside it
                   --target URL   review this running dev server instead of detecting one
                   --static DIR   review a folder of built files
                   --port N       first port to try for the review (default 3997)
                   --wait S       how long to wait for the dev server (default 120)
                   --no-open      don't open the browser
                   --no-skill     don't install the skill
  status         Is a review running? How many threads are waiting? (exit 2 if none)
  stop           Stop the review and any dev server up started

Reviewer side, by hand
  serve          Start only the review server: --target URL | --static DIR [--spa] [--port N]
                   --checklist F (repeatable) --out DIR --config F
  summary        Print the review as Markdown

Agent side (the ux-walkthrough skill's client; see .agents/skills/ux-walkthrough/binding.md)
  install-skill  install-skill [site-repo] [--to agents|claude|both]
  inbox          Threads waiting on the agent  (--json)
  wait           Block until something is waiting  (--timeout S)
  thread         thread <id>: one thread as JSON
  workdir        workdir <id>: create .ux-review/<id>/ in the current folder
  reply          reply <id> <working|fixed|question|wontfix|note> "text"
  find-source    find-source <id> [--root DIR]: rank source files for the thread's element
  capture        capture <id> [--out DIR]: screenshot at the reviewer's viewport (needs Playwright)
`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'serve';
if (args.help) { console.log(HELP); process.exit(0); }
const AGENT = ['inbox', 'wait', 'thread', 'workdir', 'reply', 'find-source', 'capture'];
const run = AGENT.includes(cmd) ? agent : { up: upCmd, status: statusCmd, stop: stopCmd, serve, summary, 'install-skill': installSkill }[cmd];
if (!run) die('Unknown command: ' + cmd + '\n\n' + HELP);
Promise.resolve(run(args)).catch((e) => die(e.stack || String(e)));
