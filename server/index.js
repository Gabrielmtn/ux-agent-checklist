'use strict';
// The review server. It sits in front of the site under review, either as a
// proxy for a running dev server (`target`) or by serving a static folder
// (`static`), and adds the review panel to every HTML page on the way out.
// The site's own files are never touched. Everything the kit adds lives under
// /__review/ so it can't collide with the site's routes.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { Store, HttpError, toMarkdown } = require('./store');

const PREFIX = '/__review';
const MAX_BODY = 1024 * 1024;
const PANEL_JS = path.join(__dirname, '..', 'client', 'panel.js');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.map': 'application/json; charset=utf-8',
};
const INJECT = '<script src="' + PREFIX + '/panel.js" data-review-ui defer></script>';

function injectPanel(html) {
  if (html.includes(PREFIX + '/panel.js')) return html;
  const i = html.search(/<\/body>/i);
  if (i >= 0) return html.slice(0, i) + INJECT + html.slice(i);
  const j = html.search(/<\/head>/i);
  if (j >= 0) return html.slice(0, j) + INJECT + html.slice(j);
  return html + INJECT;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), MIME['.json']);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body over 1 MB'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Browsers send Origin on cross-site POSTs. Only accept our own origin (the
// panel) or none at all (the CLI, curl, a coding agent). JSON content type is
// required too, so a plain HTML form on another site can't post here.
function checkWrite(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try { host = new URL(origin).host; } catch (_) { /* bad origin */ }
    if (host !== req.headers.host) throw new HttpError(403, 'cross-origin write refused');
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'send application/json');
}

function createServer(cfg) {
  const store = new Store({ outDir: cfg.outDir, checklistFiles: cfg.checklists, rootDir: cfg.rootDir });
  const sse = new Set();
  const waiters = new Set();

  store.onChange((rev) => {
    for (const res of sse) res.write('event: change\ndata: ' + JSON.stringify({ rev }) + '\n\n');
    for (const w of waiters) w(rev);
  });
  setInterval(() => { for (const res of sse) res.write(': ping\n\n'); }, 25000).unref();

  async function api(req, res, p, url) {
    const route = req.method + ' ' + p.slice((PREFIX + '/api').length);
    switch (route) {
      case 'GET /config':
        return json(res, 200, { names: cfg.names, target: cfg.target || null, static: cfg.static ? path.basename(cfg.static) : null });
      case 'GET /state':
        return json(res, 200, store.snapshot());
      case 'GET /summary':
        return send(res, 200, toMarkdown(store.snapshot()), 'text/markdown; charset=utf-8');
      case 'GET /events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('event: hello\ndata: ' + JSON.stringify({ rev: store.rev }) + '\n\n');
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }
      case 'GET /wait': {
        // Long poll for agents and the CLI: resolves on the next change after `rev`, or after `timeout` seconds.
        const since = Number(url.searchParams.get('rev') || -1);
        const timeout = Math.min(Number(url.searchParams.get('timeout') || 60), 600) * 1000;
        if (store.rev > since) return json(res, 200, { rev: store.rev, changed: true });
        let done = false;
        const finish = (changed) => {
          if (done) return;
          done = true;
          waiters.delete(waiter);
          clearTimeout(timer);
          json(res, 200, { rev: store.rev, changed });
        };
        const waiter = () => finish(true);
        const timer = setTimeout(() => finish(false), timeout);
        waiters.add(waiter);
        req.on('close', () => { done = true; waiters.delete(waiter); clearTimeout(timer); });
        return;
      }
      case 'POST /messages':
      case 'POST /checks':
      case 'POST /custom': {
        checkWrite(req);
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
          if (e instanceof HttpError) throw e;
          throw new HttpError(400, 'invalid JSON');
        }
        if (route === 'POST /messages') return json(res, 200, store.addMessage(body));
        if (route === 'POST /checks') return json(res, 200, store.setCheck(body));
        return json(res, 200, store.upsertCustom(body));
      }
      case 'GET /threads': {
        // The agent's view of the binding: one record per thread, newest state computed here
        // so every client (CLI, skill scripts, curl) agrees on what "waiting" means.
        const want = url.searchParams.get('status');
        const list = store.threadRecords().filter((t) => !want || want.split(',').includes(t.status));
        return json(res, 200, { rev: store.rev, threads: list });
      }
      default: {
        const m = /^GET \/threads\/([A-Za-z0-9_:.-]{1,120})$/.exec(route);
        if (m) {
          const t = store.threadRecords().find((x) => x.id === m[1] || x.messages.some((msg) => msg.id === m[1]));
          if (!t) throw new HttpError(404, 'no thread ' + m[1]);
          return json(res, 200, { rev: store.rev, thread: t });
        }
        throw new HttpError(404, 'no such endpoint: ' + route);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://local');
      const p = url.pathname;
      if (p === PREFIX + '/panel.js') {
        return send(res, 200, fs.readFileSync(PANEL_JS), MIME['.js']);
      }
      if (p.startsWith(PREFIX + '/api/')) return await api(req, res, p, url);
      if (p.startsWith(PREFIX + '/')) throw new HttpError(404, 'not found');
      if (cfg.static) return serveStatic(cfg, req, res, url);
      return proxy(cfg, req, res);
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) json(res, code, { error: e.message || String(e) });
      else res.end();
    }
  });

  server.on('upgrade', (req, socket, head) => proxyUpgrade(cfg, req, socket, head));
  server.store = store;
  return server;
}

// ── static mode ──
function serveStatic(cfg, req, res, url) {
  const root = cfg.static;
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (_) { throw new HttpError(400, 'bad path'); }
  let fp = path.resolve(root, '.' + rel);
  const inside = path.relative(root, fp);
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new HttpError(403, 'outside the served folder');
  // When the project root itself is served, keep dot folders (.git, .env, .ux-review) and the kit out of it.
  const segs = inside.split(path.sep);
  const hiddenDir = (cfg.hide || []).some((d) => { const r = path.relative(d, fp); return !r.startsWith('..') && !path.isAbsolute(r); });
  if (hiddenDir || segs.some((x) => x.startsWith('.') && x !== '.well-known')) throw new HttpError(404, 'not found');
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) {
    if (cfg.spa && !path.extname(rel)) fp = path.join(root, 'index.html');
    else {
      const nf = path.join(root, '404.html');
      if (fs.existsSync(nf)) return send(res, 404, injectPanel(fs.readFileSync(nf, 'utf8')), MIME['.html']);
      return send(res, 404, injectPanel('<!doctype html><title>Not found</title><h1>Not found</h1><p>' + escapeHtml(rel) + '</p>'), MIME['.html']);
    }
  }
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  if (type.startsWith('text/html')) return send(res, 200, injectPanel(fs.readFileSync(fp, 'utf8')), type);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
}

// ── proxy mode ──
const DROP_RESPONSE = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security'];

function proxy(cfg, req, res) {
  const t = new URL(cfg.target);
  const lib = t.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: t.host, 'accept-encoding': 'gzip, deflate, br' };
  if (headers.origin) headers.origin = t.origin;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, t.origin);
  const upstream = lib.request({
    protocol: t.protocol, hostname: t.hostname, port: t.port, method: req.method, path: req.url, headers,
    rejectUnauthorized: false, // local dev servers often use self-signed certs
  }, (up) => {
    const h = { ...up.headers };
    for (const k of DROP_RESPONSE) delete h[k];
    if (h.location) h.location = String(h.location).replace(t.origin, '');
    if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map((c) => c.replace(/;\s*secure/gi, '').replace(/;\s*domain=[^;]*/gi, ''));
    const isHtml = /text\/html/i.test(h['content-type'] || '') && req.method !== 'HEAD';
    if (!isHtml) {
      res.writeHead(up.statusCode, h);
      return up.pipe(res);
    }
    const enc = String(h['content-encoding'] || '').toLowerCase();
    const decoded = enc === 'gzip' ? up.pipe(zlib.createGunzip())
      : enc === 'deflate' ? up.pipe(zlib.createInflate())
      : enc === 'br' ? up.pipe(zlib.createBrotliDecompress())
      : up;
    const chunks = [];
    decoded.on('data', (d) => chunks.push(d));
    decoded.on('error', (e) => { if (!res.headersSent) send(res, 502, 'could not decode upstream HTML: ' + e.message); });
    decoded.on('end', () => {
      const body = injectPanel(Buffer.concat(chunks).toString('utf8'));
      delete h['content-encoding'];
      delete h['content-length'];
      delete h['transfer-encoding'];
      h['cache-control'] = 'no-store';
      res.writeHead(up.statusCode, h);
      res.end(body);
    });
  });
  upstream.on('error', (e) => {
    if (res.headersSent) return res.end();
    send(res, 502, injectPanel(
      '<!doctype html><meta charset="utf-8"><title>Site not reachable</title>' +
      '<body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
      '<h1>Can\'t reach ' + escapeHtml(cfg.target) + '</h1>' +
      '<p>Start your site\'s dev server, or change <code>target</code> in <code>review.config.json</code> ' +
      '(or pass <code>--target</code> / <code>--static</code>), then reload.</p><p><small>' + escapeHtml(e.code || e.message) + '</small></p>'
    ), MIME['.html']);
  });
  req.pipe(upstream);
}

// WebSockets (dev-server hot reload and the site's own sockets) pass straight through.
function proxyUpgrade(cfg, req, socket, head) {
  if (!cfg.target) return socket.destroy();
  const t = new URL(cfg.target);
  const secure = t.protocol === 'https:';
  const port = Number(t.port) || (secure ? 443 : 80);
  const up = secure
    ? tls.connect({ host: t.hostname, port, servername: t.hostname, rejectUnauthorized: false })
    : net.connect(port, t.hostname);
  up.on(secure ? 'secureConnect' : 'connect', () => {
    const lines = [req.method + ' ' + req.url + ' HTTP/1.1'];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      let v = req.rawHeaders[i + 1];
      if (/^host$/i.test(k)) v = t.host;
      if (/^origin$/i.test(k)) v = t.origin;
      lines.push(k + ': ' + v);
    }
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { createServer, injectPanel, PREFIX };
