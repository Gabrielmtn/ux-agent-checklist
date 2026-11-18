// UX review panel. Injected into every HTML page by the review server (it never
// ships with the site). Two tabs: Chat, a thread-per-request conversation with
// the coding agent, and Checklist, an editable list of things to verify.
//
// Everything renders inside a shadow root, so the site's CSS can't reach the
// panel and the panel's CSS can't reach the site. Writes go through a
// localStorage queue, so nothing is lost while the server is down.
(function () {
  'use strict';
  if (window.top !== window || window.uxReview) return; // once per tab, never in iframes

  const API = '/__review/api';
  const LS = 'uxReview.';
  const DOC = document;

  // ── storage helpers ──
  function lsGet(k, fallback) {
    try { const v = localStorage.getItem(LS + k); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (_) { /* storage blocked: keep going in memory */ }
  }
  function uid(p) {
    return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function nowIso() { return new Date().toISOString(); }

  const ICON = {
    swap: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 7h11l-3-3M16 13H5l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10z" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    copy: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 4.5V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    min: '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 10h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  // ── state ──
  const ui = Object.assign({ open: true, tab: 'chat', side: 'right', width: 380, filter: 'all', collapsed: {}, lastSeen: '' }, lsGet('ui', {}));
  let queue = lsGet('queue', []);
  let server = null;
  let cfg = { names: { reviewer: 'You', agent: 'Agent' } };
  let online = null;
  let attach = null; // { selector, label, tag }
  let replyTo = null; // { id, ack }
  const noteDrafts = lsGet('notes', {});
  const addingTo = {}; // section id -> true while its "add item" field is open
  function saveUi() { lsSet('ui', ui); }

  // ── DOM helper ──
  function h(tag, attrs) {
    const el = DOC.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style') el.style.cssText = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach((x) => x != null && x !== false && el.append(x));
      else el.append(c);
    }
    return el;
  }

  // ── host + shadow root ──
  const host = h('div', { id: 'ux-review-host', 'data-review-ui': '' });
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  ['keydown', 'keyup', 'keypress', 'input'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));

  shadow.append(h('style', { text: STYLES() }));
  const hl = h('div', { class: 'hl', hidden: true }, h('span', { class: 'hl-label' }));
  const toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  const panel = h('aside', { class: 'panel', role: 'complementary', 'aria-label': 'UX review' });
  const pill = h('button', { class: 'pill', type: 'button', 'aria-label': 'Open UX review', onclick: () => setOpen(true) });
  // The panel, pill and toast live in a box pinned to the *visual* viewport, so
  // they stay on screen when a page overflows sideways (common on phones: the
  // layout viewport grows and plain position:fixed ends up off screen) or the
  // reviewer pinch-zooms. The highlight stays in layout-viewport coordinates.
  const vvBox = h('div', { class: 'vv' }, panel, pill, toast);
  shadow.append(hl, vvBox);
  function fitViewport() {
    const vv = window.visualViewport;
    const s = vv ? vv.scale || 1 : 1;
    const w = vv ? vv.width * s : window.innerWidth;
    const hgt = vv ? vv.height * s : window.innerHeight;
    vvBox.style.left = (vv ? vv.offsetLeft : 0) + 'px';
    vvBox.style.top = (vv ? vv.offsetTop : 0) + 'px';
    vvBox.style.width = w + 'px';
    vvBox.style.height = hgt + 'px';
    vvBox.style.transform = s !== 1 ? 'scale(' + 1 / s + ')' : '';
    vvBox.classList.toggle('narrow', w < 720);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);

  // header
  const statusDot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const statusText = h('span', { class: 'status-text' });
  const tabChat = h('button', { class: 'tab', type: 'button', role: 'tab', onclick: () => setTab('chat') });
  const tabList = h('button', { class: 'tab', type: 'button', role: 'tab', onclick: () => setTab('checklist') });
  const resize = h('div', { class: 'resize', 'aria-hidden': 'true' });
  panel.append(
    resize,
    h('header', { class: 'head' },
      h('strong', { class: 'title', text: 'UX review' }),
      h('span', { class: 'status' }, statusDot, statusText),
      h('span', { class: 'grow' }),
      iconBtn('Move to the other side', ICON.swap, () => { ui.side = ui.side === 'right' ? 'left' : 'right'; saveUi(); layout(); }),
      iconBtn('Hide for 5 seconds', ICON.eye, () => peek(5000)),
      iconBtn('Copy summary (review.md)', ICON.copy, copySummary),
      iconBtn('Minimise (Alt+Shift+R)', ICON.min, () => setOpen(false))
    ),
    h('div', { class: 'tabs', role: 'tablist' }, tabChat, tabList)
  );

  // chat tab
  const threadsEl = h('div', { class: 'threads', role: 'log', 'aria-label': 'Conversation with the agent' });
  const chips = h('div', { class: 'chips' });
  const input = h('textarea', { class: 'input', rows: '3', placeholder: 'Tell the agent what to change…', 'aria-label': 'Message to the agent' });
  input.value = lsGet('draft', '');
  const pickBtn = h('button', { class: 'btn', type: 'button', onclick: () => (picking ? stopPick() : startPick()) });
  const sendBtn = h('button', { class: 'btn primary', type: 'button', text: 'Send', onclick: sendMessage });
  const chatPane = h('section', { class: 'pane chat', role: 'tabpanel', 'aria-label': 'Chat' },
    threadsEl,
    h('div', { class: 'composer' }, chips, input, h('div', { class: 'row' }, pickBtn, h('span', { class: 'hint', text: 'Enter to send · Shift+Enter for a new line' }), sendBtn))
  );
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
    if (e.key === 'Escape' && replyTo) { replyTo = null; renderChips(); }
  });
  input.addEventListener('input', () => lsSet('draft', input.value));

  // checklist tab
  const listHead = h('div', { class: 'list-head' });
  const listEl = h('div', { class: 'list' });
  const listPane = h('section', { class: 'pane checklist', role: 'tabpanel', 'aria-label': 'Checklist' }, listHead, listEl);
  panel.append(chatPane, listPane);

  function iconBtn(label, icon, onclick) {
    const b = h('button', { class: 'icon', type: 'button', title: label, 'aria-label': label, onclick });
    b.innerHTML = icon;
    return b;
  }

  // ── layout, tabs, open/close ──
  function layout() {
    panel.dataset.side = ui.side;
    pill.dataset.side = ui.side;
    panel.style.setProperty('--w', Math.max(300, Math.min(680, ui.width)) + 'px');
    panel.hidden = !ui.open;
    pill.hidden = ui.open;
    tabChat.setAttribute('aria-selected', String(ui.tab === 'chat'));
    tabList.setAttribute('aria-selected', String(ui.tab === 'checklist'));
    chatPane.hidden = ui.tab !== 'chat';
    listPane.hidden = ui.tab !== 'checklist';
  }
  function setOpen(v) {
    ui.open = v;
    saveUi();
    layout();
    renderBadges();
    if (v) (ui.tab === 'chat' ? input : tabList).focus();
    else pill.focus();
  }
  function setTab(t) {
    ui.tab = t;
    saveUi();
    layout();
    renderBadges();
    if (t === 'chat') threadsEl.scrollTop = threadsEl.scrollHeight;
  }
  function peek(ms) {
    host.style.visibility = 'hidden';
    setTimeout(() => { host.style.visibility = ''; }, ms);
  }
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'R' || e.key === 'r' || e.code === 'KeyR')) { e.preventDefault(); setOpen(!ui.open); }
  });

  // drag the inner edge to resize
  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const box = vvBox.getBoundingClientRect();
      ui.width = ui.side === 'right' ? box.right - ev.clientX - 12 : ev.clientX - box.left - 12;
      layout();
    };
    const up = () => { resize.removeEventListener('pointermove', move); saveUi(); };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', up, { once: true });
  });

  function say(msg, bad) {
    toast.textContent = msg;
    toast.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(say.t);
    say.t = setTimeout(() => { toast.className = 'toast'; }, 3200);
  }

  // ── server sync ──
  const emptySnap = { rev: 0, messages: [], checks: {}, custom: { sections: [], items: [] }, checklist: { title: 'Checklist', sections: [] } };

  function view() {
    const s = JSON.parse(JSON.stringify(server || lsGet('lastSnap', emptySnap)));
    for (const op of queue) applyOp(s, op);
    return s;
  }
  function applyOp(s, op) {
    const b = op.body;
    if (op.kind === 'messages') {
      if (!s.messages.some((m) => m.id === b.id)) {
        const m = Object.assign({ pending: true }, b);
        if (m.replyTo) {
          const p = s.messages.find((x) => x.id === m.replyTo);
          if (p && p.replyTo) m.replyTo = p.replyTo;
        }
        s.messages.push(m);
      }
    } else if (op.kind === 'checks') {
      const prev = s.checks[b.id];
      if (!prev || prev.updatedAt <= b.updatedAt) s.checks[b.id] = { status: b.status, note: b.note, updatedAt: b.updatedAt, page: b.page };
    } else if (op.kind === 'custom') {
      if (b.kind === 'section') {
        if (b.deleted) s.checklist.sections = s.checklist.sections.filter((x) => x.id !== b.id);
        else if (!s.checklist.sections.some((x) => x.id === b.id)) s.checklist.sections.push({ id: b.id, title: b.title, custom: true, items: [] });
      } else {
        for (const sec of s.checklist.sections) sec.items = sec.items.filter((x) => x.id !== b.id);
        if (!b.deleted) {
          const sec = s.checklist.sections.find((x) => x.id === b.section) || s.checklist.sections[s.checklist.sections.length - 1];
          if (sec) sec.items.push({ id: b.id, text: b.text, custom: true });
        }
      }
    }
  }

  function enqueue(kind, body) {
    queue.push({ kind, body });
    lsSet('queue', queue);
    render();
    flush();
  }

  let flushing = false;
  let retryTimer = 0;
  async function flush() {
    if (flushing) return;
    flushing = true;
    clearTimeout(retryTimer);
    try {
      while (queue.length) {
        const op = queue[0];
        const r = await fetch(API + '/' + op.kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op.body) });
        if (r.status >= 500) throw new Error('server error ' + r.status);
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          say('Not saved: ' + (err.error || r.status), true);
        }
        queue.shift();
        lsSet('queue', queue);
      }
      setOnline(true);
    } catch (_) {
      setOnline(false);
      retryTimer = setTimeout(flush, 4000);
    } finally {
      flushing = false;
    }
    await refresh();
  }

  async function refresh() {
    try {
      const r = await fetch(API + '/state', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      server = await r.json();
      lsSet('lastSnap', server);
      setOnline(true);
    } catch (_) {
      setOnline(false);
    }
    render();
  }

  function setOnline(v) {
    if (online === v) return renderStatus();
    online = v;
    renderStatus();
    if (v && queue.length) flush();
  }

  function connect() {
    fetch(API + '/config').then((r) => r.json()).then((c) => { cfg = c; render(); }).catch(() => {});
    if (!window.EventSource) { setInterval(refresh, 4000); return refresh(); }
    const es = new EventSource(API + '/events');
    es.addEventListener('hello', () => { setOnline(true); refresh(); flush(); });
    es.addEventListener('change', () => refresh());
    es.onerror = () => setOnline(false);
    refresh();
  }

  // ── page context ──
  function context(withElement) {
    const c = {
      url: location.pathname + location.search + location.hash,
      title: DOC.title,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    };
    if (withElement && attach) c.element = { selector: attach.selector, label: attach.label, tag: attach.tag };
    return c;
  }

  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function labelOf(el) {
    const a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'));
    if (a) return clean(a).slice(0, 60);
    const by = el.getAttribute && el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => DOC.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(' ');
      if (clean(t)) return clean(t).slice(0, 60);
    }
    if (el.id) {
      const lab = DOC.querySelector('label[for="' + window.CSS.escape(el.id) + '"]');
      if (lab && clean(lab.textContent)) return clean(lab.textContent).slice(0, 60);
    }
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt.slice(0, 60);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  }
  // A selector the agent can paste into querySelector: a unique id or test id
  // where there is one, otherwise the path down from the nearest such ancestor.
  function selectorOf(el) {
    const esc = window.CSS.escape;
    const unique = (sel) => { try { return DOC.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== DOC.documentElement; n = n.parentElement) {
      if (n.id && unique('#' + esc(n.id))) { parts.unshift('#' + esc(n.id)); break; }
      for (const attr of ['data-testid', 'data-test', 'data-cy']) {
        const v = n.getAttribute(attr);
        if (v && unique('[' + attr + '="' + v.replace(/"/g, '\\"') + '"]')) { parts.unshift('[' + attr + '="' + v.replace(/"/g, '\\"') + '"]'); return parts.join(' > '); }
      }
      if (n === DOC.body) { parts.unshift('body'); break; }
      let part = n.tagName.toLowerCase();
      const cls = Array.from(n.classList).filter((c) => !/^(is-|has-|active$|open$|show$|hover|focus|selected$)/.test(c) && !/\d{3,}|__[a-z0-9]{5,}$/i.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map(esc).join('.');
      const p = n.parentElement;
      if (p) {
        const same = Array.from(p.children).filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  }
  function isReviewElement(el) {
    return !!el && (el === host || (el.getRootNode && el.getRootNode() === shadow) || host.contains(el));
  }

  // ── highlight (picker, hover on an element chip) ──
  let hlTarget = null;
  let hlRaf = 0;
  function showHighlight(el, label) {
    hlTarget = el;
    hl.hidden = !el;
    hl.firstChild.textContent = label || '';
    cancelAnimationFrame(hlRaf);
    const tick = () => {
      if (!hlTarget || !hlTarget.isConnected) { hl.hidden = true; return; }
      const r = hlTarget.getBoundingClientRect();
      hl.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
      hl.style.width = r.width + 'px';
      hl.style.height = r.height + 'px';
      hl.classList.toggle('below', r.top < 24);
      hlRaf = requestAnimationFrame(tick);
    };
    if (el) tick();
  }
  function findEl(selector) {
    try { return DOC.querySelector(selector); } catch (_) { return null; }
  }

  // ── element picker ──
  let picking = false;
  const swallow = (e) => { if (!isReviewElement(e.target)) { e.preventDefault(); e.stopPropagation(); } };
  function onPickMove(e) {
    if (isReviewElement(e.target)) return;
    showHighlight(e.target, labelOf(e.target));
  }
  function onPickClick(e) {
    if (isReviewElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    attach = { selector: selectorOf(el), label: labelOf(el), tag: el.tagName.toLowerCase() };
    stopPick();
    setTab('chat');
    renderChips();
    input.focus();
  }
  function onPickKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); stopPick(); }
  }
  function startPick() {
    picking = true;
    DOC.addEventListener('mousemove', onPickMove, true);
    DOC.addEventListener('click', onPickClick, true);
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'].forEach((t) => DOC.addEventListener(t, swallow, true));
    window.addEventListener('keydown', onPickKey, true);
    DOC.documentElement.style.cursor = 'crosshair';
    renderPickBtn();
    say('Click anything on the page. Esc cancels.');
  }
  function stopPick() {
    picking = false;
    DOC.removeEventListener('mousemove', onPickMove, true);
    DOC.removeEventListener('click', onPickClick, true);
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'].forEach((t) => DOC.removeEventListener(t, swallow, true));
    window.removeEventListener('keydown', onPickKey, true);
    DOC.documentElement.style.cursor = '';
    showHighlight(null);
    renderPickBtn();
  }
  function renderPickBtn() {
    pickBtn.textContent = picking ? 'Cancel picking' : (attach ? 'Re-pick element' : 'Pick element');
    pickBtn.setAttribute('aria-pressed', String(picking));
  }

  // ── chat ──
  function sendMessage() {
    const text = input.value.trim();
    if (!text && !(replyTo && replyTo.ack)) { input.focus(); return; }
    const body = { id: uid('m'), from: 'reviewer', text, at: nowIso(), context: context(true) };
    if (replyTo) { body.replyTo = replyTo.id; if (replyTo.ack) body.ack = replyTo.ack; }
    enqueue('messages', body);
    input.value = '';
    lsSet('draft', '');
    attach = null;
    replyTo = null;
    renderChips();
    renderPickBtn();
    requestAnimationFrame(() => { threadsEl.scrollTop = threadsEl.scrollHeight; });
  }

  function threads(messages) {
    const roots = [];
    const by = new Map();
    for (const m of messages) if (!m.replyTo) { const t = { root: m, replies: [] }; roots.push(t); by.set(m.id, t); }
    for (const m of messages) if (m.replyTo && by.has(m.replyTo)) by.get(m.replyTo).replies.push(m);
    for (const t of roots) {
      const last = t.replies.length ? t.replies[t.replies.length - 1] : t.root;
      t.last = last;
      t.status = last.from === 'reviewer' ? (last.ack === 'good' ? 'resolved' : 'needs-agent')
        : ({ working: 'working', fixed: 'recheck', question: 'question' })[last.status] || 'resolved';
    }
    return roots;
  }
  const STATUS = {
    'needs-agent': ['Waiting for agent', 'wait'],
    working: ['Agent working', 'work'],
    recheck: ['Fixed: please recheck', 'fixed'],
    question: ['Agent has a question', 'ask'],
    resolved: ['Resolved', 'done'],
  };
  const AGENT_LABEL = { working: 'working on it', fixed: 'fixed', question: 'question', wontfix: "won't fix", note: '' };

  function time(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function elementChip(el) {
    return h('button', {
      class: 'chip el', type: 'button', title: el.selector,
      onmouseenter: () => { const t = findEl(el.selector); if (t) showHighlight(t, el.label); },
      onmouseleave: () => { if (!picking) showHighlight(null); },
      onfocus: () => { const t = findEl(el.selector); if (t) showHighlight(t, el.label); },
      onblur: () => { if (!picking) showHighlight(null); },
      onclick: () => {
        const t = findEl(el.selector);
        if (!t) return say('That element is not on this page right now.', true);
        t.scrollIntoView({ block: 'center', behavior: 'smooth' });
        showHighlight(t, el.label);
        setTimeout(() => showHighlight(null), 1600);
      },
    }, h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '◎' }), el.label || el.tag || 'element');
  }

  function renderMessage(m) {
    const agent = m.from === 'agent';
    const who = agent ? (cfg.names && cfg.names.agent) || 'Agent' : (cfg.names && cfg.names.reviewer) || 'You';
    const meta = [h('span', { class: 'who', text: who })];
    if (agent && AGENT_LABEL[m.status]) meta.push(h('span', { class: 'tag s-' + m.status, text: AGENT_LABEL[m.status] }));
    if (m.ack) meta.push(h('span', { class: 'tag ' + (m.ack === 'good' ? 's-fixed' : 's-wontfix'), text: m.ack === 'good' ? 'rechecked, good' : 'still wrong' }));
    meta.push(h('span', { class: 'when', text: m.pending ? 'sending…' : time(m.at) }));
    const ctx = m.context || {};
    return h('div', { class: 'msg ' + (agent ? 'agent' : 'reviewer') + (m.pending ? ' pending' : '') },
      h('div', { class: 'meta' }, meta),
      m.text ? h('div', { class: 'text', text: m.text }) : null,
      (ctx.url && !m.replyTo) || ctx.element
        ? h('div', { class: 'ctx' },
          ctx.url && !m.replyTo ? h('span', { class: 'chip page', title: (ctx.viewport || '') + (ctx.theme ? ' · ' + ctx.theme : ''), text: ctx.url }) : null,
          ctx.element ? elementChip(ctx.element) : null)
        : null
    );
  }

  function renderThreads(snap) {
    const ts = threads(snap.messages);
    const keepBottom = threadsEl.scrollHeight - threadsEl.scrollTop - threadsEl.clientHeight < 40;
    const prevTop = threadsEl.scrollTop;
    threadsEl.textContent = '';
    if (!ts.length) {
      threadsEl.append(h('div', { class: 'empty' },
        h('p', { text: 'Walk through your site and tell the agent what to change.' }),
        h('ul', null,
          h('li', { text: 'Use “Pick element” to point at the exact thing you mean.' }),
          h('li', { text: 'The page, window size and theme are attached to every message.' }),
          h('li', { text: 'Your coding agent picks them up from its inbox and replies here.' }))));
      return;
    }
    for (const t of ts) {
      const [label, cls] = STATUS[t.status];
      const actions = [];
      if (t.status === 'recheck') {
        actions.push(
          h('button', { class: 'btn small ok', type: 'button', text: 'Looks good', onclick: () => enqueue('messages', { id: uid('m'), from: 'reviewer', replyTo: t.root.id, ack: 'good', text: 'Rechecked, looks good.', at: nowIso(), context: context(false) }) }),
          h('button', { class: 'btn small', type: 'button', text: 'Still wrong…', onclick: () => { replyTo = { id: t.root.id, ack: 'wrong' }; renderChips(); input.focus(); } })
        );
      }
      actions.push(h('button', { class: 'btn small ghost', type: 'button', text: 'Reply', onclick: () => { replyTo = { id: t.root.id }; renderChips(); input.focus(); } }));
      threadsEl.append(h('article', { class: 'thread st-' + cls, 'data-id': t.root.id },
        renderMessage(t.root),
        t.replies.length ? h('div', { class: 'replies' }, t.replies.map(renderMessage)) : null,
        h('div', { class: 'thread-foot' },
          h('span', { class: 'badge b-' + cls, text: label }),
          t.root.check ? h('span', { class: 'from-list', text: 'from checklist' }) : null,
          h('span', { class: 'grow' }), actions)
      ));
    }
    threadsEl.scrollTop = keepBottom ? threadsEl.scrollHeight : prevTop;
  }

  function renderChips() {
    chips.textContent = '';
    if (replyTo) {
      const v = view();
      const root = v.messages.find((m) => m.id === replyTo.id);
      chips.append(h('span', { class: 'chip ' + (replyTo.ack ? 'warn' : '') },
        (replyTo.ack ? 'Still wrong: ' : 'Replying to: ') + (root ? clean(root.text).slice(0, 40) : replyTo.id),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Cancel reply', text: '×', onclick: () => { replyTo = null; renderChips(); } })));
      input.placeholder = replyTo.ack ? 'What is still wrong?' : 'Reply…';
    } else {
      input.placeholder = 'Tell the agent what to change…';
    }
    chips.append(h('span', { class: 'chip page', title: 'Sent with the message', text: location.pathname + location.search }));
    if (attach) {
      chips.append(h('span', { class: 'chip el' }, h('span', { class: 'chip-icon', 'aria-hidden': 'true', text: '◎' }), attach.label,
        h('button', { class: 'x', type: 'button', 'aria-label': 'Remove element', text: '×', onclick: () => { attach = null; renderChips(); renderPickBtn(); } })));
    }
  }

  // ── checklist ──
  function setCheck(id, status, note) {
    const v = view();
    const prev = v.checks[id] || {};
    enqueue('checks', { id, status, note: note != null ? note : (prev.note || ''), updatedAt: nowIso(), page: location.pathname });
  }
  function sendCheckToAgent(item) {
    const note = (noteDrafts[item.id] != null ? noteDrafts[item.id] : ((view().checks[item.id] || {}).note || '')).trim();
    setCheck(item.id, 'fix', note);
    enqueue('messages', {
      id: uid('m'), from: 'reviewer', check: item.id, at: nowIso(), context: context(true),
      text: 'Checklist: ' + item.text + (note ? '\n' + note : ''),
    });
    attach = null;
    renderChips();
    renderPickBtn();
    say('Sent to the agent. It is in the Chat tab.');
  }

  function renderChecklist(snap) {
    const active = shadow.activeElement;
    const focusKey = active && active.dataset ? active.dataset.key : null;
    const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const prevTop = listEl.scrollTop;

    const cl = snap.checklist;
    let total = 0, pass = 0, fix = 0, na = 0;
    for (const s of cl.sections) for (const it of s.items) {
      total++;
      const st = (snap.checks[it.id] || {}).status;
      if (st === 'pass') pass++; else if (st === 'fix') fix++; else if (st === 'na') na++;
    }
    const done = pass + fix + na;
    listHead.textContent = '';
    listHead.append(
      h('div', { class: 'list-title' }, h('strong', { text: cl.title }), h('span', { class: 'muted', text: done + ' of ' + total + ' checked' })),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Checklist progress', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
        h('span', { class: 'p-pass', style: 'width:' + pct(pass, total) }), h('span', { class: 'p-fix', style: 'width:' + pct(fix, total) }), h('span', { class: 'p-na', style: 'width:' + pct(na, total) })),
      h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Show' },
        [['all', 'All'], ['todo', 'Not checked'], ['fix', 'Needs fix (' + fix + ')']].map(([k, l]) =>
          h('button', { class: 'seg', type: 'button', role: 'radio', 'aria-checked': String(ui.filter === k), text: l, onclick: () => { ui.filter = k; saveUi(); render(); } })))
    );

    listEl.textContent = '';
    const threadByCheck = {};
    for (const t of threads(snap.messages)) if (t.root.check) threadByCheck[t.root.check] = t;

    for (const s of cl.sections) {
      const items = s.items.filter((it) => {
        const st = (snap.checks[it.id] || {}).status || 'open';
        return ui.filter === 'all' || (ui.filter === 'todo' && st === 'open') || (ui.filter === 'fix' && st === 'fix');
      });
      if (ui.filter !== 'all' && !items.length) continue;
      const sDone = s.items.filter((it) => ((snap.checks[it.id] || {}).status || 'open') !== 'open').length;
      const det = h('details', { class: 'sec' });
      det.open = !ui.collapsed[s.id];
      det.addEventListener('toggle', () => { ui.collapsed[s.id] = !det.open; saveUi(); });
      det.append(h('summary', null, h('span', { class: 'sec-title', text: s.title }), h('span', { class: 'muted', text: sDone + '/' + s.items.length }),
        s.custom ? h('button', { class: 'x', type: 'button', 'aria-label': 'Delete section ' + s.title, title: 'Delete section', text: '×', onclick: (e) => { e.preventDefault(); if (confirm('Delete the section “' + s.title + '” and its items?')) { s.items.forEach((it) => it.custom && enqueue('custom', { kind: 'item', id: it.id, section: s.id, deleted: true, updatedAt: nowIso() })); enqueue('custom', { kind: 'section', id: s.id, title: s.title, deleted: true, updatedAt: nowIso() }); } } }) : null));
      if (s.error) det.append(h('p', { class: 'err', text: s.error }));

      for (const it of items) {
        const c = snap.checks[it.id] || { status: 'open', note: '' };
        const row = h('div', { class: 'item st-' + c.status });
        const statusBtn = (st, label, symbol) => h('button', {
          class: 'st ' + st, type: 'button', onmousedown: keepFocus, 'aria-pressed': String(c.status === st), title: label, 'aria-label': label + ': ' + it.text,
          onclick: () => setCheck(it.id, c.status === st ? 'open' : st),
        }, symbol);
        row.append(h('div', { class: 'item-main' },
          h('div', { class: 'item-text' }, h('span', { text: it.text }), it.hint ? h('small', { text: it.hint }) : null),
          h('div', { class: 'item-btns' },
            statusBtn('pass', 'Passes', '✓'), statusBtn('fix', 'Needs fix', '!'), statusBtn('na', 'Not applicable', '–'),
            it.custom ? h('button', { class: 'x', type: 'button', 'aria-label': 'Delete item ' + it.text, title: 'Delete item', text: '×', onclick: () => enqueue('custom', { kind: 'item', id: it.id, section: s.id, deleted: true, updatedAt: nowIso() }) }) : null)));
        if (c.status === 'fix') {
          const ta = h('textarea', { class: 'note', rows: '2', 'data-key': 'note:' + it.id, placeholder: 'What needs fixing? (optional)', 'aria-label': 'Note for ' + it.text });
          ta.value = noteDrafts[it.id] != null ? noteDrafts[it.id] : (c.note || '');
          ta.addEventListener('input', () => { noteDrafts[it.id] = ta.value; lsSet('notes', noteDrafts); });
          ta.addEventListener('blur', () => {
            if (rendering) return; // the list is being rebuilt, not left by the user
            if (noteDrafts[it.id] != null && noteDrafts[it.id] !== (c.note || '')) setCheck(it.id, 'fix', noteDrafts[it.id]);
            delete noteDrafts[it.id];
            lsSet('notes', noteDrafts);
          });
          const t = threadByCheck[it.id];
          row.append(ta, h('div', { class: 'row' },
            t ? h('button', { class: 'chip linky', type: 'button', onclick: () => { setTab('chat'); const el = threadsEl.querySelector('[data-id="' + t.root.id + '"]'); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); } } }, 'Thread: ' + STATUS[t.status][0])
              : h('span', { class: 'hint', text: attach ? 'Picked element will be attached' : 'Tip: pick an element first to attach it' }),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn small primary', type: 'button', onmousedown: keepFocus, text: t ? 'Send again' : 'Send to agent', onclick: () => sendCheckToAgent(it) })));
        }
        det.append(row);
      }

      if (ui.filter === 'all') {
        if (addingTo[s.id]) {
          const add = h('input', { class: 'add-input', type: 'text', placeholder: 'New item, then Enter', 'data-key': 'add:' + s.id, 'aria-label': 'New item in ' + s.title });
          add.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && add.value.trim()) { enqueue('custom', { kind: 'item', id: uid('u'), section: s.id, text: add.value.trim(), updatedAt: nowIso() }); }
            if (e.key === 'Escape') { delete addingTo[s.id]; render(); }
          });
          det.append(add);
          if (addingTo[s.id] === 'new') { addingTo[s.id] = true; requestAnimationFrame(() => add.focus()); }
        } else {
          det.append(h('button', { class: 'add', type: 'button', text: '+ Add item', onclick: () => { addingTo[s.id] = 'new'; render(); } }));
        }
      }
      listEl.append(det);
    }

    if (ui.filter === 'all') {
      const secInput = h('input', { class: 'add-input', type: 'text', placeholder: 'New section name', 'data-key': 'add-section', 'aria-label': 'New section name' });
      const addSection = () => {
        const title = secInput.value.trim();
        if (!title) return;
        const id = 'u-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) + '-' + Math.random().toString(36).slice(2, 5);
        enqueue('custom', { kind: 'section', id, title, updatedAt: nowIso() });
        addingTo[id] = 'new';
      };
      secInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSection(); });
      listEl.append(h('div', { class: 'add-section' }, secInput, h('button', { class: 'btn small', type: 'button', text: 'Add section', onclick: addSection })));
    } else if (!listEl.children.length) {
      listEl.append(h('p', { class: 'empty', text: ui.filter === 'fix' ? 'Nothing marked as needing a fix.' : 'Everything has been checked.' }));
    }

    listEl.scrollTop = prevTop;
    if (focusKey) {
      const el = listEl.querySelector('[data-key="' + focusKey.replace(/"/g, '\\"') + '"]');
      if (el) { el.focus(); if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(sel[0], sel[1]); } catch (_) { /* ignore */ } }
    }
  }
  function keepFocus(e) { if (shadow.activeElement && shadow.activeElement.classList.contains('note')) e.preventDefault(); }
  function pct(n, total) { return total ? (100 * n / total).toFixed(2) + '%' : '0'; }

  // ── badges, status ──
  function renderStatus() {
    const n = queue.length;
    statusDot.className = 'dot ' + (online ? 'on' : online === false ? 'off' : '');
    statusText.textContent = online === false ? 'Offline' + (n ? ' · ' + n + ' unsaved' : '') : online ? (n ? 'Saving…' : 'Live') : 'Connecting…';
    panel.classList.toggle('is-offline', online === false);
  }
  function renderBadges() {
    const snap = view();
    const agentMsgs = snap.messages.filter((m) => m.from === 'agent');
    const latest = agentMsgs.length ? agentMsgs[agentMsgs.length - 1].at : '';
    if (ui.open && ui.tab === 'chat' && latest && latest > ui.lastSeen && DOC.visibilityState === 'visible') { ui.lastSeen = latest; saveUi(); }
    const unread = agentMsgs.filter((m) => m.at > ui.lastSeen).length;
    const waiting = threads(snap.messages).filter((t) => t.status === 'needs-agent').length;
    tabChat.textContent = 'Chat';
    if (unread) tabChat.append(h('span', { class: 'count', 'aria-label': unread + ' new', text: String(unread) }));
    let fix = 0, total = 0, done = 0;
    for (const s of snap.checklist.sections) for (const it of s.items) {
      total++;
      const st = (snap.checks[it.id] || {}).status;
      if (st && st !== 'open') done++;
      if (st === 'fix') fix++;
    }
    tabList.textContent = 'Checklist';
    tabList.append(h('span', { class: 'muted small', text: ' ' + done + '/' + total }));
    pill.textContent = '';
    pill.append(h('span', { class: 'dot ' + (online === false ? 'off' : 'on'), 'aria-hidden': 'true' }), 'UX review');
    if (unread) pill.append(h('span', { class: 'count', text: unread + ' new' }));
    else if (waiting) pill.append(h('span', { class: 'muted small', text: waiting + ' waiting' }));
    else if (fix) pill.append(h('span', { class: 'muted small', text: fix + ' to fix' }));
  }

  let rendering = false;
  function render() {
    if (rendering) return;
    rendering = true;
    try {
      const snap = view();
      renderStatus();
      renderThreads(snap);
      renderChecklist(snap);
      renderBadges();
    } finally {
      rendering = false;
    }
  }
  document.addEventListener('visibilitychange', renderBadges);

  // ── copy summary ──
  async function copySummary() {
    try {
      const r = await fetch(API + '/summary');
      const md = await r.text();
      await navigator.clipboard.writeText(md);
      say('Summary copied (same as review/review.md).');
    } catch (_) {
      say('Could not copy. The summary is in review/review.md.', true);
    }
  }

  // ── boot ──
  window.uxReview = {
    isReviewElement,
    open: () => setOpen(true),
    close: () => setOpen(false),
    host,
  };
  function mount() {
    DOC.documentElement.append(host);
    fitViewport();
    layout();
    renderChips();
    renderPickBtn();
    render();
    connect();
  }
  if (DOC.readyState === 'loading') DOC.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  // ── styles (kept at the bottom so the logic reads first) ──

  function STYLES() {
    return `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel, .pill, .toast, .hl-label {
  --bg: #ffffff; --bg2: #f4f5f7; --bg3: #e9ecf0; --fg: #1b1f24; --muted: #5d6672; --line: #d9dde3;
  --accent: #3657d6; --accent-fg: #ffffff; --ok: #1d7f46; --ok-bg: #e3f4ea; --warn: #9a5200; --warn-bg: #fdf0dc;
  --bad: #b8312f; --bad-bg: #fbe5e4; --info: #3657d6; --info-bg: #e6ebfb; --shadow: 0 12px 40px rgba(16,24,40,.18), 0 2px 6px rgba(16,24,40,.08);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .panel, .pill, .toast, .hl-label {
    --bg: #1b1e23; --bg2: #23272e; --bg3: #2d323a; --fg: #e7e9ec; --muted: #9ba4af; --line: #353b44;
    --accent: #8aa2ff; --accent-fg: #0e1220; --ok: #5fd08f; --ok-bg: #173323; --warn: #f0b35a; --warn-bg: #3a2a12;
    --bad: #ff8a85; --bad-bg: #3d1b1b; --info: #8aa2ff; --info-bg: #1e2647; --shadow: 0 12px 40px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.3);
  }
}
button { font: inherit; color: inherit; cursor: pointer; }
button:focus-visible, textarea:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.vv { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; transform-origin: 0 0; }
.panel {
  position: absolute; top: 12px; bottom: 12px; width: var(--w, 380px); max-width: calc(100% - 24px);
  display: flex; flex-direction: column; pointer-events: auto;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden;
}
.panel[data-side="right"] { right: 12px; }
.panel[data-side="left"] { left: 12px; }
.resize { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; touch-action: none; }
.panel[data-side="right"] .resize { left: -2px; }
.panel[data-side="left"] .resize { right: -2px; }
.panel.is-offline { border-color: var(--bad); }

.head { display: flex; align-items: center; gap: 6px; padding: 10px 8px 6px 14px; }
.title { font-size: 14px; font-weight: 650; }
.status { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; margin-left: 6px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); display: inline-block; flex: none; }
.dot.on { background: var(--ok); }
.dot.off { background: var(--bad); }
.grow { flex: 1; }
.icon { display: inline-grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); }
.icon:hover { background: var(--bg2); color: var(--fg); }

.tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid var(--line); }
.tab { border: 0; background: none; padding: 8px 10px; margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--muted); font-weight: 550; display: inline-flex; gap: 6px; align-items: center; }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
.tab:hover { color: var(--fg); }
.count { background: var(--accent); color: var(--accent-fg); border-radius: 999px; padding: 0 6px; font-size: 11px; font-weight: 650; line-height: 17px; }
.muted { color: var(--muted); }
.small { font-size: 11.5px; font-weight: 450; }

.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* chat */
.threads { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.thread { flex: none; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); overflow: hidden; transition: box-shadow .3s; }
.thread.flash { box-shadow: 0 0 0 3px var(--accent); }
.thread.st-done { opacity: .72; }
.msg { padding: 9px 11px; }
.msg + .msg, .replies .msg { border-top: 1px solid var(--line); }
.msg.agent { background: var(--bg2); }
.msg.pending { opacity: .6; }
.meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 3px; font-size: 11.5px; color: var(--muted); }
.who { font-weight: 650; color: var(--fg); }
.when { margin-left: auto; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.ctx { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.tag { border-radius: 4px; padding: 0 5px; font-size: 11px; font-weight: 600; background: var(--bg3); color: var(--muted); }
.tag.s-fixed { background: var(--ok-bg); color: var(--ok); }
.tag.s-working { background: var(--info-bg); color: var(--info); }
.tag.s-question { background: var(--warn-bg); color: var(--warn); }
.tag.s-wontfix { background: var(--bad-bg); color: var(--bad); }
.thread-foot { display: flex; gap: 6px; align-items: center; padding: 6px 8px 6px 11px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.badge { font-size: 11.5px; font-weight: 600; border-radius: 999px; padding: 1px 8px; background: var(--bg3); color: var(--muted); }
.b-wait { background: var(--warn-bg); color: var(--warn); }
.b-work { background: var(--info-bg); color: var(--info); }
.b-fixed { background: var(--ok-bg); color: var(--ok); }
.b-ask { background: var(--warn-bg); color: var(--warn); }
.from-list { font-size: 11.5px; color: var(--muted); }
.empty { color: var(--muted); padding: 8px 4px; }
.empty p { margin: 0 0 8px; color: var(--fg); font-weight: 550; }
.empty ul { margin: 0; padding-left: 18px; }
.empty li { margin: 3px 0; }

.composer { border-top: 1px solid var(--line); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; background: var(--bg); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; border: 1px solid var(--line); background: var(--bg2); color: var(--muted); border-radius: 999px; padding: 1px 8px; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip.el { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
.chip.warn { color: var(--warn); background: var(--warn-bg); border-color: transparent; }
.chip.linky:hover, button.chip.el:hover { background: var(--bg3); }
.chip-icon { font-size: 12px; }
.x { border: 0; background: none; color: inherit; padding: 0 2px; font-size: 14px; line-height: 1; opacity: .7; }
.x:hover { opacity: 1; }
.input, .note, .add-input { width: 100%; resize: vertical; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; }
.input { min-height: 64px; max-height: 30vh; }
.input:focus, .note:focus, .add-input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.row { display: flex; gap: 8px; align-items: center; }
.hint { color: var(--muted); font-size: 11.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn { border: 1px solid var(--line); background: var(--bg); border-radius: 7px; padding: 5px 11px; font-weight: 550; white-space: nowrap; }
.btn:hover { background: var(--bg2); }
.btn[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn.primary:hover { filter: brightness(1.08); }
.composer .row .primary { margin-left: auto; }
.btn.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
.btn.ghost { border-color: transparent; color: var(--muted); }
.btn.small { padding: 3px 9px; font-size: 12px; }

/* checklist */
.list-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 7px; }
.list-title { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.progress { display: flex; height: 6px; border-radius: 999px; background: var(--bg3); overflow: hidden; }
.p-pass { background: var(--ok); } .p-fix { background: var(--warn); } .p-na { background: var(--muted); opacity: .5; }
.filters { display: flex; gap: 4px; }
.seg { border: 1px solid var(--line); background: var(--bg); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
.seg[aria-checked="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.list { flex: 1; overflow-y: auto; padding: 6px 10px 14px; overscroll-behavior: contain; }
.sec { border-bottom: 1px solid var(--line); padding: 4px 0 8px; }
.sec > summary { display: flex; align-items: center; gap: 8px; padding: 7px 4px; cursor: pointer; list-style: none; font-weight: 650; }
.sec > summary::-webkit-details-marker { display: none; }
.sec > summary::before { content: '▸'; color: var(--muted); font-size: 11px; transition: transform .15s; }
.sec[open] > summary::before { transform: rotate(90deg); }
.sec-title { flex: 1; }
.err { color: var(--bad); margin: 4px; }
.item { padding: 7px 6px; border-radius: 8px; display: flex; flex-direction: column; gap: 6px; }
.item:hover { background: var(--bg2); }
.item.st-fix { background: var(--warn-bg); }
.item.st-pass .item-text span, .item.st-na .item-text span { color: var(--muted); }
.item.st-na .item-text span { text-decoration: line-through; }
.item-main { display: flex; gap: 8px; align-items: flex-start; }
.item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.item-text small { color: var(--muted); font-size: 11.5px; }
.item-btns { display: flex; gap: 3px; flex: none; align-items: center; }
.st { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); font-weight: 700; display: inline-grid; place-items: center; }
.st:hover { border-color: var(--muted); }
.st.pass[aria-pressed="true"] { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.st.fix[aria-pressed="true"] { background: var(--warn); border-color: var(--warn); color: var(--bg); }
.st.na[aria-pressed="true"] { background: var(--muted); border-color: var(--muted); color: var(--bg); }
.note { min-height: 44px; }
.add { border: 0; background: none; color: var(--accent); padding: 6px; font-size: 12px; font-weight: 550; }
.add:hover { text-decoration: underline; }
.add-input { margin: 4px 0; }
.add-section { display: flex; gap: 6px; padding: 12px 2px 0; align-items: center; }
.add-section .add-input { margin: 0; }

/* minimised pill */
.pill { position: absolute; bottom: 16px; pointer-events: auto; display: inline-flex; gap: 8px; align-items: center; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); box-shadow: var(--shadow); font-weight: 600; }
.pill[data-side="right"] { right: 16px; }
.pill[data-side="left"] { left: 16px; }

/* highlight */
.hl { position: fixed; left: 0; top: 0; pointer-events: none; border: 2px solid #3657d6; background: rgba(54,87,214,.12); border-radius: 3px; box-shadow: 0 0 0 9999px rgba(0,0,0,.08); }
.hl-label { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #3657d6; color: #fff; padding: 2px 7px; border-radius: 4px; font-size: 11.5px; }
.hl.below .hl-label { bottom: auto; top: 100%; margin: 4px 0 0; }
.hl-label:empty { display: none; }

.toast { position: absolute; left: 50%; bottom: 20px; transform: translate(-50%, 12px); opacity: 0; pointer-events: none; background: var(--fg); color: var(--bg); padding: 8px 14px; border-radius: 8px; box-shadow: var(--shadow); transition: opacity .2s, transform .2s; max-width: calc(100% - 32px); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast.bad { background: var(--bad); color: #fff; }

.vv.narrow .panel { top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-width: none; height: min(60%, 520px); }
.vv.narrow .resize { display: none; }
.vv.narrow .hint { display: none; }
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; scroll-behavior: auto !important; }
}
@media (forced-colors: active) {
  .panel, .pill, .thread, .st, .btn { border: 1px solid CanvasText; }
  .hl { border-color: Highlight; }
}
`;
  }
})();
