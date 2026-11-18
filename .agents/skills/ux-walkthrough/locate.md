# Locate

Find the code that produces what the reviewer is pointing at.

**CRITICAL: Always read `report.md` and append to it before you finish,
whatever the outcome.**

**SCOPE: Locating only. No fix.**

## Prerequisites

- **`threadId`**, **`workDir`**, and `report.md` from the intake step.

## Step 1: Read the intake

Read `report.md`. If the outcome was not `confirmed`, append
`LOCATE SKIPPED: <outcome>` and return `confidence: null`.

## Step 2: Find candidate files

```bash
node <skill>/scripts/find-source.mjs <threadId> --root <site repo>
```

It searches the site's source (skipping `node_modules`, build output and
`.git`) for what the rendered element gives away: its id, `data-testid`,
class names, the label text, and the route of `context.url`. It prints the
files ranked by how many of those they contain, with matching lines. Treat
the output as leads, not answers:

- **Generated class names** (CSS modules, Tailwind JIT hashes, styled-components)
  won't match the source. Search for the text or the component instead.
- **The label text** may come from a translation file. Follow the key back to
  the component.
- **The route** (`/pricing`) usually maps to a page, route or template file.
  Check the framework's routing convention.

## Step 3: Find the layer

Name where the change belongs. That's often not where the symptom shows:

| Symptom | Start in | `layer` |
|---|---|---|
| Wrong words, tone, labels, error messages | Templates, components, translation files | `copy` |
| Spacing, size, colour, alignment, overflow on one element | The component's styles | `styles` |
| The same problem everywhere (all buttons, all headings) | Design tokens, theme, global CSS | `tokens` |
| Breaks only at some widths | Media queries, container queries, layout components | `responsive` |
| Missing or wrong element, wrong order, wrong structure | Templates and components | `markup` |
| Wrong state: loading, empty, error, disabled, focus | Component logic, event handlers, data fetching | `behaviour` |
| Goes to the wrong place, dead link, wrong 404 | Router, link targets, redirects | `routing` |
| Keyboard, focus order, labels, contrast, alt text | Markup and styles, often both | `a11y` |
| Images, icons, fonts | Asset files and their references | `assets` |
| Comes from a dependency's own component | The props or theme you pass it, else that package | `upstream:<package>` |

A request that touches several layers (a contrast fix in the tokens that the
button also overrides) lists them all, main one first.

## Step 4: Confirm it

Prove that the code you found renders the element: the selector's structure
matches the markup, the computed styles in `capture.json` match the
declarations, or a temporary visible change shows up on reload. **Remove any
temporary change right away.** Only revert the lines you added. Never
`git checkout` a whole file, because the reviewer may have edits of their own
in it.

## Step 5: Append to `report.md`

- The files and line numbers, and what each one contributes.
- `layer` (one, or several with the main one first).
- Other places that use the same code. A token change reaches every user of the token.
- Confidence: `high` (proved in Step 4), `medium` (strong match, not proved),
  `low` (guesses). With `low`, write the question that would settle it.
