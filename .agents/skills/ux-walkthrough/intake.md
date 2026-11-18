# Intake

Find out what the reviewer is asking for, and whether you can see it on the
page under the same conditions they saw it.

**CRITICAL: Always write `report.md` to the work directory before you finish,
whatever the outcome. The next steps and the reply read it.**

**SCOPE: Intake only. No code search beyond what you need to classify, no fix.**

## Prerequisites

- **`threadId`** and **`workDir`** (`review.mjs workdir <threadId>`).
- The thread: `node <skill>/scripts/review.mjs thread <threadId>`.

## Step 1: Read the thread

Note:

- **The request**: what the reviewer wants changed, in one sentence of your
  own. For a checklist thread, the item (`check.text`) plus their note.
- **Where**: `context.url`, and `context.element` (label and selector) if they
  picked one.
- **Conditions**: `context.viewport`, `dpr` and `theme`. A layout bug at
  `390x844` may not exist at `1440x900`.
- **History**: earlier rounds. After **Still wrong**, the latest reviewer
  message is the new request, and the earlier fix is part of the picture.

## Step 2: Check for early exits

Write the reason code in `report.md`.

### `not-actionable`

A question, praise, or thinking out loud ("hmm, not sure about this blue").
Nothing asks for a change. Answer it in the reply.

### `missing-details`

You can't tell what to change: no element, a page with several candidates, or
"make it better" with no direction. Pick this only after you have read the
page. Often the page makes the request obvious.

### `out-of-scope`

The change can't be made from this repo: a third-party widget or embed, content
that comes from a CMS or an API, browser or OS chrome (native select popups,
autofill colours), or a business decision (prices, legal copy). Say who or
what owns it.

### `duplicate`

Another open thread asks for the same change. Name it.

**A vague request is not an early exit.** "This feels cramped" next to a
picked element is actionable: see it, then decide what "cramped" means in
the judge step.

## Step 3: See it

Look at the page as the reviewer saw it. Prefer, in order:

1. `node <skill>/scripts/capture.mjs <threadId> --out "$workDir/before"`. It opens
   `context.url` through the review server at the reviewer's viewport, DPR
   and theme, hides the review panel, and writes `page.png`, `element.png` (if
   an element was picked) and `capture.json` (the element's box, computed
   styles, and whether the selector still matches). Exit code 2 means
   Playwright or the server isn't available. Go on with option 2 or 3.
2. Your own browser tool, at the same viewport and colour scheme.
3. The source alone, if neither works. Say so in the report.

Then decide:

- **confirmed**: you can see what the reviewer describes.
- **not-seen**: you looked at the same page, size and theme and it isn't
  there. Note exactly what you saw, so the reply can ask the right question.
  If the selector no longer matches, the page may have changed since. Say that.

One look at the reviewer's conditions is enough. If the request is about
responsiveness, add one look at another width. Deeper digging belongs in the
locate step.

## Step 4: Write `report.md`

This is context for the next step, not a message to the reviewer. Include:

- The thread id, the request in one sentence, the reviewer's words quoted.
- URL, element (label and selector), viewport, DPR, theme.
- How you looked (capture, browser or source only) and paths to the images.
- What you saw, and whether the selector matched.
- The outcome: `confirmed`, `not-seen` or `skipped:<reason>`, and why.
