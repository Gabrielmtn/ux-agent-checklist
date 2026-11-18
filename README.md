# UX review kit

Walk through your website with a review panel docked on top of it. Tell your
coding agent what to change in a **chat**, pointing at the exact element you mean.
Work through a **checklist** you can edit. The agent fixes things in your code
while you keep reviewing, and its replies show up in the panel.

## Start in one message

Works with any coding agent that has a terminal: Claude Code, Cursor, Windsurf,
Codex, Copilot's agent mode, and others. Open your project in it and paste:

> Download the UX review kit from https://github.com/Gabrielmtn/ux-agent-checklist
> into a folder called `ux-review` in this project (a plain copy, not a git
> submodule: clone it with `--depth 1`, then delete `ux-review/.git`). Then read
> `ux-review/START.md` and start a UX review of this app.

Or copy the folder in yourself: on the
[repo page](https://github.com/Gabrielmtn/ux-agent-checklist) choose
**Code → Download ZIP**, unzip it, rename the folder to `ux-review`, and drag it
into your project. Then paste just:

> Read `ux-review/START.md` and start a UX review of this app.

The agent starts everything and opens your browser. You walk through your app,
type what you want changed into the panel, and the agent fixes it and replies
there.

**What happens under the hood:** `node ux-review/bin/ux-review.js up`
- works out how your project runs: Next.js, Vite, Astro, SvelteKit, Remix,
  Nuxt, Angular, Create React App, Gatsby, Parcel, Eleventy, or plain HTML
- uses your dev server if it's already running, and starts it if it isn't
- starts the review in front of it, installs the agent's skill, and opens the browser

`ux-review/` doesn't touch your app's code or build. The panel is added only to
pages served through the review address, so it never ships. The folder has no
dependencies to install, and its own `.gitignore` keeps review data out of
your commits. Commit the folder if you want teammates to have it, or delete it
when you're done.

- **Zero dependencies.** Node 18 or newer.
- **Works with any coding agent** that can run a shell command. The agent side
  is a skill, [`ux-walkthrough`](.agents/skills/ux-walkthrough/SKILL.md).

## Running it by hand

From your project, with the kit copied in as `ux-review/`:

```bash
node ux-review/bin/ux-review.js up        # detect, start, open; prints READY <url>
node ux-review/bin/ux-review.js status    # running? how many requests are waiting?
node ux-review/bin/ux-review.js stop      # stop the review, and the dev server if up started it
```

Open the `READY` address (it starts at **http://127.0.0.1:3997/**), not your dev
server's own port. Useful flags: `--target http://localhost:5173` to skip
detection, `--static dist` for a folder of built files, `--no-open`, and
`--port 4000`.

You can also keep the kit on its own and point it at a project:
`npm start -- --site ../my-app`. Or skip detection entirely with
`npm run serve -- --target http://localhost:5173`.

To try it without your own site, run `npm run example`. It serves a small
practice site in `example-site/` that has a few UX problems planted in it.

## The agent side

`up` installs the skill for you. To install it on its own (for example, when
the kit lives outside the project), run:

```bash
node ux-review/bin/ux-review.js install-skill ../my-site
```

This copies `.agents/skills/ux-walkthrough/` into `../my-site/.agents/skills/`
(the cross-agent convention) and `../my-site/.claude/skills/` (Claude Code).
Pass `--to agents` or `--to claude` for only one. Running it again updates both.
Then ask your agent:

> Run the ux-walkthrough skill. A review is running.

The skill works one thread at a time, in four steps. Each step writes to
`.ux-review/<thread>/report.md` in your site's repo, a scratch folder that
ignores itself in git:

| Step | File | Ends with |
|---|---|---|
| 1. Intake | [intake.md](.agents/skills/ux-walkthrough/intake.md) | `confirmed`, `not-seen`, or `skipped:<reason>` |
| 2. Locate | [locate.md](.agents/skills/ux-walkthrough/locate.md) | files, a `layer` (styles, tokens, copy, …), confidence |
| 3. Judge | [judge.md](.agents/skills/ux-walkthrough/judge.md) | `change`, `conflict`, `intended`, `unclear` |
| 4. Fix | [fix.md](.agents/skills/ux-walkthrough/fix.md) | `fixed: true/false`, checked under the reviewer's own viewport and theme |

Each outcome maps to one reply on the thread (`fixed`, `question`, `wontfix` or
`note`), so you always get an answer, even when the answer is a question. You
set the goal. The skill decides how to make the change using your site's own
tokens, components and `AGENTS.md`, and asks you when the two conflict. It
never commits.

The skill needs only the review server. For screenshots at your exact
viewport it uses Playwright if your site's repo has it
(`npm i -D playwright && npx playwright install chromium`). Otherwise it uses
the agent's own browser, or reads the source.

**Without the skill**, any agent can drive the same binding by hand from the kit folder:

```bash
npm run inbox                                       # what's waiting
npm run wait                                        # block until something is
npm run reply -- m-lx2k9a-4f1c fixed "Bumped the nav links to 15px (header.css). Reload to see."
```

The contract (thread format, statuses, HTTP API) is in
[binding.md](.agents/skills/ux-walkthrough/binding.md).

## Using the panel

**Chat.** Type what you want changed and press Enter. Each message carries the
page, window size, pixel ratio and colour scheme. **Pick element** lets you click
anything on the page to attach it (a CSS selector and a readable label), so the
agent knows exactly what you mean.

Each message starts a thread, and the thread shows what it's waiting on:

| Badge | Meaning |
|---|---|
| Waiting for agent | You spoke last |
| Agent working | The agent has picked it up |
| Fixed: please recheck | Look again, then press **Looks good** or **Still wrong…** |
| Agent has a question | Reply on the thread |
| Resolved | Done |

Hover or click an element chip to highlight that element on the page.

**Checklist.** Mark each item **✓ passes**, **! needs fix** or **– not applicable**.
Click the active mark again to clear it. A "needs fix" item takes a note and has
a **Send to agent** button that turns it into a chat thread. Add your own items
to any section, or whole new sections, from the panel. They're saved with the review.

**Controls.** Swap sides, hide for 5 seconds (for a clean look at the page), copy
the summary, minimise to a pill (**Alt+Shift+R** toggles). Drag the inner edge to
resize. Below 720 px wide the panel becomes a bottom sheet.

**Offline.** If the review server stops, the panel says so and keeps your changes
in the browser. They're sent when it comes back, so nothing is lost.

## Checklists

Checklists are JSON files in `checklists/`. List the ones you want in `review.config.json`.
They're merged in order, and sections with the same `id` combine.

```json
{
  "title": "Checkout",
  "sections": [
    {
      "id": "checkout",
      "title": "Checkout",
      "items": [
        { "id": "total-visible", "text": "The total is visible before the last step", "hint": "Including shipping and tax." },
        { "text": "Payment errors keep the form filled in" }
      ]
    }
  ]
}
```

Give items an `id` if you might reword them later. Without one, the id comes from
the text, so rewording an item resets its result. Results are stored by id, never
by position, so adding or reordering items doesn't shuffle them. Edits to a
template show up on the next page reload.

Keep sections to 3–5 specific items. A long generic list gets skipped.

## Configuration

`review.config.json` (command-line flags override it):

| Key | Flag | Default | |
|---|---|---|---|
| `target` | `--target URL` | none (`up` detects it) | Dev server to sit in front of |
| `static` | `--static DIR` | | Serve a folder instead of proxying |
| `spa` | `--spa` | `false` | Serve `index.html` for unknown paths (static mode) |
| `port` | `--port N` | `3997` | |
| `host` | `--host H` | `127.0.0.1` | Change only if you know you need to |
| `checklists` | `--checklist F` (repeatable) | `["checklists/default.json"]` | |
| `outDir` | `--out DIR` | `review` | Where the review files are written |
| `names.reviewer`, `names.agent` | | `You`, `Agent` | Labels in the chat |

## What gets written

| File | |
|---|---|
| `review/review.md` | Readable summary: what's waiting on the agent, checklist results (answered items only), the full conversation |
| `review/state.json` | Everything, machine-readable |
| `review/events.ndjson` | One line per new message or checklist change, append-only, for agents that prefer to `tail -f` |

`review/` is git-ignored. Delete it to start a fresh review.

## Good to know

- **Dev only.** In proxy mode the kit removes `Content-Security-Policy` and
  `X-Frame-Options` headers and the `Secure` flag on cookies, so the panel can load
  over plain `http://127.0.0.1`. It listens on 127.0.0.1 only, accepts writes only
  as JSON from its own origin, caps request bodies at 1 MB, and refuses paths
  outside the served folder.
- **WebSockets** (hot reload, for example) are passed through to the target.
- **Absolute URLs** in your app that point at the dev server's own origin bypass
  the proxy. Those pages won't have the panel.
- **Focus traps.** If your app traps focus in modals, exempt the panel so you can
  type in it while a modal is open. The panel's host element carries
  `data-review-ui`, and `window.uxReview.isReviewElement(el)` is available too.
- **Keys typed in the panel** don't reach your app's keyboard shortcuts.
- The panel lives in a shadow root, so your CSS and the panel's can't affect each other.

## Development

```bash
npm test          # node:test, no dependencies
npm run example   # the practice site with the panel
```

| Path | |
|---|---|
| `.agents/skills/ux-walkthrough/` | The agent side: `SKILL.md`, one file per step, `binding.md`, `scripts/` |
| `START.md` | What an agent follows to start a review in your project |
| `bin/ux-review.js` | CLI: `up`, `status`, `stop`, `serve`, `summary`, `install-skill`, plus the agent commands |
| `server/up.js` | Project and framework detection, dev server start/reuse, session file |
| `server/index.js` | Proxy, static serving, injection, the binding's HTTP API, SSE |
| `server/store.js` | State, merging, threads, `review/` files |
| `client/panel.js` | The injected panel (plain JS, no build step) |
| `checklists/` | Checklist templates |
| `example-site/` | Practice site with deliberate UX problems |
| `reference/` | The original in-app tool this grew out of, and its review |

See [AGENTS.md](AGENTS.md) for how the pieces fit and the rules for changing them.