# Judge

Decide whether to make the change as asked, and how, before you touch anything.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome.**

**SCOPE: Judging only. No fix.**

## Prerequisites

- **`threadId`**, **`workDir`**, and `report.md` from the earlier steps.

## The rule: the reviewer sets the goal, the site sets the means

The reviewer decides *what* should be different, so don't argue taste. The
site decides *how*: its tokens, components and conventions, and the standards
it has to meet. A fix that meets the brief by breaking the system ("make this
one button 13px bigger" with a hard-coded value) gets a bad verdict.

Check, in this order:

1. **The site's own rules.** `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, a
   design-system folder, token files, Storybook stories. Quote the rule.
2. **Standards.** For accessibility claims, WCAG 2.2 AA: contrast 4.5:1 for
   body text and 3:1 for large text and UI parts, targets at least 24×24 CSS px,
   visible focus, and labels. Quote the success criterion.
3. **The rest of the review.** Another thread that asks for the opposite, or a
   checklist item marked **pass** that this change would undo
   (`review.mjs inbox --json` and `/__review/api/summary` show both).

## Step 1: Restate the change

From `report.md`, write the change you would make in one line, at the right
layer: "Raise `--space-nav` from 4px to 12px" rather than "add padding to the
About link".

## Step 2: Look for intent

Do not assume the current state is an accident, or that it was chosen.

- **Code comments** that say "on purpose", "intentionally" or "keep at …".
- **Git history.** Run `git log -L` on the lines involved, or `git log -S`
  for the value. A commit that explains the trade-off counts as a decision.
- **The design system.** If the value is a token used everywhere, changing
  it is a system-wide change. That's fine when the reviewer asked for one, and
  a conflict when they asked about one spot.

## Step 3: Decide

- **`change`**: the change meets the brief within the site's rules, or the
  site has no rule about it.
- **`conflict`**: the only way to meet the brief breaks a site rule, a
  standard, another thread, or a passed checklist item. Quote both sides, and
  give the reviewer the options (for example: change the token everywhere, or
  add a variant).
- **`intended`**: the current behaviour is a recorded decision (a comment, a
  commit, a design doc). Quote it. The reviewer may still want it changed, so
  ask them. Don't refuse.
- **`unclear`**: no rule either way, and the change is small and easy to
  undo. Go ahead and say what you assumed. If it's big or hard to undo, use
  `conflict` and ask.

## Step 4: Confidence

- **high**: a quoted rule, criterion or comment settles it.
- **medium**: good evidence with some doubt.
- **low**: mostly inference.

## Step 5: Append to `report.md`

- The change in one line, at the right layer.
- Verdict: `change`, `conflict`, `intended` or `unclear`.
- Confidence.
- Evidence: the rules, WCAG criteria, comments and commit SHAs, quoted. Other
  threads or checklist items involved.
- For `conflict` and `intended`: the options to offer the reviewer.
