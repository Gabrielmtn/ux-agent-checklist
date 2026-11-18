'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, threads } = require('../server/store');

function tmpStore(templates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-'));
  const tpl = path.join(dir, 'list.json');
  fs.writeFileSync(tpl, JSON.stringify(templates || {
    title: 'T',
    sections: [{ id: 'a', title: 'A', items: [{ id: 'one', text: 'First' }, { text: 'Second, no id' }] }],
  }));
  return new Store({ outDir: path.join(dir, 'out'), checklistFiles: [tpl], rootDir: dir });
}

test('checklist ids are stable: given ids are kept, missing ones come from the text', () => {
  const a = tmpStore().checklist().sections[0].items.map((i) => i.id);
  const b = tmpStore().checklist().sections[0].items.map((i) => i.id);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a[0], 'a/one');
  assert.match(a[1], /^a\/t[0-9a-f]{8}$/);
});

test('messages are idempotent by id and replies point at the thread root', () => {
  const s = tmpStore();
  s.addMessage({ id: 'm1', from: 'reviewer', text: 'Button is too small' });
  s.addMessage({ id: 'm1', from: 'reviewer', text: 'Button is too small' }); // offline retry
  s.addMessage({ id: 'a1', from: 'agent', replyTo: 'm1', text: 'On it', status: 'working' });
  s.addMessage({ id: 'a2', from: 'agent', replyTo: 'a1', text: 'Done', status: 'fixed' });
  assert.strictEqual(s.state.messages.length, 3);
  assert.strictEqual(s.state.messages[2].replyTo, 'm1');
});

test('thread status follows the conversation', () => {
  const s = tmpStore();
  const st = () => threads(s.state.messages)[0].status;
  s.addMessage({ id: 'm1', from: 'reviewer', text: 'x' });
  assert.strictEqual(st(), 'needs-agent');
  s.addMessage({ id: 'a1', from: 'agent', replyTo: 'm1', text: 'y', status: 'fixed' });
  assert.strictEqual(st(), 'recheck');
  s.addMessage({ id: 'r1', from: 'reviewer', replyTo: 'm1', text: 'nope', ack: 'wrong' });
  assert.strictEqual(st(), 'needs-agent');
  s.addMessage({ id: 'a2', from: 'agent', replyTo: 'm1', text: 'now?', status: 'fixed' });
  s.addMessage({ id: 'r2', from: 'reviewer', replyTo: 'm1', text: '', ack: 'good' });
  assert.strictEqual(st(), 'resolved');
});

test('a reply to an unknown message is refused', () => {
  const s = tmpStore();
  assert.throws(() => s.addMessage({ from: 'agent', replyTo: 'nope', text: 'x' }), /not found/);
});

test('checklist results: the newer copy wins', () => {
  const s = tmpStore();
  s.setCheck({ id: 'a/one', status: 'fix', note: 'new', updatedAt: '2026-11-17T10:00:00.000Z' });
  s.setCheck({ id: 'a/one', status: 'pass', note: '', updatedAt: '2026-11-17T09:00:00.000Z' }); // stale offline edit
  assert.strictEqual(s.state.checks['a/one'].status, 'fix');
});

test('custom sections and items appear in the checklist and can be deleted', () => {
  const s = tmpStore();
  s.upsertCustom({ kind: 'section', id: 'u-mine', title: 'Mine' });
  s.upsertCustom({ kind: 'item', id: 'u-1', section: 'u-mine', text: 'Logo links home' });
  let mine = s.checklist().sections.find((x) => x.id === 'u-mine');
  assert.deepStrictEqual(mine.items.map((i) => i.text), ['Logo links home']);
  s.upsertCustom({ kind: 'item', id: 'u-1', section: 'u-mine', deleted: true, updatedAt: new Date(Date.now() + 1000).toISOString() });
  mine = s.checklist().sections.find((x) => x.id === 'u-mine');
  assert.strictEqual(mine.items.length, 0);
});

test('files: state, summary and events are written; the summary leaves out unchecked items', () => {
  const s = tmpStore();
  s.setCheck({ id: 'a/one', status: 'fix', note: 'too pale' });
  s.addMessage({ id: 'm1', from: 'reviewer', text: 'Hero text is cut', context: { url: '/', element: { selector: 'h1', label: 'Hero' } } });
  const md = fs.readFileSync(s.files.md, 'utf8');
  assert.match(md, /\*\*FIX\*\* First: too pale/);
  assert.doesNotMatch(md, /Second, no id/);
  assert.match(md, /Waiting on the agent \(1\)/);
  const events = fs.readFileSync(s.files.events, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(events.map((e) => e.type), ['check', 'message']);
  assert.ok(JSON.parse(fs.readFileSync(s.files.state, 'utf8')).messages.length === 1);
});
