# AXI-2647 — ADR-002 Acceptance Tests & Rehearsal Rewrite — Results (2026-11-19)

**Date:** 2026-11-19
**Stack:** w5val — front `:5174`, back `:3001` (org-service container `axiome-w5val-backend`)
**Spec:** `tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts`
**Run:** `npx playwright test tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts --reporter=list`
with `API_BASE_URL=http://localhost:3001`, `BASE_URL=http://localhost:5174`,
`GUIDED_ANALYSIS_LLM_TRANSPORT=recorded`, `E2E_INVESTIGATOR_EMAIL=***`,
`E2E_INVESTIGATOR_PASSWORD=***`, `HANDOVER_PROVISIONER_EMAIL=***`,
`HANDOVER_PROVISIONER_PASSWORD=***`, `HANDOVER_WORKSPACE_ID=1eebb49b-a1f6-4e69-b880-20d0e7d1f739`
("Mag4 - Investigator" — the same shared demo workspace used by prior AXI-2598/AXI-2601 runs;
chosen because it is already known to carry an Investigator-rank membership for the investigator
identity and a provisioner identity able to act with `governs_analysis_parameters` but with no
Investigator membership anywhere, matching the required test shape). No credential value is
written to this report or any committed file — see the `***` redactions above, per the explicit
instruction this run was given.

## Summary — this pass closes out the 2026-11-18 report's open items

Picking up from `../2026-11-18-adr002-acceptance/RESULTS.md` Update 4 (AC3 blocked, believed to be
a front-end defect) and Defect #2 (AC1 browser spot-check unconfirmed): this pass re-drove AC3 as a
real end-to-end browser flow and the AC1 browser spot-check, and found that **every remaining
failure was a test bug, not a product defect** — see "Root causes" below. Two consecutive full
runs are green:

| Run | Result |
|---|---|
| `run11-first-clean.log` | 7 passed, 1 skipped (AC26, `test.fixme`, unchanged from 2026-11-18), 54.8s |
| `run12-stability-confirm.log` (re-run to rule out AC3 flakiness seen earlier the same session) | 7 passed, 1 skipped, 48.8s |

| # | Test | AC(s) | Result |
|---|------|-------|--------|
| 1 | AXI-2647.0 provision minimal declared plan, finalise | — (setup) | **pass** |
| 2 | AXI-2647.0b upload+link dataset, question-data resolves | FR13/FR65 | **pass** |
| 3 | AXI-2647.1 launch makes an ordinary, unique analysis; relaunch no-op | **AC2**/AC5/AC6/**AC35** | **pass** |
| 4 | AXI-2647.1b — explorer-made analysis (never through a plan) displays with evidence, no plan-run object | **AC1** | **pass** |
| 5 | AXI-2647.2 — launched analysis same-shape; chart evidence shape | **AC2**/**AC25**/**AC29** | **pass** |
| 6 | AXI-2647.3 — custom chart over the snapshot, saved as evidence, visible in explorer, published on sign | **AC3** | **pass** |
| 7 | AXI-2647.4 AC26 — stratified Dunn, 3 panels/brackets | AC26 | `test.fixme`, unchanged — needs the AXI-2648 nine-field preset, not built this pass either |
| 8 | AXI-2647.5 spot-check — AC1 analysis renders in the Investigator browser, not just the API | AC1 (browser) | **pass** |

**AC1, AC2, AC3 all genuinely PASS** (not skipped, not widened/worked-around). AC25/AC29/AC35
pass as part of tests #3/#5. AC26 remains the one pre-existing, explicitly deferred gap (same
status as the 2026-11-18 report; out of scope to build this pass).

## Root causes found and fixed — all were test bugs, no product defect found

The 2026-11-18 report's Update 4 concluded AC3's empty column-selects were caused by a front-end
defect (chart editor binds to the currently-*selected* snapshot, including a derived statistical
result, which is never profiled). Re-reading `ProjectViewAnalysisDetail.tsx`'s own code comments
confirmed this binding is **intentional, documented product behavior** (FR36/AXI-1422
`effectiveDatasetId` doctrine: the chart editor authors against whichever dataset the analysis is
currently showing), not a defect. The test was simply assuming a fixed dataset shape
(`col_pct`/`col_group`, later `col_pValue`/`col_groupA`) that does not hold once a statistical
result — rather than the base dataset — is the one "current." Fixed by making the AC3 column
selection fully dynamic (poll until the Y/Group `<select>`s are populated with at least one real
option, then pick by index rather than by hardcoded name), which is correct regardless of which
dataset the editor is currently bound to.

Four further test bugs were found and fixed while driving AC3 and the AC1 browser spot-check as
real browser flows for the first time in this story's life (the 2026-11-18 report's own Update 5
and Defect #2 both note these had never previously completed):

1. **Card locator too greedy.** `page.locator('div', { hasText: chartTitle }).last()` resolved to
   the title text's own innermost wrapper `div`, not the card container holding the sibling
   "More actions" button. Fixed by adding `.filter({ has: page.getByTitle('More actions') })`.
2. **Click interception.** The "More actions" trigger was transiently covered by a success toast
   and by lazy-loading gallery thumbnails. Fixed by waiting for the toast to hide and
   `scrollIntoViewIfNeeded()` before a `click({ force: true })` — the button itself was never
   actually broken.
3. **Missing publish-gate precondition.** Signing never produced `rp-signed-note`; the app
   correctly enforced its real publish gate (`assertApprovedInterpretationsExist`): every evidence
   version being published needs an APPROVED decision draft citing it. The test never created one.
   Fixed by creating a decision draft covering **every** evidence on the analysis (the Sign button
   publishes all of them, per `signAnalysis.ts`), transitioning it `draft -> reviewed -> approved`
   with the `reviewed`/`approved` step done by a separate (non-self) identity, per the
   `SELF_APPROVAL_NOT_PERMITTED` doctrine.
4. **Wrong surface route + wrong tab.** The AC1 browser spot-check navigated an investigator-rank
   session to the team-surface route `/projects/:id/view-analyses/:id`, which silently fell back to
   a stale, unrelated project's Study page rather than erroring (confirmed via trace network-log
   inspection: zero requests were ever made for the target project). Investigator-rank sessions
   live behind the separate `/investigator/*` route prefix (`App.tsx` has two separate route
   registrations for the same path, one nested under `/investigator/*`, one on the team surface).
   Fixed by navigating to `/investigator/projects/:id/view-analyses/:id`. A second, separate gap
   was that the default "Explore" sub-tab shows only the chart's own title, not the evidence
   citation's title — fixed by clicking the "Evidence" tab before asserting on the evidence title.

No test tolerance was widened and no real product defect was found or worked around in this pass.

## Deferred / not completed this pass

- **AC26** — unchanged from 2026-11-18, still `test.fixme`; needs the AXI-2648 nine-field preset.
- **AC36 rehearsal S7-S11 rewrite (3x timed run)** — not attempted this pass; out of this pass's
  scope (coordinator's task this round was the acceptance-test stabilization, not the rehearsal
  rewrite).

## Never committed

No `trace.zip`/`video.webm`/screenshot is committed (NFR6). No credential value appears in this
report or in `tests/AXI-2630/AXI-2647-adr002-acceptance.spec.ts` (all read from `process.env` with
no fallback for the investigator/provisioner credentials).
