# Staging Steps — Unit Tests (SI-044, tag `STAGE`)

First `UT.md` for `staging/**` — no unit-test runner existed in this repo
before AXI-1373 (`node:test` + `tsx --test`, zero new dependencies; run via
`npm run stage:unit`). Prior stories (AXI-1369–1372) shipped without a
runnable spec file even where their reports named `UT-*` IDs; this file and
runner are the first real one.

## analysisFraming.spec.ts

FR9/AC8 (Capture Spec §5) — the truth guard that withholds the 4th
("threshold provenance") assumption unless it is actually true of how this
DE table was built, plus the idempotency check the re-stage loop depends on
(NFR1).

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-020 | `cohort_definition` is always stageable | Pass |
| UT-STAGE-021 | `data_filter` is always stageable | Pass |
| UT-STAGE-022 | `methodological_choice` is always stageable | Pass |
| UT-STAGE-023 | `threshold_provenance` is withheld while `THRESHOLD_DECLARED_BEFORE_CONTRAST` is false (the default) | Pass |
| UT-STAGE-024 | AC8 at fixture level: `TENANT_FIXTURE` declares 4 assumption bodies (words), but exactly 3 pass the FR9 guard | Pass |
| UT-STAGE-025 | `toBackendType` maps the three FR9-staged categories verbatim onto the backend `AssumptionType` enum | Pass |
| UT-STAGE-026 | `toBackendType` maps `threshold_provenance` to `domain_assumption` (no direct backend enum match) | Pass |
| UT-STAGE-027 | `alreadyStaged` is true for a matching active assumption — re-run does not duplicate (NFR1) | Pass |
| UT-STAGE-028 | `alreadyStaged` is false when the fixture text differs from the staged text — an edited body re-stages | Pass |
| UT-STAGE-029 | `alreadyStaged` is false when the matching prior entry was withdrawn — re-staged, not treated as still present | Pass |

## chartStaging.spec.ts

FR8/FR23/AC6 (Capture Spec §6.1-6.2) — the six user-created charts, scoped
to the AXI-1373 analysis, all `origin: 'user'` by construction; the data-
feasibility guard that withholds charts 5-6 (same shape as FR9's threshold
guard); the create-body mapping; and the FR8 "no duplicate titles" fixture
check.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-030 | a de_table chart is always stageable | Pass |
| UT-STAGE-031 | a count_matrix chart is withheld while `COUNT_MATRIX_INGESTED` is false (the default) | Pass |
| UT-STAGE-032 | AC6 at fixture level: `TENANT_FIXTURE` declares 6 chart titles (Capture Spec §6.2), but exactly 4 pass the AC5 data-feasibility guard | Pass |
| UT-STAGE-033 | `alreadyStagedChart` is true for a matching user-origin title — re-run does not duplicate (NFR1) | Pass |
| UT-STAGE-034 | `alreadyStagedChart` is false when no title matches — an edited fixture title re-stages | Pass |
| UT-STAGE-035 | `alreadyStagedChart` ignores an auto-origin spec with the same title (AC6) | Pass |
| UT-STAGE-036 | `toCreateBody` maps the fixture spec onto the candidates POST body, scoped to the analysis | Pass |
| UT-STAGE-037 | `toCreateBody` defaults params/filters to empty rather than undefined | Pass |
| UT-STAGE-038 | `checkChartTitlesUnique` passes on the live `TENANT_FIXTURE` (6 distinct titles) | Pass |
| UT-STAGE-039 | `checkChartTitlesUnique` flags a duplicated title | Pass |

Run: `npm run stage:unit` (20/20 passing as of 2026-08-28).
