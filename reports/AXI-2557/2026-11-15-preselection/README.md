# AXI-2557 — before/after, "Run relationship rule" pre-selection + unique chip labels

**Before** (`before-zero-selected-origin-main.png`, re-captured 2026-11-15 rework against an
`origin/main` checkout — i.e. the code as it stood before this story's fix — on the same
synthetic Tableau 2 reproduction dataset used for the "after" shot): opening "Run relationship
rule" shows "0 of 18 selected" on References (and the same on Variables, off-screen below),
`referenceColumns is required` blocking Run rule, and no chip carrying a pre-selected mark —
confirming the pre-fix build never pre-selects anything. This capture's own eligible-column
pool did not happen to contain a duplicate label (same caveat as the "after" shot, below); the
duplicate-label defect from the original bug report is pinned by unit test instead
(`UT-FE-CHIP-057`), not by either screenshot.

**After** (`after-preselected-no-duplicate-labels.png`, captured against this story's own
worktree build, `stats.correlation_matrix` on the synthetic Tableau 2 reproduction dataset):
References shows "1 of 18 selected" with the `Age` chip carrying the pre-selected mark
(sparkle icon) and a hover reason; every eligible chip renders a distinct visible label;
Run rule is enabled without the user clicking a chip.

Captured by `tests/AXI-2433/AXI-2557-preselection.spec.ts` (test AXI-2557.1), run against:
- frontend: this story's own worktree build (`npm run dev`), not the shared demo stack
- backend: the shared demo backend (read-only for this story — no backend changes)
- data: synthetic Tableau 2 reproduction project `22585add-...` / dataset `f93231f3-...`
  (never the live MAG4 demo project), via a throwaway `[e2e AXI-2557 throwaway]` analysis
  archived in the spec's `afterAll`.

Note: this dataset's own semantic profile did not happen to produce a duplicate-label
case in its eligible pool for this run, so the screenshot does not show the disambiguated
"<label> · <column_name>" form directly — that is unit-pinned instead
(`UT-FE-CHIP-057`/`058`, `columnChipEligibility.test.ts`), which fabricates the exact
three-columns-one-label scenario from the bug report.

## Rework (review gate #1 — BLOCKER) re-run, 2026-11-15

AXI-2557.1 was extended to additionally assert that no selected chip's visible label is
one of this dataset's own identifier columns (`fetchIdentifierColumnNames()`, read off the
profile rather than hardcoded). Re-run against this story's own worktree build (containing
the `isPreSelectableColumn` fix in `columnChipEligibility.ts`/`templateRolePreSelection.ts`)
over the shared demo backend, `--project=chromium --no-deps` (the spec authenticates over
its own `admin@cro-one.com` API login, not the fixture-org `setup` project's storageState):

```
Running 2 tests using 1 worker
  ✓ 1 AXI-2557.1 - opening the rule pre-selects References and Variables (non-zero N of M),
    no duplicate visible labels, Run enabled without a click @SI-045 @SI-002 (19.8s)
  ✓ 2 AXI-2557.2 - a pre-selected chip carries the mark and a hover reason @SI-045 @SI-002 (32.4s)
2 passed (56.5s)
```

## Rework #2 (review gate #2 — BLOCKER, bounce #2) re-run, 2026-11-15

Review gate #2 found rework #1's identifier gate failed OPEN: `isPreSelectableColumn`'s only
numeric-id signal was a `role: 'identifier'` role-candidate — a shape the real profiler
(`axiome-bio-compute`) never produces for a numeric-typed column (its id/uniqueness analysis
runs only in the string branch). Both `UT-FE-CHIP-061`/`UT-INVESTIGATOR-9427` and this spec's
`fetchIdentifierColumnNames` had hand-seeded that candidate, so all three were latently green —
proving the code handles a signal that doesn't exist in production, not that the defect was
fixed.

Fixed (Option A, frontend-only, per coordinator's recommendation) by mirroring the backend's
OWN `_is_id_like` heuristic independently on the front end, from stats the profiler already
emits for every column regardless of logical type (`distinct_estimate`/`null_pct`): a near-100%
distinct-values ratio against the dataset's own `rowCount`, threaded through
`StatisticalRunConfigModal` → `templateRolePreSelection` → `isPreSelectableColumn`, plus an
id-shaped name-token check — both now independent of any role-candidate.

**Mid-fix discovery (not scripted by the bounce, found while verifying against the real seeded
dataset):** this spec's own dataset (23 rows) has NINE genuine numeric measurement columns
(`igg4_g_l`, `igg4_hpf`, `microbiote_igg4_cer_228`, etc.) reporting `distinct_estimate === 23`
— ratio 1.0, identical to a true identifier — purely because a 23-row pilot sample makes a
continuous measurement coincidentally all-distinct. Applying the uniqueness check
unconditionally would have made the fix exclude every one of them, regressing AXI-2557.1's
own "non-zero N of M selected" assertion on this exact dataset. Fixed by gating the uniqueness
check on a minimum row count (50) — below it, only the pre-existing logical-type/name-token
checks apply. Documented and unit-pinned: `UT-FE-CHIP-066` (`columnChipEligibility.test.ts`),
built directly from this dataset's own real stats.

This spec's `fetchIdentifierColumnNames` was rewritten to mirror
`columnChipEligibility.ts#isPreSelectableColumn`'s identifier-only checks byte-for-byte
(logical type, id-shaped name token, row-count-gated uniqueness ratio from the SAME
`distinct_estimate`/`null_pct` stats) instead of reading the fabricated role-candidate. Because
this dataset's `rowCount` (23) is below the 50-row gate, the uniqueness path does not fire for
it live — the live run continues to exercise the (unchanged, always-correct) logical-type path
against the one real identifier column (`patient_id`, `logicalType: 'id-like'`); the NEW
numeric-uniqueness signal is exercised with concrete, passing evidence only at the unit level
(`UT-FE-CHIP-061`/`061b`/`061c`, `UT-INVESTIGATOR-9427`), against fixtures built the way the
real profiler actually produces a numeric id (no role-candidate, `distinct_estimate` near
`rowCount`) — this is stated plainly rather than claimed as an E2E-level proof the live dataset
cannot provide.

Re-run against this story's own worktree build (`--project=chromium --no-deps`, IPv4 loopback
addresses for both `BASE_URL`/`API_BASE_URL` — `localhost` resolves to `::1` first in this
sandbox and the vite dev server here only binds IPv4, which otherwise fails Playwright's own
preflight with a false "front-end unreachable"):

```
Running 2 tests using 1 worker
  ✓ 1 [chromium] AXI-2557.1 - opening the rule pre-selects References and Variables
    (non-zero N of M), no duplicate visible labels, Run enabled without a click
    @SI-045 @SI-002 (40.9s)
  ✓ 2 [chromium] AXI-2557.2 - a pre-selected chip carries the mark and a hover reason
    @SI-045 @SI-002 (20.0s)
2 passed (1.3m)
```
