# The review binding

The contract between the review panel (the reviewer's side) and you (the
agent's side). The review server is the only writer of the review state. You
read threads and post replies over HTTP. `scripts/review.mjs` wraps every call.

The server URL is `$UX_REVIEW_URL`, or `http://127.0.0.1:3997` if that isn't set.

## Threads

Every message the reviewer sends without replying to something starts a
thread. Checklist items they send become threads too, with `check` set.

```json
{
  "id": "m-lx2k9a-4f1c",
  "status": "needs-agent",
  "context": {
    "url": "/pricing?plan=pro",
    "title": "Pricing · Example",
    "viewport": "390x844",
    "dpr": 3,
    "theme": "dark",
    "element": { "selector": "#plans > article:nth-of-type(2) > h2", "label": "Enthusiast", "tag": "h2" }
  },
  "check": { "id": "polish/alignment", "text": "Things that should line up do line up", "result": { "status": "fix", "note": "…" } },
  "messages": [
    { "id": "m-lx2k9a-4f1c", "from": "reviewer", "text": "The plan name is cut off", "at": "…" },
    { "id": "m-…", "from": "agent", "status": "fixed", "text": "…", "at": "…", "replyTo": "m-lx2k9a-4f1c" },
    { "id": "m-…", "from": "reviewer", "ack": "wrong", "text": "Still cut at 390 wide", "at": "…", "replyTo": "m-lx2k9a-4f1c" }
  ]
}
```

- `context` is captured when the thread starts: the page, window size, pixel
  ratio and colour scheme, and the element the reviewer picked, if any.
  `element.selector` is a `querySelector` path built from the live DOM. It
  matches the rendered page, not necessarily the source.
- `check` is there only for checklist threads.
- A reviewer reply with `"ack": "good"` resolves the thread. `"ack": "wrong"`
  reopens it.

## Thread status (computed by the server)

| Status | Meaning | Your move |
|---|---|---|
| `needs-agent` | The reviewer spoke last | Handle it |
| `working` | You said you're on it | Finish it |
| `recheck` | You replied `fixed` | Wait for the reviewer |
| `question` | You asked something | Wait for the reviewer |
| `resolved` | Confirmed good, or closed by `wontfix` / `note` | Nothing |

Act only on `needs-agent` threads, and on `working` threads you started.

## Reply statuses

`working` · `fixed` · `question` · `wontfix` · `note`. [SKILL.md](SKILL.md)
"Output" says which outcome maps to which.

## Commands

```bash
node scripts/review.mjs inbox [--json]          # threads with status needs-agent
node scripts/review.mjs wait [--timeout 600]    # block until the review changes, then print the inbox
node scripts/review.mjs thread <id>             # one thread as JSON
node scripts/review.mjs workdir <id>            # create .ux-review/<id>/ and print its path
node scripts/review.mjs reply <id> <status> "text"
node scripts/find-source.mjs <id> [--root .]    # rank source files for the thread's element
node scripts/capture.mjs <id> [--out DIR]       # screenshot at the reviewer's viewport (needs Playwright)
```

Exit codes for every script: `0` done, `1` bad input or a refused request, `2`
infrastructure (the review server or the site isn't reachable, or Playwright
is missing).

## HTTP

| Method and path | |
|---|---|
| `GET  /__review/api/threads?status=needs-agent` | `{ rev, threads: [...] }` |
| `GET  /__review/api/threads/<id>` | `{ rev, thread }`. Any message id in the thread works. |
| `GET  /__review/api/wait?rev=N&timeout=S` | Returns when the state moves past revision `N` |
| `POST /__review/api/messages` | `{ "from": "agent", "replyTo": "<id>", "status": "fixed", "text": "…" }` |
| `GET  /__review/api/summary` | The whole review as Markdown |

Writes need `Content-Type: application/json`. The server refuses them from
other browser origins.
