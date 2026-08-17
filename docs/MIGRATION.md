# Lazy migration of the manual scenario library

The 37 pre-existing scenario files under `axiome-docs/manual-e2e/` convert to
Playwright specs **lazily — never in bulk** (FR36). Bulk back-porting would mean
authoring dozens of specs against features nobody is running, which is exactly the
"test written without the app" failure mode the strategy avoids.

## Conversion triggers (FR36)

A scenario file is converted only when:

1. **a story touches its feature area** — Workflow 4 step e authors the spec(s)
   for that story's `playwright`-tagged scenarios against the running slice; or
2. **its epic reaches Workflow 5** — step 3 converts any still-`manual` scenario
   for that epic and adds the cross-story `epic-*.spec.ts` flows.

Un-touched files stay valid as manual walkthroughs; nothing about them is
contradicted. An **untagged** scenario reads as `manual` (FR16) and is tagged the
next time its file is touched.

## Retag path — untestable headless (FR37)

If a scenario proves untestable headless (e.g. it needs real email delivery, a
human UX judgement, or a sponsor demo), it is **retagged `manual` with a stated
reason** rather than left as an unfulfilled `playwright` gap:

```
_automation:_ manual — local email is logged, not delivered; asserted by hand
```

`npm run migration-status` reports each file's `playwright` / `manual` /
`untagged` counts and **fails** if any `manual` scenario lacks a reason. The
coverage report (`npm run coverage`) separately flags a `playwright` scenario
with no spec as a **gap** — the two together keep the true migration state
visible, never a half-converted middle state pretending to be done.

## Pilot — one epic fully converted end-to-end (AC21)

**AXI-1260 (Automated E2E Testing) is the reference fully-converted epic**, proving
the strategy holds end-to-end:

- **Scenarios tagged** — `manual-e2e/AXI-1260-Automated-E2E-Testing.md`, all
  `automation: playwright`, referencing AC IDs.
- **Specs green** — the whole epic suite passes headless (`npm run epic-acceptance
  AXI-1260` → GREEN).
- **Epic flows automated** — `tests/AXI-1260/epic-toolchain.spec.ts` (the
  cross-story flow no single story owned).
- **Human residue < 10 min** — 0 `manual`-tagged scenarios in the epic; the
  acceptance figure's residue line is empty.

See [`VALIDATION.md`](VALIDATION.md) for the FR/NFR → story → mechanism map
(AC22).
