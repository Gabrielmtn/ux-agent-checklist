'use strict';
// `up`: run from a project the kit was copied into. Builds throwaway projects with
// the kit inside them, the way people will actually use it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { detect, findSite } = require('../server/up');

const KIT = path.resolve(__dirname, '..');
const COPY = ['bin', 'server', 'client', 'checklists', '.agents', 'review.config.json', 'package.json', 'START.md'];

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-proj-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
function withKit(dir) {
  const kit = path.join(dir, 'ux-review');
  for (const f of COPY) fs.cpSync(path.join(KIT, f), path.join(kit, f), { recursive: true });
  return kit;
}
function freePort() {
  return new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Start `up` and resolve when it prints READY (or reject with its output).
function runUp(cwd, kit, args) {
  const child = spawn(process.execPath, [path.join(kit, 'bin', 'ux-review.js'), 'up', '--no-open', ...args], { cwd });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no READY in 30 s:\n' + out)), 30000);
    const on = (d) => {
      out += d;
      const m = /READY (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1].replace(/\/$/, '')); }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('up exited ' + code + ':\n' + out)); });
  });
  return { child, ready, output: () => out };
}
function runCli(cwd, kit, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(kit, 'bin', 'ux-review.js'), ...args], { cwd });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
}

test('detect: frameworks, ports from scripts, static sites, and missing installs', () => {
  const vite = project({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } } });
  assert.deepStrictEqual(
    (({ kind, command, port, framework, needsInstall }) => ({ kind, command, port, framework, needsInstall }))(detect(vite)),
    { kind: 'dev', command: 'npm run dev', port: 5173, framework: 'Vite', needsInstall: true });

  const next = project({ 'package.json': { scripts: { dev: 'next dev -p 4010' }, dependencies: { next: '15', react: '19' } }, 'pnpm-lock.yaml': '' });
  const n = detect(next);
  assert.strictEqual(n.framework, 'Next.js');
  assert.strictEqual(n.port, 4010);
  assert.strictEqual(n.command, 'pnpm run dev');

  const plain = project({ 'index.html': '<h1>hi</h1>' });
  assert.strictEqual(detect(plain).kind, 'static');

  const nothing = project({ 'package.json': { name: 'x' } });
  assert.strictEqual(detect(nothing).kind, 'unknown');
});

test('findSite: the folder the kit was copied into, or nothing for a standalone clone', () => {
  const dir = project({ 'package.json': { name: 'app' } });
  const kit = withKit(dir);
  assert.strictEqual(findSite(kit), dir);
  const lonely = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-alone-'));
  assert.strictEqual(findSite(path.join(lonely, 'ux-review')), null);
});

test('up starts the project\'s dev server, proxies it, installs the skill, and stop cleans up', async (t) => {
  const devPort = await freePort();
  const reviewPort = await freePort();
  // A stand-in dev server that, like Vite, prints its URL and serves HTML.
  const dir = project({
    'package.json': { scripts: { dev: 'node dev.js' } },
    'node_modules/.keep': '',
    'dev.js': `require('http').createServer((q, s) => { s.writeHead(200, {'Content-Type': 'text/html'}); s.end('<html><body><h1>My app</h1></body></html>'); })
      .listen(${devPort}, () => console.log('  ➜  Local:   http://localhost:${devPort}/'));`,
  });
  const kit = withKit(dir);
  const run = runUp(dir, kit, ['--port', String(reviewPort)]);
  t.after(() => { try { run.child.kill(); } catch (_) { /* gone */ } });
  const url = await run.ready;

  const html = await (await fetch(url + '/')).text();
  assert.match(html, /<h1>My app<\/h1><script src="\/__review\/panel\.js"/);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'ux-walkthrough', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir, '.agents', 'skills', 'ux-walkthrough', 'SKILL.md')));
  const session = JSON.parse(fs.readFileSync(path.join(dir, '.ux-review', 'session.json'), 'utf8'));
  assert.strictEqual(session.url, url);
  assert.ok(session.devPid, 'records the dev server it started');
  assert.match(fs.readFileSync(path.join(dir, '.ux-review', '.gitignore'), 'utf8'), /^\*$/m);

  // The installed skill finds the review through the session file, with no env var.
  const inbox = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(dir, '.agents', 'skills', 'ux-walkthrough', 'scripts', 'review.mjs'), 'inbox'],
      { cwd: dir, env: Object.assign({}, process.env, { UX_REVIEW_URL: '' }) });
    let o = '';
    c.stdout.on('data', (d) => { o += d; });
    c.on('exit', (code) => resolve({ code, o }));
  });
  assert.strictEqual(inbox.code, 0);
  assert.match(inbox.o, /Nothing waiting/);

  const st = await runCli(dir, kit, ['status']);
  assert.strictEqual(st.code, 0, st.out);
  assert.match(st.out, /Running at/);

  const sp = await runCli(dir, kit, ['stop']);
  assert.strictEqual(sp.code, 0, sp.out);
  await new Promise((r) => setTimeout(r, 1200));
  await assert.rejects(fetch('http://localhost:' + devPort + '/', { signal: AbortSignal.timeout(1500) }), 'the dev server up started is gone');
  assert.ok(!fs.existsSync(path.join(dir, '.ux-review', 'session.json')));
  assert.strictEqual((await runCli(dir, kit, ['status'])).code, 2);
});

test('up reuses a dev server that is already running and never stops it', async (t) => {
  const devPort = await freePort();
  const reviewPort = await freePort();
  const dev = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end('<body>already up</body>'); });
  await new Promise((r) => dev.listen(devPort, '127.0.0.1', r));
  t.after(() => dev.close());
  const dir = project({ 'package.json': { scripts: { dev: 'vite --port ' + devPort } }, 'node_modules/.keep': '' });
  const kit = withKit(dir);
  const run = runUp(dir, kit, ['--port', String(reviewPort)]);
  t.after(() => { try { run.child.kill(); } catch (_) { /* gone */ } });
  const url = await run.ready;
  assert.match(run.output(), /already running/);
  assert.match(await (await fetch(url + '/')).text(), /already up/);
  const session = JSON.parse(fs.readFileSync(path.join(dir, '.ux-review', 'session.json'), 'utf8'));
  assert.strictEqual(session.devPid, null);
  await runCli(dir, kit, ['stop']);
  await new Promise((r) => setTimeout(r, 500));
  assert.match(await (await fetch('http://127.0.0.1:' + devPort + '/')).text(), /already up/, 'their dev server is untouched');
});

test('up serves a plain HTML project directly, and explains a missing install', async (t) => {
  const reviewPort = await freePort();
  const dir = project({ 'index.html': '<html><body><p>plain</p></body></html>' });
  const kit = withKit(dir);
  const run = runUp(dir, kit, ['--port', String(reviewPort), '--no-skill']);
  t.after(() => { try { run.child.kill(); } catch (_) { /* gone */ } });
  const url = await run.ready;
  assert.match(await (await fetch(url + '/')).text(), /<p>plain<\/p><script src="\/__review\/panel\.js"/);
  assert.strictEqual((await fetch(url + '/.ux-review/session.json')).status, 404, 'dot folders are not served');
  assert.strictEqual((await fetch(url + '/ux-review/START.md')).status, 404, 'the kit folder is not served');
  run.child.kill();

  const bare = project({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '5' } } });
  const kit2 = withKit(bare);
  const r = await runCli(bare, kit2, ['up', '--no-open', '--port', String(await freePort())]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /No node_modules[\s\S]*npm install/);
});
