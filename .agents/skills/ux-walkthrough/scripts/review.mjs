#!/usr/bin/env node
// The agent's client for the review binding (see ../binding.md).
//
//   review.mjs inbox [--json]
//   review.mjs wait [--timeout 600] [--json]
//   review.mjs thread <id>
//   review.mjs workdir <id> [--root .ux-review]
//   review.mjs reply <id> <working|fixed|question|wontfix|note> "text"
import { api, fail, getThread, parseArgs, whereLine, workDir } from './lib.mjs';

const STATUSES = ['working', 'fixed', 'question', 'wontfix', 'note'];
const args = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = args._;

function printThreads(list) {
  if (!list.length) return console.log('Nothing waiting on the agent.');
  for (const t of list) {
    console.log('━━ ' + t.id + '  [' + t.status + ']' + (t.check ? '  checklist: ' + t.check.id : ''));
    const w = whereLine(t.context);
    if (w) console.log('   ' + w);
    for (const m of t.messages) {
      const who = m.from === 'agent' ? 'agent/' + (m.status || 'note') : 'reviewer' + (m.ack ? '/' + m.ack : '');
      console.log('   ' + who.padEnd(16) + String(m.text || '').replace(/\n/g, '\n' + ' '.repeat(19)));
    }
    console.log('');
  }
}

// Checklist items marked "needs fix" that the reviewer has NOT sent: context only, never work.
async function unsentFixes() {
  const snap = await api('/state');
  const sent = new Set((snap.messages || []).filter((m) => m.check).map((m) => m.check));
  const out = [];
  for (const s of snap.checklist.sections) for (const it of s.items) {
    const c = snap.checks[it.id];
    if (c && c.status === 'fix' && !sent.has(it.id)) out.push({ id: it.id, text: it.text, note: c.note || '', page: c.page || '' });
  }
  return out;
}

async function inbox() {
  const { rev, threads } = await api('/threads?status=needs-agent');
  const unsent = await unsentFixes();
  if (args.json) return console.log(JSON.stringify({ rev, threads, unsentChecklistFixes: unsent }, null, 2));
  printThreads(threads);
  if (unsent.length) {
    console.log('Marked "needs fix" but not sent to you (context only, ' + unsent.length + '):');
    for (const f of unsent) console.log('   - [' + f.id + '] ' + f.text + (f.note ? ': ' + f.note : '') + (f.page ? '  (' + f.page + ')' : ''));
  }
}

switch (cmd) {
  case 'inbox':
    await inbox();
    break;

  case 'wait': {
    const deadline = Date.now() + (Number(args.timeout) || 600) * 1000;
    let { rev, threads } = await api('/threads?status=needs-agent');
    while (!threads.length && Date.now() < deadline) {
      const left = Math.max(1, Math.round((deadline - Date.now()) / 1000));
      await api('/wait?rev=' + rev + '&timeout=' + left);
      ({ rev, threads } = await api('/threads?status=needs-agent'));
    }
    if (args.json) console.log(JSON.stringify({ rev, threads, timedOut: !threads.length }, null, 2));
    else if (!threads.length) console.log('Nothing waiting (timed out). Run wait again.');
    else printThreads(threads);
    break;
  }

  case 'thread':
    console.log(JSON.stringify(await getThread(rest[0]), null, 2));
    break;

  case 'workdir': {
    const t = await getThread(rest[0]);
    console.log(workDir(t.id, args.root));
    break;
  }

  case 'reply': {
    const [id, status, ...words] = rest;
    const text = words.join(' ').trim();
    if (!id || !STATUSES.includes(status) || !text) {
      fail(1, 'Usage: review.mjs reply <thread-id> <' + STATUSES.join('|') + '> "text"');
    }
    const msg = await api('/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'agent', replyTo: id, status, text }),
    });
    console.log('Replied on ' + msg.replyTo + ' as ' + msg.status + '.');
    break;
  }

  default:
    fail(1, 'Usage: review.mjs <inbox|wait|thread|workdir|reply> …  (see binding.md)');
}
