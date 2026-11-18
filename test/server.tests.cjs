'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { createServer } = require('../server');

const ROOT = path.resolve(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function start(extra) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-srv-'));
  const server = createServer(Object.assign({
    static: path.join(ROOT, 'example-site'), outDir, rootDir: ROOT,
    checklists: ['checklists/default.json'], names: { reviewer: 'You', agent: 'Agent' },
  }, extra));
  const port = await listen(server);
  return { server, base: 'http://127.0.0.1:' + port, port };
}

test('static mode injects the panel into HTML only', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<script src="\/__review\/panel\.js" data-review-ui defer><\/script><\/body>/i);
  const css = await (await fetch(base + '/style.css')).text();
  assert.doesNotMatch(css, /__review/);
  const js = await fetch(base + '/__review/panel.js');
  assert.strictEqual(js.status, 200);
});

test('static mode refuses paths outside the folder', async (t) => {
  const { server, port } = await start();
  t.after(() => server.close());
  // fetch() normalises "..", so send the raw path.
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/..%2fpackage.json' }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.strictEqual(status, 403);
});

test('writes need JSON, a same-origin (or absent) Origin, and a body under 1 MB', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const post = (body, headers) => fetch(base + '/__review/api/messages', { method: 'POST', headers, body });
  const ok = await post(JSON.stringify({ from: 'reviewer', text: 'hi' }), { 'Content-Type': 'application/json' });
  assert.strictEqual(ok.status, 200);
  const form = await post('from=reviewer&text=hi', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(form.status, 415);
  const cross = await post(JSON.stringify({ from: 'reviewer', text: 'hi' }), { 'Content-Type': 'application/json', Origin: 'https://evil.example' });
  assert.strictEqual(cross.status, 403);
  const big = await post(JSON.stringify({ from: 'reviewer', text: 'x'.repeat(1.2 * 1024 * 1024) }), { 'Content-Type': 'application/json' }).catch(() => ({ status: 413 }));
  assert.strictEqual(big.status, 413);
});

test('agent loop over HTTP: reviewer asks, wait wakes, agent replies on the thread', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const rev = (await (await fetch(base + '/__review/api/state')).json()).rev;
  const waiting = fetch(base + '/__review/api/wait?rev=' + rev + '&timeout=5').then((r) => r.json());
  await fetch(base + '/__review/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'm1', from: 'reviewer', text: 'Make the button bigger' }) });
  assert.strictEqual((await waiting).changed, true);
  const r = await fetch(base + '/__review/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'agent', replyTo: 'm1', text: 'Done', status: 'fixed' }) });
  const reply = await r.json();
  assert.strictEqual(reply.replyTo, 'm1');
  assert.strictEqual(reply.status, 'fixed');
  const md = await (await fetch(base + '/__review/api/summary')).text();
  assert.match(md, /Fixed, needs recheck/);
});

test('proxy mode injects into compressed HTML and strips CSP', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip', 'Content-Security-Policy': "script-src 'none'" });
      return res.end(zlib.gzipSync('<html><body><h1>Hi</h1></body></html>'));
    }
    res.writeHead(302, { Location: 'http://127.0.0.1:' + upstream.address().port + '/' });
    res.end();
  });
  const upPort = await listen(upstream);
  const { server, base } = await start({ static: null, target: 'http://127.0.0.1:' + upPort });
  t.after(() => { server.close(); upstream.close(); });
  const r = await fetch(base + '/');
  assert.strictEqual(r.headers.get('content-security-policy'), null);
  assert.match(await r.text(), /<h1>Hi<\/h1><script src="\/__review\/panel\.js"/);
  const redirect = await fetch(base + '/old', { redirect: 'manual' });
  assert.strictEqual(redirect.headers.get('location'), '/');
});
