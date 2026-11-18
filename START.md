# Start a UX review

**You are a coding agent.** The person you're working with copied this folder
into their project and pointed you here. They want to walk through their app
in the browser, tell you what to change from a chat panel, and have you fix
it while they keep going. Do the steps below in order, and keep your messages
to them short and non-technical.

Below, `<kit>` is this folder's path relative to the project root (usually
`ux-review`). Run every command **from the project root**.

## 1. Start the review

Run this **in the background**, because it keeps running for the whole review:

```bash
node <kit>/bin/ux-review.js up
```

It finds out how the project runs, starts the dev server if it isn't running,
starts the review in front of it, installs the `ux-walkthrough` skill into the
project, and opens the browser. Wait for a line that starts with `READY`, then
check it:

```bash
node <kit>/bin/ux-review.js status
```

Exit code 0 means it's up. If `up` stopped with a message instead, act on it:

| Message says | Do |
|---|---|
| `No node_modules` | Run the project's install (`npm install`, or the `pnpm`/`yarn`/`bun` one it names), then `up` again |
| `Couldn't work out how to run this project` | Start the project's dev server in the background yourself, then `up --target http://localhost:<its port>` |
| `did not answer` / `exited with code` | Read the last output it printed (full log: `.ux-review/dev.log`), fix the dev server if it's a quick fix, else tell the person what's wrong |
| `already running` | Fine. Use the URL it printed |

Don't try more than twice. If it still won't start, tell the person what you
saw in one or two sentences.

## 2. Tell the person

Say this, with the real URL from the `READY` line:

> Your review is open at **http://127.0.0.1:3997/** (use this address, not your
> usual one). The panel on the right has a **Chat** tab: tell me anything you
> want changed, and use **Pick element** to point at it. The **Checklist** tab
> has things worth checking. Mark anything that needs work and press **Send to
> agent**. I'll fix things as they come in and reply in the panel.

## 3. Run the walkthrough

Use the **ux-walkthrough** skill. `up` installed it into the project at
`.claude/skills/ux-walkthrough/` and `.agents/skills/ux-walkthrough/`. If your
agent doesn't load skills on its own, read
`.agents/skills/ux-walkthrough/SKILL.md` and follow it.

The skill waits for the person's messages, handles them one at a time, and
replies in the panel. Keep it going until they say they're done. While you
wait, run `wait` in the background if your agent supports that, so you
respond as soon as something arrives.

## 4. When they're done

```bash
node <kit>/bin/ux-review.js summary   # everything that was asked, answered and checked
node <kit>/bin/ux-review.js stop      # stops the review, and the dev server if up started it
```

Give them a short summary: what you changed, what's still open, and anything
you asked that they didn't answer. Don't commit. Ask whether they want you to.

## Rules

- Change only the project's own code, never this folder (`<kit>/`).
- Don't stop or restart a dev server you didn't start. `stop` only touches
  what `up` started.
- The `.ux-review/` folder in the project is scratch space: session, logs and
  reports. It ignores itself in git. Leave it alone.
