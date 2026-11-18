# AXI-2647 — ADR-002 Acceptance Tests & Rehearsal Rewrite — Results

**Date:** 2026-11-18
**Stack:** w5val — front `caf0cfa7` (main, after AXI-2645 merge), back `d21a235e`, API `:3001`, front `:5174`
**Spec:** `tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts`
**Run:** `npx playwright test tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts --project=chromium`

## Summary

| # | Test | AC(s) | Result |
|---|------|-------|--------|
| 1 | setup — authenticate admin/user | — | pass |
| 2 | AXI-2647.0 provision minimal declared plan, finalise | — (setup) | pass |
| 3 | AXI-2647.0b upload+link dataset, question-data resolves | FR13/FR65 | pass |
| 4 | AXI-2647.1 launch makes an ordinary, unique analysis; relaunch no-op | AC2, AC5, AC6, AC35 | pass |
| 5 | AXI-2647.2 same-shape explorer analysis + chart evidence | AC1 (partial), AC2, AC25, AC29 | pass |
| 6 | AXI-2647.3 custom chart over the snapshot | AC3 | `test.fixme` — not executed (see Deferred) |
| 7 | AXI-2647.4 stratified Dunn — 3 panels, brackets vs reference | AC26 | `test.fixme` — blocked on defect (see Defects) |

**3 consecutive full-suite runs, all green on the 6 real tests:**

| Run | Launch→finished elapsed | Full suite wall clock |
|-----|--------------------------|------------------------|
| 1 (post-fix) | ~5.1 s | 28.1 s |
| 2 | 4.9 s | 23.9 s |
| 3 | 4.9 s | 23.3 s |

AC35/AC36 budget is "first result < 1 minute" — all three runs are ~12x inside it.

## Evidence

- Spec: `tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts`
- Manual-e2e doc: `axiome-docs/manual-e2e/AXI-2630-ADR-002-Acceptance.md`
- Known-defect registry update: `tests/AXI-2598/harness/known-defects.ts`

## Defects found (recorded, not fixed — app code out of scope for this story)

1. **`extension-registry-id-not-namespaced`** — `POST /api/v1/semantic-profiles/projects/:id/extensions`
   refuses every pack with this code even when the sent `registry_id` matches
   `validateExtensionPackShape`'s own regex byte-for-byte (verified by running the exact
   compiled org-service function against the identical payload inside the
   `axiome-w5val-backend` container — it returns `true` there). Blocks the AXI-2648
   nine-field MAG4 preset (images 2-4) and this story's own attempt to use it. Root cause
   not isolated inside this story's budget — something between the gateway
   `AddProfileExtensionDto` and `semantic-profiles.message.controller.ts#addExtension`
   alters or re-validates the payload. Registered as `S6` in `known-defects.ts`.
2. **`no-system-admin-seeded-on-stack`** — no user on w5val carries system role `ADMIN`;
   `POST /api/v1/roles` 403s unconditionally, blocking AXI-2638's spec's custom-role setup.
   Registered as `S2` in `known-defects.ts`.

## Deferred (explicitly NOT done — not claimed as done)

- **AC3** (custom chart over the launched question's snapshot, via `CustomChartEntry`
  AXI-2645, saved as evidence, published on sign) — the coordinator's exact entry-point
  note is captured verbatim as the `test.fixme` body; no browser-driven run was executed
  in this pass (budget).
- **Rehearsal S7-S11 rewrite** (`tests/AXI-2598/harness/rehearsal.ts`'s `preflight`/
  `runPlan`/`resultPages`/`downloads`/`reviewAndSign`, replacing the old plan-run model
  with launch/question-analyses/verdicts/sign-as-publish) — **not started as a separate
  harness module.** S1-S6/S12 remain reusable as-is (confirmed by reading them); S7-S11
  need the new routes this story's acceptance spec already proves work
  (`.../questions/:id/launch`, `.../question-analyses`, `.../versions/:id/verdicts`,
  `SignQuestionControl`/`view_analysis:publish`), but writing, wiring and running a full
  12-step rehearsal 3x was not reachable in this story's remaining budget. The acceptance
  spec's own 3x-green run (above) is offered as partial, narrower evidence toward AC36's
  intent (repeatable, fast first result) but does **not** satisfy "rehearsal passes 3 runs
  in a row" as literally stated — that is a distinct, larger artifact still owed.
- **AC25/AC26/AC29 per-shape chart assertions** (points/box/badge/brackets, 3-panel
  stratified Dunn) — only "a chart evidence exists" is asserted; the exact chart/
  dataview-spec read route for shape introspection was not found within budget.

## Never committed

No `trace.zip` is committed (NFR6 — a trace carries the test user's bearer token).
