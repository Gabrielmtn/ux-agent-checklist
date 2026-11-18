# Fix

Make the smallest change that meets the brief, and check it the way the
reviewer will.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome, including when the fix fails.**

**SCOPE: Don't commit or push. Don't touch files outside the site's repo.**

## Prerequisites

- **`threadId`**, **`workDir`**, and `report.md` from the earlier steps.

## Step 1: Read the verdict

Read `report.md`.

- Verdict `conflict` or `intended`: append `FIX SKIPPED: <verdict>` and
  return `fixed: false`.
- Confidence `low` anywhere: append `FIX SKIPPED: low confidence` and
  return `fixed: false`.
- Otherwise, continue. If this will take more than a minute, reply first:

  ```bash
  node <skill>/scripts/review.mjs reply <threadId> working "Moving the nav spacing into the header tokens."
  ```

## Step 2: Make the change

- Change only what the brief needs, at the layer from the locate step. No
  refactors, no drive-by fixes. Mention other things you noticed in the report.
- Use the site's own means: existing tokens, variants and utility classes
  before new values, and new values before `!important`.
- Copy changes: match the voice of the copy around it.
- Keep it reversible. The reviewer may say **Still wrong**.
- If the reason isn't obvious from the code, add a short comment.

## Step 3: Check it

1. Let the site's dev server reload. Hot reload usually does it, so don't
   restart it yourself. If it needs a restart, ask the reviewer in the reply.
2. Look again under the reviewer's conditions:
   `node <skill>/scripts/capture.mjs <threadId> --out "$workDir/after"`, or your
   browser at the same viewport and theme. Compare with `before/`.
3. Check one condition the reviewer didn't see: another width for layout
   changes, the other theme for colour changes, keyboard for interaction changes.
4. If you changed a shared token or component, look at one other place that uses it.
5. Run the site's checks for what you touched: lint, typecheck and the tests for
   that component. Never run a full end-to-end suite unprompted.

If the fix causes a new problem, change the fix. Don't hand the reviewer a
known regression.

## Step 4: Clean up

1. Run `git status` and `git diff` in the site's repo. Revert anything that
   isn't part of the fix: debug output and scratch files. Leave `.ux-review/`
   alone, because it's ignored.
2. Stop any process you started (a browser, a watcher). Leave the review
   server and the dev server running.

## Step 5: Append to `report.md`

- What changed and why, at which layer.
- The full `git diff` of the fix.
- The checks: before and after captures, the extra condition, lint, type and test results.
- `fixed: true` or `false`, and if false, what blocked it and the choice the
  reviewer has to make.
- The reply text you will send: two or three sentences, which files changed, and how to see it.
