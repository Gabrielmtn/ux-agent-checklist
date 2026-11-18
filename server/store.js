'use strict';
// Review state: chat messages (threads), checklist results and custom
// checklist items. Every write goes through here, is merged by id and time
// (so retries and offline queues are safe), and is mirrored to three files:
//
//   review/state.json     full state, machine-readable
//   review/review.md      readable summary: what needs the agent, checklist, conversation
//   review/events.ndjson  one line per new message or checklist change (append-only)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FROM = new Set(['reviewer', 'agent']);
const AGENT_STATUS = new Set(['working', 'fixed', 'question', 'wontfix', 'note']);
const ACK = new Set(['good', 'wrong']);
const CHECK_STATUS = new Set(['open', 'pass', 'fix', 'na']);
const ID_RE = /^[A-Za-z0-9_:./-]{1,120}$/;
const MAX_TEXT = 8000;

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || hash(s);
}
function now() {
  return new Date().toISOString();
}
function str(v, max = MAX_TEXT) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function writeAtomic(fp, data) {
  const tmp = fp + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    // Windows refuses to replace a file another process has open; fall back.
    fs.writeFileSync(fp, data);
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

class Store {
  constructor({ outDir, checklistFiles, rootDir }) {
    this.rootDir = rootDir;
    this.outDir = outDir;
    this.checklistFiles = checklistFiles;
    this.files = {
      state: path.join(outDir, 'state.json'),
      md: path.join(outDir, 'review.md'),
      events: path.join(outDir, 'events.ndjson'),
    };
    fs.mkdirSync(outDir, { recursive: true });
    this.state = this._load();
    this.rev = 0;
    this.listeners = new Set();
  }

  _load() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(this.files.state, 'utf8')); } catch (_) { /* new review */ }
    s = s && typeof s === 'object' ? s : {};
    return {
      version: 1,
      startedAt: s.startedAt || now(),
      messages: Array.isArray(s.messages) ? s.messages : [],
      checks: s.checks && typeof s.checks === 'object' ? s.checks : {},
      custom: {
        sections: (s.custom && Array.isArray(s.custom.sections)) ? s.custom.sections : [],
        items: (s.custom && Array.isArray(s.custom.items)) ? s.custom.items : [],
      },
    };
  }

  // ── checklist templates (re-read on every call, so editing a template shows on reload) ──
  checklist() {
    const sections = [];
    const titles = [];
    const seen = new Set();
    for (const file of this.checklistFiles) {
      let tpl;
      try {
        tpl = JSON.parse(fs.readFileSync(path.resolve(this.rootDir, file), 'utf8'));
      } catch (e) {
        sections.push({ id: 'error-' + hash(file), title: 'Could not read ' + file, error: String(e.message), items: [] });
        continue;
      }
      if (tpl.title) titles.push(tpl.title);
      for (const sec of tpl.sections || []) {
        const sid = sec.id ? String(sec.id) : slug(sec.title);
        let target = sections.find((x) => x.id === sid);
        if (!target) {
          target = { id: sid, title: sec.title || sid, items: [] };
          sections.push(target);
        }
        for (const it of sec.items || []) {
          const text = typeof it === 'string' ? it : it.text;
          if (!text) continue;
          const iid = (typeof it === 'object' && it.id) ? String(it.id) : 't' + hash(text);
          const id = sid + '/' + iid;
          if (seen.has(id)) continue;
          seen.add(id);
          target.items.push({ id, text, hint: (typeof it === 'object' && it.hint) || '' });
        }
      }
    }
    for (const cs of this.state.custom.sections) {
      if (cs.deleted || sections.some((x) => x.id === cs.id)) continue;
      sections.push({ id: cs.id, title: cs.title, custom: true, items: [] });
    }
    for (const ci of this.state.custom.items) {
      if (ci.deleted) continue;
      const sec = sections.find((x) => x.id === ci.section) || sections[sections.length - 1];
      if (sec) sec.items.push({ id: ci.id, text: ci.text, hint: '', custom: true });
    }
    return { title: titles.join(' + ') || 'Checklist', sections };
  }

  snapshot() {
    return { rev: this.rev, ...this.state, checklist: this.checklist() };
  }

  // ── writes ──
  addMessage(input) {
    const m = input || {};
    const id = str(m.id, 120) || 'm-' + Date.now().toString(36) + '-' + hash(Math.random());
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad message id');
    const existing = this.state.messages.find((x) => x.id === id);
    if (existing) return existing; // idempotent: offline queues retry
    if (!FROM.has(m.from)) throw new HttpError(400, 'from must be reviewer or agent');
    const text = str(m.text).trim();
    if (!text && !m.ack) throw new HttpError(400, 'empty message');

    const msg = { id, from: m.from, text, at: str(m.at, 40) || now() };
    if (m.replyTo) {
      const parent = this.state.messages.find((x) => x.id === m.replyTo);
      if (!parent) throw new HttpError(400, 'replyTo ' + m.replyTo + ' not found');
      msg.replyTo = parent.replyTo || parent.id; // always point at the thread root
    }
    if (m.from === 'agent') {
      msg.status = AGENT_STATUS.has(m.status) ? m.status : 'note';
    }
    if (m.from === 'reviewer' && ACK.has(m.ack)) msg.ack = m.ack;
    if (m.check && typeof m.check === 'string') msg.check = str(m.check, 120);
    if (m.context && typeof m.context === 'object') msg.context = cleanContext(m.context);

    this.state.messages.push(msg);
    this._event({ type: 'message', ...msg, thread: msg.replyTo || msg.id });
    this._commit();
    return msg;
  }

  setCheck(input) {
    const c = input || {};
    const id = str(c.id, 120);
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad check id');
    if (!CHECK_STATUS.has(c.status)) throw new HttpError(400, 'bad check status');
    const updatedAt = str(c.updatedAt, 40) || now();
    const prev = this.state.checks[id];
    if (prev && prev.updatedAt && prev.updatedAt > updatedAt) return prev; // newer copy wins
    const next = { status: c.status, note: str(c.note, 2000), updatedAt };
    if (c.page) next.page = str(c.page, 500);
    this.state.checks[id] = next;
    if (!prev || prev.status !== next.status || prev.note !== next.note) {
      const item = this._findItem(id);
      this._event({ type: 'check', id, text: item ? item.text : id, status: next.status, note: next.note, at: updatedAt });
    }
    this._commit();
    return next;
  }

  upsertCustom(input) {
    const c = input || {};
    const kind = c.kind === 'section' ? 'sections' : 'items';
    const id = str(c.id, 120);
    if (!ID_RE.test(id)) throw new HttpError(400, 'bad custom id');
    const updatedAt = str(c.updatedAt, 40) || now();
    const list = this.state.custom[kind];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0 && list[i].updatedAt > updatedAt) return list[i];
    const rec = { id, updatedAt, deleted: !!c.deleted };
    if (kind === 'sections') rec.title = str(c.title, 200) || 'Untitled';
    else {
      rec.section = str(c.section, 120);
      rec.text = str(c.text, 500);
      if (!rec.text && !rec.deleted) throw new HttpError(400, 'empty item');
    }
    if (i >= 0) list[i] = rec; else list.push(rec);
    this._commit();
    return rec;
  }

  // Threads as the binding exposes them (GET /__review/api/threads).
  threadRecords() {
    return threads(this.state.messages).map((t) => {
      const rec = {
        id: t.root.id,
        status: t.status,
        context: t.root.context || {},
        messages: [t.root, ...t.replies],
      };
      if (t.root.check) {
        const item = this._findItem(t.root.check);
        rec.check = { id: t.root.check, text: item ? item.text : null, hint: item ? item.hint : null, result: this.state.checks[t.root.check] || null };
      }
      return rec;
    });
  }

  _findItem(id) {
    for (const s of this.checklist().sections) for (const it of s.items) if (it.id === id) return it;
    return null;
  }

  _event(ev) {
    fs.appendFileSync(this.files.events, JSON.stringify(ev) + '\n');
  }

  _commit() {
    this.rev++;
    writeAtomic(this.files.state, JSON.stringify(this.state, null, 2));
    writeAtomic(this.files.md, toMarkdown(this.snapshot()));
    for (const fn of this.listeners) { try { fn(this.rev); } catch (_) { /* ignore */ } }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function cleanContext(c) {
  const out = {};
  for (const k of ['url', 'title', 'viewport', 'theme']) if (c[k]) out[k] = str(c[k], 500);
  if (typeof c.dpr === 'number') out.dpr = c.dpr;
  if (c.element && typeof c.element === 'object') {
    out.element = { selector: str(c.element.selector, 1000), label: str(c.element.label, 200) };
    if (c.element.tag) out.element.tag = str(c.element.tag, 40);
  }
  return out;
}

// ── threads: shared by the summary and the CLI inbox ──
function threads(messages) {
  const roots = [];
  const byRoot = new Map();
  for (const m of messages) {
    if (!m.replyTo) {
      const t = { root: m, replies: [] };
      roots.push(t);
      byRoot.set(m.id, t);
    }
  }
  for (const m of messages) if (m.replyTo && byRoot.has(m.replyTo)) byRoot.get(m.replyTo).replies.push(m);
  for (const t of roots) t.status = threadStatus(t);
  return roots;
}

// What the thread is waiting on.
//   needs-agent  the reviewer spoke last (new request, follow-up, or "still wrong")
//   working      the agent said it is on it
//   recheck      the agent says fixed; the reviewer should look
//   question     the agent asked something
//   resolved     the reviewer confirmed, or the agent closed it as wontfix/note
function threadStatus(t) {
  const last = t.replies.length ? t.replies[t.replies.length - 1] : t.root;
  if (last.from === 'reviewer') return last.ack === 'good' ? 'resolved' : 'needs-agent';
  switch (last.status) {
    case 'working': return 'working';
    case 'fixed': return 'recheck';
    case 'question': return 'question';
    default: return 'resolved';
  }
}

const STATUS_LABEL = {
  'needs-agent': 'Needs agent',
  working: 'Agent working',
  recheck: 'Fixed, needs recheck',
  question: 'Agent asked a question',
  resolved: 'Resolved',
};

function where(ctx) {
  if (!ctx) return '';
  const bits = [];
  if (ctx.url) bits.push('`' + ctx.url + '`');
  if (ctx.element && ctx.element.selector) bits.push('element **' + (ctx.element.label || ctx.element.tag || '') + '** `' + ctx.element.selector + '`');
  if (ctx.viewport) bits.push(ctx.viewport + (ctx.dpr ? ' @' + ctx.dpr + 'x' : '') + (ctx.theme ? ' ' + ctx.theme : ''));
  return bits.join(' · ');
}

function toMarkdown(snap) {
  const out = ['# UX review', '', 'Started ' + snap.startedAt + ' · updated ' + now(), ''];
  const ts = threads(snap.messages);
  const open = ts.filter((t) => t.status === 'needs-agent');
  out.push('## Waiting on the agent (' + open.length + ')', '');
  if (!open.length) out.push('Nothing waiting.', '');
  for (const t of open) {
    const last = t.replies.length ? t.replies[t.replies.length - 1] : t.root;
    out.push('- **' + t.root.id + '**: ' + oneLine(t.root.text) + (last !== t.root ? '\n  - latest: ' + oneLine(last.text) : ''));
    const w = where(t.root.context);
    if (w) out.push('  - ' + w);
  }
  out.push('');

  // Checklist: only what was answered or added, never the untouched list.
  const cl = snap.checklist;
  let pass = 0, fix = 0, na = 0, total = 0;
  const lines = [];
  for (const s of cl.sections) {
    const rows = [];
    for (const it of s.items) {
      total++;
      const c = snap.checks[it.id];
      if (!c || c.status === 'open') continue;
      if (c.status === 'pass') pass++;
      if (c.status === 'fix') fix++;
      if (c.status === 'na') na++;
      const mark = c.status === 'pass' ? '[x]' : c.status === 'fix' ? '[ ] **FIX**' : '[-] n/a';
      rows.push('- ' + mark + ' ' + it.text + (it.custom ? ' _(added)_' : '') + (c.note ? ': ' + oneLine(c.note) : '') + (c.page ? ' (`' + c.page + '`)' : '') + '  `' + it.id + '`');
    }
    if (rows.length) lines.push('### ' + s.title, '', ...rows, '');
  }
  out.push('## Checklist: ' + cl.title, '', pass + ' passed · ' + fix + ' need fixes · ' + na + ' n/a · ' + (total - pass - fix - na) + ' not checked yet', '');
  out.push(...lines);

  out.push('## Conversation', '');
  if (!ts.length) out.push('No messages yet.', '');
  for (const t of ts) {
    out.push('### ' + t.root.id + ' (' + STATUS_LABEL[t.status] + ')', '');
    const w = where(t.root.context);
    if (w) out.push(w, '');
    for (const m of [t.root, ...t.replies]) {
      const who = m.from === 'agent' ? 'Agent' + (m.status ? ' [' + m.status + ']' : '') : 'Reviewer' + (m.ack ? ' [' + (m.ack === 'good' ? 'rechecked, good' : 'still wrong') + ']' : '');
      out.push('- **' + who + '** ' + m.at + ': ' + (m.text || '').replace(/\n/g, '\n  '));
    }
    out.push('');
  }
  return out.join('\n');
}

function oneLine(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 197) + '…' : t;
}

module.exports = { Store, HttpError, threads, threadStatus, toMarkdown, STATUS_LABEL, where, hash };
