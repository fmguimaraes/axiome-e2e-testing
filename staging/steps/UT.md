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

Run: `npm run stage:unit` (10/10 passing as of 2026-08-28).
