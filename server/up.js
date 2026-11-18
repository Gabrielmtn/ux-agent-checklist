'use strict';
// `ux-review up`: the one command a person (or their agent) runs to start a
// review. It works from inside the project the kit was copied into:
//
//   1. find the project (the folder that holds the kit, or --site)
//   2. find how it runs (framework, dev script, port) and whether it's already up
//   3. start the dev server if it isn't (its output goes to .ux-review/dev.log)
//   4. start the review server in front of it, on a free port
//   5. install the ux-walkthrough skill into the project
//   6. write .ux-review/session.json, so the agent's scripts find the review
//   7. open the browser, and print READY <url>
//
// Ctrl+C (or `ux-review stop`) stops the review server and any dev server it started.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Order matters: meta-frameworks before the bundler they're built on.
const FRAMEWORKS = [
  ['next', 3000, 'Next.js'],
  ['nuxt', 3000, 'Nuxt'],
  ['astro', 4321, 'Astro'],
  ['@sveltejs/kit', 5173, 'SvelteKit'],
  ['@remix-run/dev', 5173, 'Remix'],
  ['@react-router/dev', 5173, 'React Router'],
  ['@angular/cli', 4200, 'Angular'],
  ['gatsby', 8000, 'Gatsby'],
  ['react-scripts', 3000, 'Create React App'],
  ['@11ty/eleventy', 8080, 'Eleventy'],
  ['parcel', 1234, 'Parcel'],
  ['vite', 5173, 'Vite'],
  ['webpack-dev-server', 8080, 'webpack'],
];
const SCRIPTS = ['dev', 'start', 'serve', 'develop'];
const COMMON_PORTS = [5173, 3000, 4321, 8080, 4200, 8000, 5000, 1234, 3001, 5174];
const SESSION_DIR = '.ux-review';

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
}

// The project is the folder the kit was copied into. A kit cloned on its own has
// no project around it, and needs --site.
function findSite(kitDir, explicit) {
  if (explicit) return path.resolve(explicit);
  const parent = path.dirname(kitDir);
  const looksLikeProject = ['package.json', 'index.html', '.git'].some((f) => fs.existsSync(path.join(parent, f)));
  return looksLikeProject && parent !== kitDir ? parent : null;
}

function packageManager(siteRoot) {
  if (fs.existsSync(path.join(siteRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(siteRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(siteRoot, 'bun.lockb')) || fs.existsSync(path.join(siteRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

// How does this project run? → { kind: 'dev', script, command, pm, port, framework }
//                              | { kind: 'static', dir } | { kind: 'unknown', reason }
function detect(siteRoot) {
  const pkg = readJSON(path.join(siteRoot, 'package.json'));
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const fw = FRAMEWORKS.find(([dep]) => deps[dep]);
    const script = SCRIPTS.find((s) => pkg.scripts && pkg.scripts[s]);
    if (script) {
      const text = pkg.scripts[script];
      const m = /(?:--port[= ]|-p[= ]?|PORT=)(\d{2,5})\b/.exec(text);
      const pm = packageManager(siteRoot);
      return {
        kind: 'dev', script, pm, scriptText: text,
        command: pm + ' run ' + script,
        port: m ? Number(m[1]) : fw ? fw[1] : null,
        framework: fw ? fw[2] : null,
        needsInstall: !fs.existsSync(path.join(siteRoot, 'node_modules')),
      };
    }
  }
  for (const dir of ['.', 'public', 'dist', 'build', 'site', 'docs']) {
    if (fs.existsSync(path.join(siteRoot, dir, 'index.html'))) return { kind: 'static', dir: path.join(siteRoot, dir) };
  }
  return { kind: 'unknown', reason: pkg ? 'package.json has no dev, start or serve script' : 'no package.json and no index.html' };
}

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
    return true;
  } catch (_) {
    return false;
  }
}

// Try localhost first: dev servers often bind ::1 only, which 127.0.0.1 misses.
async function runningOn(port) {
  for (const host of ['localhost', '127.0.0.1']) {
    const url = 'http://' + host + ':' + port;
    if (await reachable(url + '/')) return url;
  }
  return null;
}

function freePort(start, host) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 50) return reject(new Error('no free port from ' + start));
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.listen(p, host, () => srv.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/;

// Start the project's dev server and resolve with its URL once it answers.
function startDev(siteRoot, det, logFile, timeoutMs) {
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  log.write('\n--- ' + new Date().toISOString() + ' ' + det.command + '\n');
  const child = spawn(det.command, {
    cwd: siteRoot,
    shell: true,
    detached: process.platform !== 'win32', // its own process group, so stop() can take the whole tree down
    env: Object.assign({}, process.env, { BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI || '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let seenPort = null;
  let tail = '';
  const onData = (d) => {
    const s = d.toString().replace(ANSI, '');
    log.write(s);
    tail = (tail + s).slice(-4000);
    const m = URL_IN_LOG.exec(s);
    if (m && !seenPort) seenPort = Number(m[1]);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    const tick = async () => {
      if (exited !== null) return reject(Object.assign(new Error('`' + det.command + '` exited with code ' + exited), { tail }));
      for (const p of [seenPort, det.port].filter(Boolean)) {
        const url = await runningOn(p);
        if (url) return resolve(url);
      }
      if (Date.now() > deadline) return reject(Object.assign(new Error('`' + det.command + '` did not answer within ' + Math.round(timeoutMs / 1000) + ' s'), { tail }));
      setTimeout(tick, 800);
    };
    setTimeout(tick, 500);
  });
  return { child, ready };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch (_) {
    try { process.kill(pid); } catch (__) { /* already gone */ }
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch (_) { /* no browser: the URL is printed */ }
}

// ── session file: how agents (and `status` / `stop`) find a running review ──
function sessionDir(siteRoot) {
  const dir = path.join(siteRoot, SESSION_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# UX walkthrough scratch space (session, logs, reports). Never committed.\n*\n');
  return dir;
}
function sessionFile(siteRoot) {
  return path.join(siteRoot, SESSION_DIR, 'session.json');
}
function readSession(siteRoot) {
  return siteRoot ? readJSON(sessionFile(siteRoot)) : null;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function up(args, h) {
  const say = (s) => console.log(s);
  const siteRoot = findSite(h.kitDir, args.site);
  const cfg = h.loadConfig(args);

  const prev = readSession(siteRoot);
  if (prev && alive(prev.pid) && (await reachable(prev.url + '/__review/api/config'))) {
    say('A review is already running for this project.');
    say('READY ' + prev.url + '/');
    return;
  }

  // What to review
  let target = args.target || null;
  let staticDir = args.static ? path.resolve(args.static) : null;
  let devChild = null;
  if (!target && !staticDir && !siteRoot) {
    h.die('Can\'t tell which project to review. Copy this folder into your project (e.g. my-app/ux-review/), or pass --site <project folder>, --target <dev server URL> or --static <folder>.');
  }
  const logDir = siteRoot ? sessionDir(siteRoot) : cfg.outDir;
  fs.mkdirSync(logDir, { recursive: true });

  if (!target && !staticDir) {
    const det = detect(siteRoot);
    say('• Project     ' + siteRoot);
    if (det.kind === 'static') {
      staticDir = det.dir;
      say('• Site        static files in ' + (path.relative(siteRoot, det.dir) || '.'));
    } else if (det.kind === 'unknown') {
      h.die('Couldn\'t work out how to run this project (' + det.reason + ').\nStart its dev server yourself, then run: up --target http://localhost:<port>');
    } else {
      say('• Site        ' + (det.framework || 'dev server') + ' · `' + det.command + '`' + (det.port ? ' · port ' + det.port : ''));
      target = det.port ? await runningOn(det.port) : null;
      if (!target && !det.port) {
        for (const p of COMMON_PORTS) { target = await runningOn(p); if (target) break; }
      }
      if (target) {
        say('• Dev server  already running at ' + target);
      } else {
        if (det.needsInstall) h.die('No node_modules in ' + siteRoot + '. Install the project first (' + det.pm + ' install), then run up again.');
        const logFile = path.join(logDir, 'dev.log');
        say('• Dev server  starting `' + det.command + '` (log: ' + path.relative(process.cwd(), logFile) + ')');
        const started = startDev(siteRoot, det, logFile, (Number(args.wait) || 120) * 1000);
        devChild = started.child;
        try {
          target = await started.ready;
        } catch (e) {
          killTree(devChild.pid);
          h.die(e.message + '.\nLast output:\n' + String(e.tail || '').trim().split('\n').slice(-15).join('\n') +
            '\n\nFix the dev server, or start it yourself and run: up --target http://localhost:<port>');
        }
        say('• Dev server  up at ' + target);
      }
    }
  }

  // The review server
  const port = await freePort(Number(args.port) || cfg.port, cfg.host);
  const serveCfg = Object.assign({}, cfg, { target: staticDir ? null : target, static: staticDir, port, hide: [h.kitDir] });
  const server = h.createServer(serveCfg);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, cfg.host, resolve); });
  const url = 'http://' + (cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host) + ':' + port;
  say('• Review      ' + url + '/   (reviewing ' + (target || path.relative(process.cwd(), staticDir) || '.') + ')');

  // The agent side
  if (siteRoot && args.skill !== 'false' && !args['no-skill']) {
    const where = h.installSkill(siteRoot, args.to || 'both', { quiet: true });
    say('• Skill       ux-walkthrough → ' + where.map((d) => path.relative(siteRoot, d)).join(', '));
  }

  const session = {
    url, target: target || null, static: staticDir || null, siteRoot, kitDir: h.kitDir,
    pid: process.pid, devPid: devChild ? devChild.pid : null, startedAt: new Date().toISOString(),
  };
  if (siteRoot) fs.writeFileSync(sessionFile(siteRoot), JSON.stringify(session, null, 2));

  const cleanup = () => {
    if (devChild) killTree(devChild.pid);
    try {
      const cur = readSession(siteRoot);
      if (cur && cur.pid === process.pid) fs.unlinkSync(sessionFile(siteRoot));
    } catch (_) { /* fine */ }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(0); });
  if (devChild) devChild.on('exit', (code) => {
    console.error('The dev server stopped (code ' + code + '). See .ux-review/dev.log. Stopping the review.');
    devChild = null;
    process.exit(1);
  });

  if (!args['no-open'] && args.open !== 'false') openBrowser(url + '/');
  say('');
  say('READY ' + url + '/');
  say('Open that address (not your dev server\'s) to see the review panel. Ctrl+C stops everything this started.');
}

async function status(args, h) {
  const siteRoot = findSite(h.kitDir, args.site) || process.cwd();
  const s = readSession(siteRoot);
  if (!s || !alive(s.pid)) { console.log('No review running for ' + siteRoot + '. Start one with: up'); process.exit(2); }
  try {
    const r = await fetch(s.url + '/__review/api/threads?status=needs-agent', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    console.log('Running at ' + s.url + '/ (reviewing ' + (s.target || s.static) + '), ' + j.threads.length + ' thread(s) waiting on the agent.');
  } catch (_) {
    console.log('A review process exists (pid ' + s.pid + ') but ' + s.url + ' does not answer.');
    process.exit(2);
  }
}

function stop(args, h) {
  const siteRoot = findSite(h.kitDir, args.site) || process.cwd();
  const s = readSession(siteRoot);
  if (!s) { console.log('No review running.'); return; }
  if (s.devPid) killTree(s.devPid);
  if (alive(s.pid)) killTree(s.pid);
  try { fs.unlinkSync(sessionFile(siteRoot)); } catch (_) { /* fine */ }
  console.log('Stopped the review' + (s.devPid ? ' and the dev server it started' : '') + '.');
}

module.exports = { up, status, stop, detect, findSite, readSession, FRAMEWORKS };
