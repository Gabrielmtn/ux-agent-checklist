'use strict';
// The agent side: the binding's thread endpoints, the skill's scripts, and install-skill.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createServer } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, '.agents', 'skills', 'ux-walkthrough', 'scripts');

function run(file, args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args], { env: Object.assign({}, process.env, env), cwd: cwd || ROOT }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function start() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-skill-'));
  const server = createServer({
    static: path.join(ROOT, 'example-site'), outDir, rootDir: ROOT,
    checklists: ['checklists/default.json'], names: { reviewer: 'You', agent: 'Agent' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (p, body) => fetch(base + '/__review/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { server, base, post, env: { UX_REVIEW_URL: base } };
}

test('GET /threads filters by status; GET /threads/<id> takes any message id in the thread', async (t) => {
  const { server, base, post } = await start();
  t.after(() => server.close());
  await post('/messages', { id: 'm1', from: 'reviewer', text: 'a' });
  await post('/messages', { id: 'm2', from: 'reviewer', text: 'b' });
  await post('/messages', { id: 'a1', from: 'agent', replyTo: 'm2', text: 'done', status: 'fixed' });
  await post('/checks', { id: 'polish/alignment', status: 'fix', note: 'logo is off' });
  await post('/messages', { id: 'm3', from: 'reviewer', text: 'Checklist: …', check: 'polish/alignment' });

  const waiting = await (await fetch(base + '/__review/api/threads?status=needs-agent')).json();
  assert.deepStrictEqual(waiting.threads.map((x) => x.id), ['m1', 'm3']);
  const m3 = waiting.threads.find((x) => x.id === 'm3');
  assert.strictEqual(m3.check.text, 'Things that should line up do line up');
  assert.strictEqual(m3.check.result.note, 'logo is off');

  const byReply = await (await fetch(base + '/__review/api/threads/a1')).json();
  assert.strictEqual(byReply.thread.id, 'm2');
  assert.strictEqual(byReply.thread.status, 'recheck');
  assert.strictEqual((await fetch(base + '/__review/api/threads/nope')).status, 404);
});

test('review.mjs: inbox, reply, and exit codes 1 (bad input) and 2 (server down)', async (t) => {
  const { server, post, env } = await start();
  t.after(() => server.close());
  await post('/messages', { id: 'm1', from: 'reviewer', text: 'Make the CTA bigger', context: { url: '/' } });

  const inbox = await run(path.join(SCRIPTS, 'review.mjs'), ['inbox', '--json'], env);
  assert.strictEqual(inbox.code, 0, inbox.stderr);
  assert.deepStrictEqual(JSON.parse(inbox.stdout).threads.map((x) => x.id), ['m1']);

  const bad = await run(path.join(SCRIPTS, 'review.mjs'), ['reply', 'm1', 'done', 'text'], env);
  assert.strictEqual(bad.code, 1);

  const ok = await run(path.join(SCRIPTS, 'review.mjs'), ['reply', 'm1', 'fixed', 'Bigger', 'now.'], env);
  assert.strictEqual(ok.code, 0, ok.stderr);
  const after = JSON.parse((await run(path.join(SCRIPTS, 'review.mjs'), ['thread', 'm1'], env)).stdout);
  assert.strictEqual(after.status, 'recheck');
  assert.strictEqual(after.messages[1].text, 'Bigger now.');

  const down = await run(path.join(SCRIPTS, 'review.mjs'), ['inbox'], { UX_REVIEW_URL: 'http://127.0.0.1:9' });
  assert.strictEqual(down.code, 2);
});

test('review.mjs workdir makes a self-ignoring .ux-review/<id>/', async (t) => {
  const { server, post, env } = await start();
  t.after(() => server.close());
  await post('/messages', { id: 'm1', from: 'reviewer', text: 'x' });
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-site-'));
  const r = await run(path.join(SCRIPTS, 'review.mjs'), ['workdir', 'm1'], env, site);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(fs.realpathSync(r.stdout.trim()), fs.realpathSync(path.join(site, '.ux-review', 'm1')));
  assert.match(fs.readFileSync(path.join(site, '.ux-review', '.gitignore'), 'utf8'), /^\*$/m);
});

test('find-source ranks the file that renders the picked element first', async (t) => {
  const { server, post, env } = await start();
  t.after(() => server.close());
  await post('/messages', {
    id: 'm1', from: 'reviewer', text: 'Plan name is cut off',
    context: { url: '/plans.html', element: { selector: 'body > main > div.plans > article.plan:nth-of-type(2) > h2', label: 'Enthusiast-Connoisseur-Deluxe', tag: 'h2' } },
  });
  const r = await run(path.join(SCRIPTS, 'find-source.mjs'), ['m1', '--root', path.join(ROOT, 'example-site'), '--json'], env);
  assert.strictEqual(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.results[0].file, 'plans.html');
  assert.ok(out.results.some((x) => x.file === 'style.css'), 'the stylesheet with .plan rules is a lead too');
});

test('install-skill copies the skill into .agents/skills and .claude/skills, and re-running updates it', async () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'uxr-site-'));
  const cli = path.join(ROOT, 'bin', 'ux-review.js');
  let r = await run(cli, ['install-skill', site]);
  assert.strictEqual(r.code, 0, r.stderr);
  for (const d of ['.agents', '.claude']) {
    const base = path.join(site, d, 'skills', 'ux-walkthrough');
    for (const f of ['SKILL.md', 'binding.md', 'intake.md', 'locate.md', 'judge.md', 'fix.md', 'scripts/review.mjs']) {
      assert.ok(fs.existsSync(path.join(base, f)), d + ' is missing ' + f);
    }
  }
  const stale = path.join(site, '.claude', 'skills', 'ux-walkthrough', 'stale.md');
  fs.writeFileSync(stale, 'old');
  r = await run(cli, ['install-skill', site, '--to', 'claude']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(stale));
});

test('every step file has the same shape', () => {
  const dir = path.join(ROOT, '.agents', 'skills', 'ux-walkthrough');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: ux-walkthrough\r?\ndescription: .+\r?\n---/);
  for (const step of ['intake', 'locate', 'judge', 'fix']) {
    const md = fs.readFileSync(path.join(dir, step + '.md'), 'utf8');
    assert.match(skill, new RegExp('\\[' + step + '\\.md\\]\\(' + step + '\\.md\\)'), 'SKILL.md links ' + step);
    assert.match(md, /\*\*CRITICAL:/, step + ' has a CRITICAL line');
    assert.match(md, /\*\*SCOPE:/, step + ' has a SCOPE line');
    assert.match(md, /## Prerequisites/, step + ' has prerequisites');
    assert.match(md, /## Step \d+: (Write|Append to) `report\.md`/, step + ' ends by writing report.md');
  }
});
