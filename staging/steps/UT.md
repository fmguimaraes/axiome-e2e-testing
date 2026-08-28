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
feasibility guard (AXI-1374: reflects LIVE dataset-role availability, not a
hard-coded constant — `isChartStageable(spec, availableRoles)`); the
create-body mapping; and the FR8 "no duplicate titles" fixture check.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-030 | a de_table chart is stageable once the de_table role is live-available | Pass |
| UT-STAGE-031 | a count_matrix chart is withheld while the count_matrix role is NOT live-available | Pass |
| UT-STAGE-032 | AC6 (AXI-1374): once BOTH dataset roles are live-available, all 6 declared charts pass the guard | Pass |
| UT-STAGE-032b | real-state guard: with only de_table available, exactly the 4 de_table charts pass | Pass |
| UT-STAGE-033 | `alreadyStagedChart` is true for a matching user-origin title — re-run does not duplicate (NFR1) | Pass |
| UT-STAGE-034 | `alreadyStagedChart` is false when no title matches — an edited fixture title re-stages | Pass |
| UT-STAGE-035 | `alreadyStagedChart` ignores an auto-origin spec with the same title (AC6) | Pass |
| UT-STAGE-036 | `toCreateBody` maps the fixture spec onto the candidates POST body, scoped to the analysis | Pass |
| UT-STAGE-037 | `toCreateBody` defaults params/filters to empty rather than undefined | Pass |
| UT-STAGE-038 | `checkChartTitlesUnique` passes on the live `TENANT_FIXTURE` (6 distinct titles) | Pass |
| UT-STAGE-039 | `checkChartTitlesUnique` flags a duplicated title | Pass |

## commentStaging.spec.ts

FR10/AC9 (Capture Spec §7, AXI-1375) — the internal analysis-level thread
(`/api/v1/snapshot-comments`, `anchorType: 'view_analysis'`), the four
chart-anchored comments (`/api/v1/comments`, via a `ProjectDashboard` +
`DashboardVisualization` link), and the external stakeholder thread
(`client-exploration` artifacts/comments). AC9-shape checks against the live
`TENANT_FIXTURE` plus the idempotency guards each staging loop depends on
(NFR1).

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-040 | AC9: `TENANT_FIXTURE` declares >= 3 distinct internal-thread authors, >= 1 reply, >= 1 resolved | Pass |
| UT-STAGE-041 | AC9: `TENANT_FIXTURE` declares exactly 4 chart-anchored comments, each targeting a real chart title | Pass |
| UT-STAGE-042 | AC9: `TENANT_FIXTURE` declares a non-zero external thread authored solely by the external stakeholder on the client side | Pass |
| UT-STAGE-043 | `resolveCommentAuthorHandles` collects every internal-side author (top-level + replies + chart-anchored + internal external-thread posters), excluding the external stakeholder | Pass |
| UT-STAGE-044 | `alreadyStagedInternalComment` matches on (type, text) and ignores unrelated entries (NFR1) | Pass |
| UT-STAGE-045 | `alreadyStagedReply` matches on text alone within the parent's existing replies (NFR1) | Pass |
| UT-STAGE-046 | `alreadyStagedChartComment` matches on content alone (NFR1) | Pass |
| UT-STAGE-047 | `alreadyStagedExternalMessage` matches on (content, authorType) — a client message and an internal reply with the same text are distinct (NFR1) | Pass |

## thresholdStaging.spec.ts

FR6/Capture Spec §8 (AXI-1376) — the two governance thresholds staged on
"Significant differential expression — FDR < 0.05, |log2FC| ≥ 1", provenance
folded into `label` + a threshold-targeted `Annotation` rationale (no
structured provenance field exists on the backend `Threshold` entity — see
the module doc), plus the idempotency guards the staging loop depends on
(NFR1). No dedicated FR/AC number is pinned to thresholds in the feature doc
(FR10=comments, FR11=snapshots) — see `thresholdStaging.ts`'s "NO DEDICATED
FR/AC" note.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-050 | `alreadyStagedThreshold` matches an active threshold with the same field/operator/value | Pass |
| UT-STAGE-051 | `alreadyStagedThreshold` ignores an archived/superseded threshold | Pass |
| UT-STAGE-052 | `alreadyStagedThreshold` is false when the value differs — an edited cutoff re-stages | Pass |
| UT-STAGE-053 | `alreadyStagedRationale` matches an active threshold-targeted annotation with the same text | Pass |
| UT-STAGE-054 | `alreadyStagedRationale` ignores a chart-targeted annotation and a different threshold id | Pass |
| UT-STAGE-055 | `resolveCastDisplayName` resolves a fixture handle to its real display name | Pass |
| UT-STAGE-056 | `resolveCastDisplayName` throws loudly for an undeclared handle | Pass |
| UT-STAGE-057 | `checkThresholdChartsDeclared` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-058 | `checkThresholdChartsDeclared` flags a threshold targeting an undeclared chart | Pass |
| UT-STAGE-059 | `TENANT_FIXTURE` declares exactly 2 thresholds, provenance external + prespecified, no third "failed" threshold (OQ2) | Pass |

## snapshotStaging.spec.ts

FR11/AC10 (Capture Spec §4, AXI-1376) — snapshot v1 (pooled) and v2
(stratified label), the version-ordinal count/naming idempotency logic, and
the EC7 bounded-poll / route-choice findings documented in the module doc
(the "stratified" contrast cannot be a real data-level filter on this
dataset — no per-patient exposure column exists — so v2 is honestly staged
as a labeled version of the same slice, not a fabricated result).

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-060 | `snapshotsToCreate` is the full target count against an empty tenant | Pass |
| UT-STAGE-061 | `snapshotsToCreate` is the shortfall when some already exist | Pass |
| UT-STAGE-062 | `snapshotsToCreate` is zero once at or past target — re-run creates nothing new (NFR1) | Pass |
| UT-STAGE-063 | `pairSnapshotsToNames` binds by array position, not id — caller pre-sorts by version | Pass |
| UT-STAGE-064 | `pairSnapshotsToNames` (sorted input) binds v1 fixture to version 1, v2 fixture to version 2 | Pass |
| UT-STAGE-065 | `pairSnapshotsToNames` drops a declared entry with no matching live snapshot yet (NFR1) | Pass |
| UT-STAGE-066 | `checkSnapshotNamesUnique` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-067 | `checkSnapshotNamesUnique` flags a duplicated snapshot name | Pass |
| UT-STAGE-068 | `TENANT_FIXTURE` declares v1 (pooled) then v2 (stratified label) in order (FR11/AC10) | Pass |

## AXI-1372-dataset-ingestion.spec.ts (Playwright, `tests/AXI-1368/`)

FR7/AC5, widened AXI-1374 to "one corpus, one-or-more dataset versions" —
`ensureDatasetStep()` generalized to iterate `content.datasets[]`, each
entry reading bytes from its OWN `localPathEnv`/`defaultLocalPath` instead
of a single hard-coded path.

| ID | Description | Status |
|----|-------------|--------|
| UT-DSI-001..005 | single-dataset behavior (upload/finalize/wait/link, NFR1 reuse, content-type, missing-workspace failure, no-op on empty `datasets`) | Pass |
| UT-DSI-006 | one run ingests BOTH declared datasets and links both to the project | Pass |
| UT-DSI-007 | NFR1 — a second run reuses both datasets, no re-upload, no duplicate links | Pass |
| UT-DSI-008 | each dataset reads bytes from its OWN `localPathEnv`, not a shared constant | Pass |

Run: `npm run stage:unit` (21/21 `staging/**` node:test cases) +
`npx playwright test tests/AXI-1368/AXI-1372-dataset-ingestion.spec.ts
tests/AXI-1368/AXI-1371-tenant-provisioning.spec.ts` (18/18) — both green as
of 2026-08-28 (AXI-1374).
