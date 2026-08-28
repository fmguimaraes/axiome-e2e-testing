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

FR11/AC10 (Capture Spec §4, AXI-1376; OQ6 follow-up) — snapshot v1 (pooled)
and v2 (now a REAL stratified contrast, linked to the offline per-arm DE
dataset via `origin: 'linked'`), the name-keyed reconciliation logic that
resolves a declared snapshot's target dataset and detects/supersedes a stale
prior row bound to the wrong one, and the EC7 bounded-poll / route-choice
findings documented in the module doc.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-060 | `resolveDatasetIdForSnapshot` returns the root dataset for a snapshot with no `datasetRole` | Pass |
| UT-STAGE-061 | `resolveDatasetIdForSnapshot` resolves a declared `datasetRole` to its live dataset id (OQ6) | Pass |
| UT-STAGE-062 | `resolveDatasetIdForSnapshot` throws loudly when the declared role has no live dataset yet (OQ6) | Pass |
| UT-STAGE-063 | `findSnapshotByName` matches on name, not position (NFR1) | Pass |
| UT-STAGE-064 | `findSnapshotByName` is undefined when no declared name has a live match yet (NFR1) | Pass |
| UT-STAGE-065 | `snapshotIsStale` is false once the live `datasetId` already matches the declared target (OQ6) | Pass |
| UT-STAGE-066 | `snapshotIsStale` is true for a v2 row still bound to the old (pooled) root dataset (OQ6) | Pass |
| UT-STAGE-067 | `checkSnapshotNamesUnique` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-068 | `checkSnapshotNamesUnique` flags a duplicated snapshot name | Pass |
| UT-STAGE-069 | `TENANT_FIXTURE` declares v1 (pooled, no `datasetRole`) then v2 (real stratified, `datasetRole` set) in order (FR11/AC10) | Pass |
| UT-STAGE-070 | `checkSnapshotDatasetRolesDeclared` passes on the live `TENANT_FIXTURE` (OQ6) | Pass |
| UT-STAGE-071 | `checkSnapshotDatasetRolesDeclared` flags a snapshot pointing at an undeclared dataset role (OQ6) | Pass |

## interpretationsEvidenceStaging.spec.ts

FR12/AC11 (Capture Spec §9, AXI-1377) — 6 evidence of mixed kinds (chart-derived /
statistical / computed — see the module doc for why no literal `kind` enum exists
server-side and what honest 3-way mapping this stages onto instead), 3
interpretations (= DecisionDrafts), and the "publish exactly one" rule. Covers the
DE-citation-context builder (`buildDeCitationContext`), the citation-resolution
logic that produces the AC11 provenance fork (`resolveEvidenceLinks`), and the 6
new fixture-level shape/reference validators.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-072 | `buildDeCitationContext` cites each row with the dataset id/version as the opaque evidence_id/evidence_version reference | Pass |
| UT-STAGE-073 | `buildDeCitationContext` defaults the view_state filter to padj<0.05 when no strata filter is given | Pass |
| UT-STAGE-074 | `buildDeCitationContext` uses the declared strata filter in view_state when given | Pass |
| UT-STAGE-075 | `buildDeCitationContext` truncate_n tracks the actual cited row count | Pass |
| UT-STAGE-076 | `resolveEvidenceLinks` resolves an evidenceTitle citation to `{evidenceId}` — the AC11 fork mechanism | Pass |
| UT-STAGE-077 | `resolveEvidenceLinks` resolves a snapshotName citation to `{snapshotId}` by NAME, not a hard-coded id | Pass |
| UT-STAGE-078 | `resolveEvidenceLinks` throws loudly on a citation naming an undeclared/unstaged evidence title | Pass |
| UT-STAGE-079 | `resolveEvidenceLinks` throws loudly on a citation naming an undeclared/unstaged snapshot name | Pass |
| UT-STAGE-080 | `resolveEvidenceLinks` resolves multiple citations on one interpretation in order (the fork on the shared evidence) | Pass |
| UT-STAGE-081 | (AC11) `checkEvidenceTitlesUnique` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-082 | (AC11) `checkEvidenceReferencesDeclared` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-083 | `checkComputedEvidenceParentDeclaredEarlier` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-084 | `checkComputedEvidenceParentDeclaredEarlier` flags a computed entry whose parent is declared later (or not at all) | Pass |
| UT-STAGE-085 | (AC11) `checkInterpretationCitationsDeclared` passes on the live `TENANT_FIXTURE` | Pass |
| UT-STAGE-086 | (AC11) `checkInterpretationsShape` passes on the live `TENANT_FIXTURE` — 3 interpretations, >=1 by CN, >=1 citing evidence explicitly | Pass |
| UT-STAGE-087 | (AC11) `checkInterpretationsShape` flags a fixture with no cast-clinician (CN) author | Pass |
| UT-STAGE-088 | (AC11) `checkEvidenceShape` passes on the live `TENANT_FIXTURE` — 6 evidence, all 3 kinds represented | Pass |
| UT-STAGE-089 | (AC11) `checkEvidenceShape` flags a fixture missing one of the 3 kinds ("mixed kinds" violated) | Pass |

Live (invoked `ensureInterpretationsEvidencePublishStep` directly, analysis `cf17e1ea`,
2026-08-28): Interpretations=3 (MO/CN/LF, CN's states the EC4 weak-separation finding
and cites evidence explicitly), Evidence=6 canonical (mixed kinds), Published=1
(`229924ad-90c2-44c2-a088-1bf286d0e13b`), provenance fork confirmed by reading the
graph back (the cited evidence node has 2 incoming `INFORMED` edges). Re-run created 0
new entities. **Incident (disclosed, fixed):** an early run hit a missing-header bug
in the evidence idempotency check and created 6 duplicate Evidence records before the
fix; no REST delete/archive route exists for Evidence, so those 6 are marked
`unapproved` (best-effort signal) but remain live — the dev tenant currently shows
Evidence=12, not 6, pending a future cleanup. The code itself is fixed and verified
idempotent going forward.

## externalScopingVerification.spec.ts

FR13/AC12/EC5/EC6 (Capture Spec §11/§12/§21, AXI-1378) — the §21 "whole
feature" verification: an authenticated request AS `external-stakeholder`
against the two client-exploration surfaces it should reach (published
record, external thread) and the six internal, workspace-scoped surfaces it
must not (analysis discussion thread, chart-anchored comments, decisions
incl. drafts, evidence, unpublished snapshots). Covers the status-code
classifier (EC6: any 2xx is 'visible' regardless of body content — hiding
means the route never resolves for this caller, not a disabled flag on real
data), the probe-vs-expectation evaluator, the probe-set shape, and the §21
leak/genuine-scoping/blocked-from-published/error determination.

| ID | Description | Status |
|----|-------------|--------|
| UT-STAGE-090 | (EC6) classifyOutcome treats any 2xx as visible regardless of status within the range | Pass |
| UT-STAGE-091 | classifyOutcome treats 400/401/403/404 as hidden — the guard denied before data resolution | Pass |
| UT-STAGE-092 | classifyOutcome treats anything else (5xx) as error, not scoping evidence | Pass |
| UT-STAGE-093 | evaluateProbe marks matchesExpectation true when outcome equals expectation | Pass |
| UT-STAGE-094 | (EC5) evaluateProbe marks matchesExpectation false when an internal surface unexpectedly answers 200 | Pass |
| UT-STAGE-095 | (FR13) buildScopingProbes returns exactly 2 visible + 6 hidden probes, all hard | Pass |
| UT-STAGE-096 | buildScopingProbes targets the real workspace/project/analysis ids, in the path or (for workspace) the X-Workspace-Id header | Pass |
| UT-STAGE-097 | buildScopingProbes attaches an X-Workspace-Id header to every internal probe except the deliberate no-header variant | Pass |
| UT-STAGE-098 | (§21) summarizeScoping reports genuineScoping=true when every hard probe matches its expectation | Pass |
| UT-STAGE-099 | (EC5) summarizeScoping reports a leak when an internal (hidden) probe comes back visible | Pass |
| UT-STAGE-100 | (FR13) summarizeScoping reports blockedFromPublished when a visible probe comes back hidden | Pass |
| UT-STAGE-101 | summarizeScoping surfaces a 5xx as an error, not silently absorbed into either bucket | Pass |

Live (invoked `verifyExternalScopingStep` directly against the running local
stack, analysis `cf17e1ea`, 2026-08-28): **§21 ANSWERED — GENUINE SCOPING.**
All 6 internal probes returned 403 (5, with `X-Workspace-Id`) or 400 (1, the
deliberate no-header variant) — never 200. Both visible probes returned 200
(published-artifacts list; external thread surface reachable). Root cause
confirmed by source read: `ClientExplorationService.inviteMember` creates
only a `ClientExplorationMembership` row, never a `WorkspaceMember` row, so
`WorkspaceGuard`'s membership RPC genuinely rejects the external stakeholder
on every internal, workspace-scoped route — the same guard every other
internal surface already relies on, not a UI-only affordance. **DEFERRED:**
the external thread's message *content* — 0 messages live (the known
`ensure-comments` external-message POST 500, blocked on the operational-phase
stack reconcile / AXI-1375 `authorType` fix, see dev-epic-context) — logged,
not hard-asserted; re-run after the reconcile to confirm non-zero content.

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
