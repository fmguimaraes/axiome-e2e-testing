# Screenshot capture harness

Standing specification for `e2e/shots/`. Complete and self-contained: the
harness is built from this document. Per-shot requests are supplied separately
as a short brief and executed against these rules.

---

## Why this exists

Raw application screenshots are unusable in published material. A 1780px capture
placed in a ~1100px page section renders interface text at roughly 8px — nothing
is legible, and blurring or dimming the surroundings does not change that.

The fix is to **reduce information density in the capture itself** — fewer rows,
larger type, more padding, no application chrome — then capture at 2x. The
output is a real screenshot with the readability of an illustration.

Two output shapes:

- **Crop** — a single feature, captured by screenshotting a located element.
  Used inline beside body copy.
- **Frame** — a full viewport at reduced density. Used as a section hero.

Prefer a crop. A frame is justified only when the point being made is *where in
the product* something lives.

## Invariants

These are not per-shot decisions.

1. **No capture logic in product code.** All density and chrome overrides live
   in the injected stylesheet. Marketing output must not create maintenance
   surface in the web app. Stable test-id hooks are the sole permitted
   exception.
2. **Real UI only.** No redrawn mockups, no fabricated data, no illustrative
   fictions. Axiome sells auditability; a screenshot that misrepresents the
   product is a credibility failure, not a cosmetic one.
3. **Captures are regenerated, never patched.** If the UI changes, re-run. Never
   retouch a PNG by hand — a hand-edited capture cannot be reproduced and will
   silently rot.
4. **2x always.** Device scale factor of 2 on the browser context.
5. **Nothing confidential ships.** See Scrub registry.

---

## What to build

```
e2e/shots/
  capture.ts     Playwright script; a shot manifest drives everything
  shot.css       injected density and chrome overrides
  out/           generated PNGs (gitignored)
  README.md      this file
```

Plus a package script — `pnpm shots` or the repo equivalent — that runs the
capture over the whole manifest.

Reuse the existing `e2e` submodule's Playwright installation and authentication
artifact. Do not create a second auth path. Base URL and stored-auth path must
be overridable by environment variable, defaulting to the local dev server and
the existing auth state file respectively.

### Browser context

A single context, configured with: device scale factor 2; light colour scheme;
reduced motion; a default viewport of 1200×800; and the stored authentication
state loaded if present.

### Capture pipeline

Per shot, strictly in this order:

1. **Navigate** to the shot's route and wait for the network to go idle.
2. **Inject** the stylesheet as a style tag. It must be injected after
   navigation, never bundled into the app.
3. **Prep** — run the shot's optional interaction function, which performs
   whatever clicks are needed to reach the target state (opening a panel,
   switching a tab) and awaits the resulting element.
4. **Scrub** — apply the substitution registry to the live DOM. Walk text nodes
   with a tree walker and replace matches. Do not use `innerHTML` replacement;
   it will destroy event handlers and React's reconciliation.
5. **Settle** — await font loading readiness, because without it the 2x render
   silently falls back to system faces. Then force a chart reflow (see Traps).
   Then a short fixed delay.
6. **Screenshot** — if the shot names a clip selector, screenshot that located
   element; otherwise screenshot the viewport, not the full page.

Write output to `out/` as `<name>.png`.

### Shot manifest

Each entry carries:

| field | purpose |
|---|---|
| `name` | output filename |
| `path` | route to visit |
| `prep` | optional async interaction function to reach the target state |
| `clipSelector` | present → crop that element; absent → full viewport frame |
| `viewport` | derived from the target ratio; see Framing |
| `navCollapsed` | whether to collapse the left rail before capture. Per shot, not global — see Layout |

Ship the manifest empty. The first per-shot brief populates it.

### Stylesheet

Organised in four blocks, in this order:

**Determinism.** Disable all animations and transitions globally. Hide
scrollbars. Suppress text carets. Without this, consecutive runs differ.

**Chrome removal.** Hide the left navigation, internal role badges, and any
affordance that is meaningful to an operator but noise to a reader.

**Density.** Raise the root font size above the application default. Raise table
font size. Increase cell padding on both axes. Prevent cell text wrapping. Hide
column-count badges and similar micro-annotations that read as clutter at
illustration scale.

**Row trimming.** Reduce visible table rows to roughly six to eight using a
positional selector on the row elements. This is purely visual and touches no
data — provided the table is not virtualised.

Shot-specific rules go in a clearly commented block at the end. The four shared
blocks apply to every capture and must not be edited to solve a single shot's
problem.

---

## Reading a shot request

Requests arrive terse — a view, some states, a framing hint, on one line:

> Question + Assumptions popover open + user-created charts, wide

Parse it as three parts. Everything before the framing hint is **target view**
plus **state modifiers**, joined by `+`. The trailing hint is **framing**.

**Target view** — the first term names where to go. It is a product noun, not a
route. Resolve it against the application's routing yourself; never guess a URL
with a placeholder ID in it. If more than one route could match, ask.

**State modifiers** — each subsequent term names something that must be true on
screen before capture. Each becomes an action in the shot's prep function,
executed in the order written, each awaiting its result before the next. A
modifier is satisfied by driving the UI as a user would: click the control, wait
for the element. Never satisfy one by injecting DOM or forcing state.

**Framing** — the trailing hint names the **aspect ratio of the published
slot**, not a window size. `wide` does not mean a wide browser. A wide browser
produces a 4.5:1 letterbox with dead white below the content, and no crop
recovers a 16:10 image from it.

Derive the viewport from the ratio. Exports are 2400px wide at device scale
factor 2, so the viewport is always 1200 wide and the height follows:

| target slot | ratio | viewport |
|---|---|---|
| hero, carousel | 16:10.4 | 1200×780 |
| section panel | 16:9 | 1200×675 |
| teaser band | 2.4:1 | 1200×500 |
| differentiator tile | 520×360 | crop from a 16:10.4 master |

`crop` (or no hint) means the subject is a single element: capture it with a
clip selector at whichever viewport gives it a sensible surrounding, and trim
everything else hard.

Where framing is absent and no single element is obviously the subject, ask
rather than defaulting to a frame.

### Layout: wrap, nav state and anchored overlays

At a fixed 1200 viewport the only remaining lever over how cards lay out is the
left rail, which costs roughly 235px. Card grids wrap against a minimum card
width of about 340px, which puts the two states on opposite sides of a
threshold:

| nav | usable width | cards across |
|---|---|---|
| expanded | ~965 | 2 |
| collapsed | ~1130 | 3 |

So `navCollapsed` is a **layout decision, not a cleanliness one**, and it is
per shot. Choose it to make the card count divide evenly: four cards want two
across, six cards want three. A ragged final row with white beside the orphan
looks worse than the letterbox the ratio fix was meant to solve.

Two standing preferences, both learned rather than assumed:

- **Keep the rail expanded where the workspace itself is the subject.** The
  named surfaces down the left side are a visible inventory of product scope
  and do more persuasive work than the width they cost. Collapse it for shots
  whose subject is a single record, chart or listing.
- **Never capture the collapsed rail as icons-only.** Unlabelled glyphs read as
  chrome noise. Either expanded and labelled, or hidden entirely by the
  stylesheet.

**Anchored overlays.** A popover pinned to a control covers a fixed region of
the frame regardless of what is underneath it. Do not fight it: arrange the
content so the covered region holds the least valuable card. Where the product
offers an ordering control, use it to put a low-value tile under the overlay
before capturing.

Where a slot map calls for both an overlay-open and an overlay-closed variant,
shoot both from the same arrangement in one run rather than restaging.

### Worked expansion

The request above resolves to:

- **Route** — the workspace view of a question. The specific question is not
  named, so ask which one, or confirm a demo fixture is acceptable.
- **Prep, in order** — open the Assumptions control and await its popover; set
  the visualisation rail to its user-created filter and await the rail settling.
- **Shape** — `wide` names the hero ratio, so 1200×780, not a wide window.
- **Nav** — expanded. Four charts at 1200 need two across, and the rail is what
  puts them there. It also keeps the surface inventory in a hero frame.
- **Overlay** — the assumptions popover is anchored top-right and will cover
  that card. Order the charts so the top-right slot holds the least valuable
  one before capturing.
- **Stylesheet** — the four shared blocks, plus a shot-specific block. The
  popover and the chart grid are both competing for attention, so anything else
  in frame is scenery and gets trimmed hard.
- **Settle** — the chart grid is in frame, so the reflow step is load-bearing
  rather than incidental. Verify the charts, not just that the page rendered.
- **Open questions to raise before implementing** — which question fixture;
  whether an overlay-closed variant is also wanted from the same arrangement;
  whether anything in frame needs a scrub entry.

### Resolution rules

Infer freely: framing defaults, viewport sizes, trimming aggressiveness, which
stylesheet blocks apply, the order of prep actions.

Ask, always: which record or fixture to load when the request names a view but
not an instance; which control is meant when a modifier is ambiguous; whether
real data may be captured. Guessing here produces a plausible screenshot of the
wrong thing, which costs more to detect than to prevent.

---

## Procedure for a new capture

### 1. Discovery — in Chrome DevTools, before writing anything

Never write the stylesheet blind. Open the target view against local dev and
work in the Styles panel until the density is right.

Establish:

- **Selectors** for every element to be hidden, trimmed, or emphasised. If
  stable test-id hooks are missing, add them.
- **Whether any table in frame is virtualised.** Inspect whether the row
  container holds plain DOM rows, or whether rows carry inline transforms or
  absolute offsets. This determines the entire approach — see Traps.
- **Working font-size and padding values.** Iterate live; a browser round-trip
  per attempt is too slow any other way.

Report findings before implementing.

### 2. Implement

Add the manifest entry and any shot-specific stylesheet rules.

### 3. Verify

- Open the PNG at **the size it will be published at**, not full zoom. Body text
  in the target region must be comfortably legible.
- Confirm charts are not stretched, clipped, or rendered at pre-injection
  dimensions.
- Re-read the output for leaked identifiers.
- Re-run twice and compare. Output must be stable; instability means something
  async is unsettled.

---

## Scrub registry

Text substitutions applied to the live DOM before capture, held as a single
exported constant so the list is auditable in one place.

**Standing rule:** no tenant or institution names, no internal role badges, no
subject, sample, or patient identifiers, no staff names, no internal URLs or
IDs. Institutional relationships are not public until the counterparty has
agreed they are — publishing one early on a marketing site is a commercial
problem, not a design detail.

Current entries:

| find | replace | reason |
|---|---|---|
| `APHM-MIPP` | `Institut Clinique` | unannounced institutional relationship |
| `SUPER ADMIN` | *(empty)* | internal role badge |

Row-count labels of the form "44,666 rows · showing 1–20" must be recomputed or
removed whenever rows are trimmed, or the frame contradicts itself.

Extend this registry rather than hardcoding substitutions inside a shot's prep
function.

## Traps

**Virtualised tables.** Positional row trimming works only for plain DOM rows.
Where row heights are measured in JavaScript, a font-size change desynchronises
the computed offsets and rows overlap or gap. CSS cannot win that; the table
component needs a real density or max-rows prop. This crosses invariant 1 —
**ask before adding it.**

**Plotly.** Charts do not reflow when injected CSS resizes their container; they
render at stale dimensions inside a new box. Call Plotly's plot-resize API on
every plot element, guarded, then dispatch a window resize event as fallback.
Where plots were created without the responsive option, only the direct call
works.

**ReactFlow.** The same reflow problem with no external fix — its fit-view
method is not reachable from outside the component. Capture graphs at native
size and crop.

**Empty selectors.** A stylesheet rule matching nothing fails silently and yields
output that looks almost right. Verify each new selector resolves before
trusting the result.

## Quality bar

A capture ships when all of the following hold:

- regenerable from a clean checkout with only an auth state file as input
- no density or chrome-hiding code in the web app (test hooks excepted)
- text in the region of interest legible at intended display size
- charts correctly reflowed
- scrub registry applied; no identifiers present
- two consecutive runs produce equivalent output

## Ask before doing

- any change to a shared table or layout component
- any new dependency
- any change to the existing e2e authentication setup
- any capture of a view containing real, non-demo data
