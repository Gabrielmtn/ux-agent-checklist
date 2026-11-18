# AGENTS.md

> **Were you asked to start a UX review of a project this folder was copied
> into?** Stop here and follow [START.md](START.md). This file is about
> working on the kit itself.

Instructions for any coding agent working on the kit. `CLAUDE.md` imports this file.

## What this is

A UX walkthrough kit. A reviewer clones it, points it at their site, and walks
through the site with a review panel on top: a chat to the coding agent and an
editable checklist. The agent answers with the `ux-walkthrough` skill.

There are two sides, and every file belongs to one of them:

| Side | Who runs it | Lives in |
|---|---|---|
| **Reviewer** | A person, in the browser (started by their agent via `START.md` → `up`) | `bin/`, `server/`, `client/`, `checklists/`, `review.config.json` |
| **Agent** | A coding agent, in the site's repo | `.agents/skills/ux-walkthrough/` |

They meet only at the **review binding**: the HTTP API and the thread format
in [.agents/skills/ux-walkthrough/binding.md](.agents/skills/ux-walkthrough/binding.md).
That file is the contract. Change it first, then both sides.

## Repo layout

```
.agents/skills/ux-walkthrough/   the agent side; copied into a site with `install-skill`
  SKILL.md                       orchestrator: rules, input, steps, output
  binding.md                     the contract: threads, statuses, commands, HTTP
  intake.md locate.md            one file per step, each with the same shape:
  judge.md fix.md                  CRITICAL line, SCOPE line, prerequisites, numbered steps, "Append to report.md"
  scripts/                       zero-dependency clients for the binding (+ capture.mjs, optional Playwright)
START.md                         the bootstrap an agent is pointed at in a project the kit was copied into
bin/ux-review.js                 CLI: up, status, stop, serve, summary, install-skill; agent commands delegate to the skill's scripts
server/up.js                     `up`: find the project, detect its framework, start or reuse its dev server, write .ux-review/session.json
server/index.js                  proxy or static serving, panel injection, the binding's HTTP API, SSE
server/store.js                  state, merging, threads, the review/ files
client/panel.js                  the injected panel (plain JS, shadow root, no build step)
checklists/*.json                checklist templates
example-site/                    a practice site with deliberate UX problems
test/*.tests.cjs                 node:test suites (named so a host project's Jest or Vitest won't pick them up)
```

A new agent workflow is a new folder under `.agents/skills/<name>/` with the
same shape: a `SKILL.md` orchestrator, one Markdown file per step, and
`scripts/` for anything a step runs.

## Architecture

- **One writer.** The review server owns `review/` (`state.json`, `review.md`,
  `events.ndjson`). The panel and agents write only through the API. Writes are
  idempotent by message id, and checklist results merge newest-first by
  `updatedAt`, so retries and offline queues are safe.
- **Thread status is computed on the server** (`threadStatus` in
  `server/store.js`) and served by `GET /__review/api/threads`. Clients don't
  recompute it, so the CLI, the skill scripts and the panel's badges agree.
  (The panel recomputes it only for unsent optimistic messages.)
- **The site is never modified by the kit.** The panel is injected into HTML
  responses only. Everything the kit serves lives under `/__review/`.
- **Checklist ids are stable**: `<section id>/<item id>`, or a hash of the text
  when an item has no id. Results are keyed by id, never by position.

## Tests

```bash
npm test                 # all node:test suites, a few seconds
npm run example          # the practice site with the panel, at http://127.0.0.1:3997/
```

Add a test for every change to the binding or the store. Server tests boot a
real server on port 0. `up` tests build throwaway projects with the kit copied
inside, because that is how people use it.

The kit has to stay safe to drop into any project: no files a host's test
runner, linter or bundler would pick up by default, and nothing written outside
`ux-review/`, `.ux-review/` and the installed skill folders.

## Code style

- **Zero runtime dependencies.** Node 18+ built-ins only, so `git clone` and
  `npm start` just work. `capture.mjs` is the one exception: it loads
  Playwright from the *site's* repo if it's there, and exits 2 if it isn't.
- CommonJS in `bin/`, `server/` and `test/`. ES modules in skill scripts (they
  get copied into repos of any kind). Plain browser JS in `client/`.
- The panel renders inside a shadow root and never names an agent or product.
  The labels come from `names` in the config.
- Skill Markdown: short sentences, numbered steps, named outcomes in
  `code`, and every outcome maps to a reply status in SKILL.md "Output".

## Out of scope unless asked

- A hosted or multi-user mode. The server listens on 127.0.0.1 for one reviewer.
- Calling a model API from the kit. The agent is whatever the reviewer runs.
- Auto-committing fixes. The reviewer commits.
- A layout linter, a screenshot runner for every state, or a hosted demo.
