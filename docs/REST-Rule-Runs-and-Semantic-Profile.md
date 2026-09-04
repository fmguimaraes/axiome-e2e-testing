# Executing Rule Runs over REST — DELTA + Semantic Profile Setup

**Audience:** an API client or agent that needs to run the **rule kernel** (DELTA /
STRATIFY / comparability) over REST, not just stage charts. Companion to
[`REST-API-Guide.md`](REST-API-Guide.md), which covers the analysis/chart/evidence
surface but **not** rule execution.

**Status:** verified live 2026-09-04 against the local AXI-1233 worktree stack
(gateway `http://localhost:3100`, workspace `aphm-mipp/cerainom-igg4`). Every
request and gotcha below was exercised against a running instance; the DELTA run
in §3 executed, materialized a provenance node, and surfaced in the analysis
provenance graph.

Auth, `X-Workspace-Id`, and idempotency are as in `REST-API-Guide.md` §1/§5.

---

## 0. Why this doc exists — the two-level "make it real"

A chart bound to a dataset is a **filtered view of raw rows**; it is *not* a
computed comparison, it creates **no rule-run node in provenance**, and the
"patient vs. baseline" or "patient vs. cohort" claim is a line a human reads, not
a governed operation. To get an actual, provenance-stamped comparison you must
execute a **rule run** (`POST /api/v1/rule-runs`). That has a hard prerequisite —
a bound **semantic profile** — that no amount of chart/snapshot staging supplies.

Symptom that sent us here: an analysis whose snapshot had `filters: []` (so the
pinned view named no patient) and whose provenance graph held only
`snapshot / chart / dataset / evidence / decision` nodes — **no rule run**.

---

## 1. Prerequisite — bind a semantic profile and link the datasets

A DELTA run resolves `subject_key` and `level_column` from **per-dataset field
mappings**, not from the request. Those mapping rows exist only when the project
has a semantic profile bound **and** the dataset is linked to the project. With
`semanticProfileId: null` the run fails: *"Referent is not compatible with a delta
run: no subject key or pairing axis mapped for this dataset."*

The delta gate matches two hardcoded canonical fields: `patient_id` (subject key)
and `timepoint` (pairing axis). The `immunology` profile's alias set maps
`subject_id → patient_id` and `timepoint → timepoint` automatically.

```
# (a) bind the profile — must be permitted by the workspace policy
PATCH /api/v1/projects/:projectId/profile
      { "profileId": "immunology" }        # or immuno_oncology | oncology

# (b) link each dataset the run will read (recomputes mappings; profile must be set first)
POST  /api/v1/projects/:projectId/datasets
      { "datasetId": "<dataset-id>" }

# (c) verify the two canonical mappings landed as `matched`
GET   /api/v1/projects/:projectId/field-mappings
      → look for  subject_id → patient_id [matched]   and   timepoint → timepoint [matched]
```

- **Profiles are static config, not API-created** — only `GET /api/v1/semantic-profiles`
  (+ `/:id/resolved`, `/:id/config`, `/workspace/:wsId/policy`) exist. Available
  ids: `immunology`, `immuno_oncology`, `oncology`.
- **Order matters**: bind the profile, *then* link datasets — linking recomputes
  mappings only if a profile is already set. Binding also recomputes for
  already-linked datasets.
- `measure` (feature) and `value` (value) are **not** mapped through the profile —
  they are literal per-run request fields (`pivot.featureColumn` / `pivot.valueColumn`).

---

## 2. `ruleId` — any published, executable rule

A DELTA run references a `ruleId`, but the backend only checks the rule exists, is
visible, is `rule:evaluate`-permitted, and is not archived/suppressed — it never
inspects tags or kind. **The delta behaviour comes entirely from `runKind: 'DELTA'`
+ `formula`, not from the rule.** Any published `IMM-*` seed works. (The UI picker
only *offers* rules tagged `relationship-rule`, but that filter is UI-only and not
enforced by the API.)

---

## 3. The DELTA run — verified request

```
POST /api/v1/rule-runs
{
  "ruleId":       "<published-rule-id>",
  "projectId":    "<project-id>",
  "workspaceId":  "<workspace-id>",          // REQUIRED whenever project/dataset/snapshot/analysis is present
  "datasetId":    "<dataset-id>",            // REQUIRED even when snapshotId is sent (see gotcha)
  "snapshotId":   "<analysis-snapshot-id>",  // root the run here so it surfaces in the analysis graph
  "viewAnalysisId": "<analysis-id>",
  "runKind":      "DELTA",
  "formula":      "difference",              // difference | ratio | log2fc | percent_change (NOT operationId — that's STATISTICAL only)
  "ordering":     { "levelFrom": "Baseline", "levelTo": "Post-treatment" },  // literal values in the level column
  "pivot":        { "featureColumn": "measure", "valueColumn": "value" },     // literal source column names
  "outputMode":   "delta_table",             // or "annotate"; default delta_table
  "scope":        "FILTERED",
  "filters":      [ { "column": "measure", "operator": "eq", "value": "TFHtot_cells_uL" } ]
}
→ 201 { "ruleRunId", "status": "QUEUED", "deduped": false, "runFingerprint" }
```

Do **not** send `levelColumn`/`subjectKey` (resolved server-side from §1), nor
`triggeredBy`/`callerIsPlatformAdmin`/`rulePermissions` (gateway sets them).

Execution is async → poll `GET /api/v1/rule-runs/:id` until `status: SUCCEEDED`.
The run computes one delta **per subject** (`value(levelTo) − value(levelFrom)`),
so **each output row is one patient** — that, not a filter, is how the patient is
identified.

### Gotchas found live

- **`snapshotId` still requires `datasetId`.** Sending `snapshotId` alone → 400
  *"Provide either datasetId or stepRunId+artifactName."* Send both.
- **Root the run on a snapshot, or you get a WARN + no analysis provenance.** A run
  with `datasetId` but no `snapshotId` raises the `whole_dataset_referent` WARN and
  its provenance chain hangs off the **Dataset**, so it never appears in the
  analysis's `provenance-graph` (which seeds only from `ViewAnalysisSnapshot`
  nodes). Mint a snapshot on the analysis (`POST /api/v1/view-analyses/snapshots`
  with the slice `filters`) and pass its id.
- **The fingerprint ignores the snapshot binding.** It keys on dataset version +
  operation + params + ordering + `filters`. Re-running the same inputs from a
  snapshot **dedups** to an earlier dataset-rooted run (`status: DEDUPED`, links
  the old node). To force a fresh, snapshot-rooted run give it a distinct
  `filters` scope (e.g. restrict `subject_id`).
- **`GET /:id/table` can 500 while artifacts read as `pending`.** In the worktree
  stack bio-compute uploaded all artifacts (200) and the callback succeeded, yet
  the backend served neither the table nor flipped `artifactRefs.status` to
  available — an internal-vs-public S3 endpoint issue on this stack, not a kernel
  fault. `summaryJson` (with `scope_n` and the resolved parameters) still confirms
  the compute ran. `GET /:id/summary` is the **STRATIFY** summary and 404s for a
  DELTA run — expected.

---

## 3B. A STATISTICAL run — paired t-test (verified)

Same referent resolution as DELTA (needs the semantic profile of §1), but the run
kind carries an **`operationId`** instead of a `formula`, plus `operationParams`.

```
POST /api/v1/rule-runs
{
  "ruleId": "...", "projectId": "...", "workspaceId": "...",
  "datasetId": "...", "snapshotId": "...", "viewAnalysisId": "...",
  "runKind": "STATISTICAL",
  "operationId": "stats.paired_ttest",
  "operationParams": { "alternative": "two_sided", "confidence": 0.95 },
  "ordering": { "levelFrom": "Baseline", "levelTo": "Post-treatment" },
  "pivot": { "featureColumn": "measure", "valueColumn": "value" },
  "scope": "FILTERED",
  "filters": [ { "column": "measure", "operator": "eq", "value": "TFHtot_cells_uL" } ]
}
```

- Executes on bio-compute's `stats_execution` pipeline (built; depends on
  **pingouin** — present in the AXI-1233 image). The `_stats_execution_pipeline()`
  loader fails only the statistical run (not QC/delta/stratify) if pingouin is
  missing (AXI-1177/EC20).
- Result columns (read via `GET /:id/table`): `feature, measurement, nPairs,
  nDroppedSubjects, meanDifference, tStatistic, pValue, effectSize, ciLow, ciHigh,
  reason`. A `reason` is present exactly when the statistics are null
  (too few pairs / zero variance).
- Not fingerprinted/deduped — two identical submissions both execute.

## 3C. A STRATIFY run — encode a published threshold as reference bands (verified)

Partitions the referent rows into declared groups. Used here to encode the
**published Wallace 2015 plasmablast reference** as numeric bands and assign every
measurement to one — a "published threshold, encoded once, applied as a rule".

```
POST /api/v1/rule-runs
{
  "ruleId": "...", "projectId": "...", "workspaceId": "...",
  "datasetId": "...", "snapshotId": "...", "viewAnalysisId": "...",
  "runKind": "STRATIFY",
  "partitionRule": {
    "field": "value", "kind": "numeric",
    "groups": [
      { "id": "healthy",      "label": "< 590/mL",     "max": 590,  "max_inclusive": false },
      { "id": "intermediate", "label": "590-4700/mL",  "min": 590,  "min_inclusive": true, "max": 4700, "max_inclusive": false },
      { "id": "active",       "label": ">= 4700/mL",   "min": 4700, "min_inclusive": true }
    ]
  },
  "scope": "FILTERED",
  "filters": [ { "column": "measure", "operator": "eq", "value": "plasmablasts_cells_mL" },
               { "column": "timepoint", "operator": "eq", "value": "Baseline" } ]
}
```

- `partitionRule.kind` is `"numeric"` (bands with `min`/`max` + `_inclusive`
  sides) or `"categorical"` (each group carries `levels: [...]`). `field` is a
  literal source column.
- Executes on bio-compute's `stratify_execution` pipeline.
- **Read the result with `GET /:id/summary`, NOT `/:id/table`.** A stratify run
  produces `stratify_assignments`, not `delta_features`, so `/table` 400s
  ("has no delta_features.parquet"). `/summary` returns `scopeN`, `unassignedN`,
  `overlappingN`, and per-`groups` `{groupId, groupLabel, n, nodeId}`.
- Each group also materializes its **own** `MaterializedView` provenance node
  (plus one `StratifyRun` node), so a group can itself be pinned as a referent for
  a downstream run.

## 3D-pre. `outputMode` decides whether the result MERGES onto the table

This is the difference between "I ran a rule and nothing appeared on my table" and
"a new column showed up":

- **`outputMode: "delta_table"`** (the default) emits a **separate, collapsed**
  table at `(subject, feature)` grain — one row per subject with
  `value_<from>` / `value_<to>` / `delta_value`. It does **NOT** add a column to
  the source rows. Right when you want the deltas as their own compact table.
- **`outputMode: "annotate"`** **preserves every referent row and adds the delta
  as columns** (`delta_value`, `delta_value_state`) on the `level_to` row
  (`level_from` rows carry `null`). This is the "add a new column to the original
  table" behaviour.

**How the result reaches the analysis UI (either mode): a `rule_derived`
snapshot.** A successful run materializes a new snapshot on the analysis with
`origin: "rule_derived"` carrying the `ruleRunId` (list them via
`GET /view-analyses/:id/snapshots` — it is the highest-version entry whose
`ruleRunId` matches your run). Selecting that snapshot in Explore → Table is what
shows the result; with `annotate` that table is the **original rows merged with the
new delta columns**. If you run `delta_table` and then look at the *original*
snapshot, you correctly see no new column — the result lives on the
`rule_derived` snapshot, and as a per-subject table rather than a merged column.
**So: to get a new column merged onto the table, run `annotate` and open the
`rule_derived` snapshot the run created.**

Other run kinds surface differently, by design:
- **STRATIFY** does not merge a band column onto the rows; it materializes one
  `rule_derived` **filtered snapshot per group** (each group's members as a slice,
  `ruleRunId` set) plus the `/summary` group counts. The "band" is the group a row
  belongs to, expressed as membership of a group snapshot, not a cell value.
- **STATISTICAL** produces a **per-feature summary** (`GET /:id/table` — one row per
  feature with `tStatistic`/`pValue`/…), not a per-row column, and does **not**
  create a `rule_derived` snapshot. Read it from the run, cite it as evidence — do
  not expect it to annotate the source table.

## 3D. Reading a run's result — endpoints and a build gotcha

| Run kind | Result endpoint | Shape |
|---|---|---|
| DELTA | `GET /:id/table` | one row per subject: `value_<from>`, `value_<to>`, `delta_value`, `delta_value_state` |
| STATISTICAL | `GET /:id/table` | one row per feature: `tStatistic`, `pValue`, `effectSize`, `ciLow/ciHigh`, … |
| STRATIFY | `GET /:id/summary` | `groups[]` with per-band `n`; `/table` 400s by design |

**Build gotcha — `/table` 500 with `Cannot read properties of undefined (reading
'openBuffer')`.** The backend reads result parquet via `@dsnp/parquetjs`, whose
transitive `thrift` does a CommonJS `require("uuid")`. If the resolved `uuid` is an
ESM-only build (v9+ ship `"type":"module"`), the require throws `ERR_REQUIRE_ESM`
during module init and `ParquetReader` comes back `undefined` — so **every**
rule-run table read 500s while the S3 download itself succeeds. Fix: ensure
`thrift`'s `uuid` resolves to a CommonJS build (uuid **8.3.2** exposes the
`parse`/`stringify` thrift needs). The durable fix is a package `overrides` entry
(`"thrift": { "uuid": "8.3.2" }`); an offline hot-fix is to remove `thrift`'s
nested ESM `uuid` so it falls back to a top-level uuid that still exposes a CJS
`require` condition, then reload the org-service process.

## 4. Provenance & citation

On success `DeltaProvenanceMaterializerService` appends one **`MaterializedView`**
node (`referenceId` = the ruleRunId; metadata carries `ruleId`, `operationId`,
`ordering`, `pivot`, `filters`, `libraryPin`, `preconditionWarnings`) and wires
`snapshot → MaterializedView → resultDataset → resultSnapshot` with `DERIVED_FROM`
edges.

```
GET /api/v1/view-analyses/:analysisId/provenance-graph
→ nodes[].nodeType includes "MaterializedView"; referenceId = ruleRunId
```

Verified: the graph went 8 → 13 nodes with a `MaterializedView` (the delta run)
and new `DERIVED_FROM` edges once the run was snapshot-rooted.

**Citing a delta output as evidence is a different path from a chart.** A delta
result is cited as its **MaterializedView** node (`RULE_RUN_PATTERNS.CREATE_CITATION_EDGE`
→ a `CITES` edge to the Decision), **not** via `chartEntries[].chartArtifactId`
(that is the separate chart-evidence path). Note: no gateway REST route surfaces
the citation message pattern today — it is invoked from the decisions/summaries
flow, not directly over HTTP.

---

## 5. The comparability gate (Safe Compare) over REST

The two-referent comparability gate is live and **reads no tenant data**:

```
POST /api/v1/rule-runs/comparability   { <two referents' comparability facts>, <baseline declaration> }
→ comparable | blocked (naming the failing axis) | "blocked pending metadata capture"
```

It evaluates the caller-supplied facts (cryo state, panel, gating version,
denominator, unit/scale, batch). On real draws those facts are **not captured**
(`ComparabilityMetadata` is nullable and empty), so it returns *"blocked pending
metadata capture"* — the honest state, not a false pass. This is a gate over
supplied facts, distinct from executing a delta/stratify comparison on tenant data.

---

## 6. Other REST facts confirmed this session

- **`PATCH /view-analyses/:id/review-question` 500s on text longer than ~256
  characters.** Silent 500, not a 400. Keep questions short.
- **Candidate charts support `DELETE`**: `DELETE /workspaces/:ws/datasets/:ds/candidates/:specId` → 204.
- **`snapshot-comments` list shape is `{ comments: [...] }`**, not `{ data: [...] }`.
- **Analysis-level comments**: `POST /api/v1/snapshot-comments`
  `{ anchorType: "view_analysis", anchorId, commentType, content }`;
  `commentType ∈ { question, interpretation_note, qc_concern, assumption, action_item }`.
- **Project needs `X-Workspace-Id`** on every `/projects/*` call even with
  `workspaceId` in the body (as in `REST-API-Guide.md` §5).

---

## 7. Errors hit while wiring this up — and how to avoid them

A dense checklist so the next agent doesn't rediscover these. Each row is a real
error seen driving the four Safe-Compare comparison scenarios over REST.

| Symptom (actual error) | Cause | Fix |
|---|---|---|
| `Referent is not compatible with a delta run: no subject key or pairing axis mapped for this dataset` | The project has no semantic profile, or the dataset isn't **linked** to the project, so no `projectFieldMapping` rows exist. | `PATCH /projects/:id/profile {profileId:"immunology"}` **then** `POST /projects/:id/datasets {datasetId}` for **every** dataset the run reads (§1). Verify `subject_id→patient_id` + `timepoint→timepoint` are `matched` via `GET /projects/:id/field-mappings`. |
| Run succeeds but **isn't in** `GET /view-analyses/:id/provenance-graph`; run carries a `whole_dataset_referent` WARN | Ran with `datasetId` only — referent is the Dataset, and the graph seeds only from `ViewAnalysisSnapshot` nodes. | Mint a snapshot on the analysis and pass `snapshotId` **and** `datasetId` (both required — `snapshotId` alone 400s "Provide either datasetId or stepRunId+artifactName"). |
| Re-run returns `status:"DEDUPED"`, links an old result | The run fingerprint keys on dataset-version + operation + params + ordering + `filters`, **not** the snapshot. Same inputs from a different snapshot dedup. | Give the fresh run a distinct `filters` scope (e.g. restrict `subject_id`) to force execution. STATISTICAL runs are never deduped. |
| Ran a rule but **no new column / result appears on the table** | DELTA default `outputMode:"delta_table"` emits a *separate* per-subject table; it does not merge. | Use `outputMode:"annotate"` — it adds `delta_value`/`delta_value_state` onto the referent rows and materializes a `rule_derived` snapshot (§3D-pre). Open that snapshot to see the merged columns. |
| STRATIFY run FAILED: `referent has N subject(s) with conflicting values for partition field '…'` | STRATIFY is **subject-level** — the partition field must be constant across all of a subject's rows. A per-row-varying column (e.g. `organ_canonical`, one row per organ) can't partition subjects. | Partition on a per-subject-constant field, or filter to one row per subject first (e.g. one `timepoint`) so a numeric `value` band is well-defined. |
| STRATIFY `/table` → 400 `has no delta_features.parquet` | Stratify writes `stratify_assignments`, not `delta_features`; `/table` is delta/stats-shaped. | Read stratify via `GET /:id/summary` (per-group `n`). Its result surfaces as one **`origin:'filter'` group snapshot per group** (not `rule_derived`). |
| STATISTICAL run has **no result snapshot** to open in the UI | By design (AXI-1177) a STATISTICAL run materializes only a `MaterializedView` provenance node — no `rule_derived` snapshot, no result Dataset ("a table of p-values is a result *about* a dataset"). | Read the result via `GET /:id/table`; it's citable as evidence via its `MaterializedView` node, but there is no snapshot. For a *viewable* result, add a DELTA (merged columns) or STRATIFY (group snapshots) run. |
| Every rule-run `GET /:id/table` → 500 `Cannot read properties of undefined (reading 'openBuffer')` | Backend parquet reader `@dsnp/parquetjs`→`thrift` does CJS `require("uuid")`, but the resolved `uuid` is ESM-only (`type:"module"`) → `ERR_REQUIRE_ESM`, `ParquetReader` undefined. | Make `thrift`'s `uuid` a CommonJS build (v8.3.2). Durable: package `overrides: {thrift:{uuid:"8.3.2"}}`. Offline hot-fix: remove `thrift/node_modules/uuid` so it falls back to a top-level uuid with a CJS `require` condition, then reload org-service. |
| `PATCH /view-analyses/:id/review-question` → 500 on long text | Server 500 (not 400) above ~256 characters. | Keep review questions ≤ ~250 chars. |
| "Run relationship rule" picker is **empty** | The picker only offers rules with tag `relationship-rule` and `status:"published"`; the seeded `IMM-CMP` rules aren't tagged, and **published rules can't be edited** ("Only draft rules can be edited"). | Create a **draft** rule with `tags:["relationship-rule"]` (add `"stratify"` for a STRATIFY member; default is DELTA), then `POST /rules/:id/publish`. Publishing enforces **protocol compliance**: pick `protocolType:"FEATURE_RULE"` and supply `outputFields:[{key:"feature_name",type:"string"},{key:"value",type:"number"}]` (a lean valid set). `scope:"system"` needs a platform admin — use `scope:"workspace"`. |
| Evidence `POST /view-analyses/evidences` with `citationContext.kind:"table"` → 500 | The table-citation (rule-run) evidence path fails server-side (Evidence Type Registry needs a registered table type). Note table citation also *requires a `rule_derived` snapshot* — stratify group snapshots (`origin:'filter'`) and statistical runs (no snapshot) can't use it anyway. | Cite the result with **chart-citation** instead: `chartEntries:[{chartArtifactId, snapshotId:<the rule's result/group snapshot>, datasetVersionId}]` — this works for delta, stratify and (via any chart at a filter snapshot) statistical. |
| `POST /view-analyses/publish` keeps making new versions | No uniqueness constraint — every call mints another published version. | Guard client-side: `GET /view-analyses/:id/published-versions` and skip if you don't intend a new version. |
| API 401 mid-session on a long run | Access token TTL is short. | Re-login and refresh the bearer before long sequences; scripts should re-auth on 401. |
| `npm install` inside the AXI-1233 backend container hangs / locks everyone out | The container CMD is `apk add … && npm install && npm run dev`; a polluted `node_modules` (e.g. after a manual nested install) makes the startup `npm install` reconcile over a registry it can't reach reliably, so `npm run dev` never starts. | **Never `npm install` in that container.** Recover a stuck one with `docker exec -d <c> sh -c 'cd /app && npm run dev'` (node_modules is already populated); reload one service with `touch apps/<svc>/src/main.ts` (nest `--watch`). |

**One consolidated happy-path recipe** (delta with a visible merged result, cited, published):
1. `PATCH /projects/:id/profile {profileId:"immunology"}` → `POST /projects/:id/datasets {datasetId}` (per dataset) → verify field-mappings.
2. `POST /view-analyses/snapshots {viewAnalysisId, filters:[…slice…]}` → snapshotId.
3. `POST /rule-runs {runKind:"DELTA", formula:"difference", outputMode:"annotate", snapshotId, datasetId, viewAnalysisId, ordering, pivot, filters}` → poll `GET /rule-runs/:id` to SUCCEEDED.
4. Find the run's `rule_derived` snapshot: `GET /view-analyses/:id/snapshots` (origin `rule_derived`, matching `ruleRunId`).
5. Evidence: `POST /view-analyses/evidences {viewAnalysisId, chartEntries:[{chartArtifactId, snapshotId:<rule_derived snap>, datasetVersionId}], title, text}`.
6. Decision: `POST /workspaces/:ws/decisions {label, type, confidence, context:{intendedUse:"RUO"}, evidenceLinks:[{evidenceId}]}` → transition `reviewed` → `approved`.
7. Publish: `POST /view-analyses/publish {viewAnalysisId, evidenceVersionIds:[currentVersion.id], decisionIds:[decisionId]}`.

---

## 8. Evidence charts that render on the evidence page but are EMPTY in the review

Two separate traps make an evidence `chartEntry` render live-fine yet blank in the
**published/review section** (`SponsorReviewDocument.tsx` → `EvidenceDetailDrawer`).
The review builds a **frozen Plotly config** by querying the dataset and applying
the chart spec's own filters — a different path from the evidence page (which
renders live against the snapshot), so the evidence page masks both bugs.

1. **`chartEntry.datasetVersionId` must be the DATASET id, not the ingestion
   version id.** The review renders via `POST /workspaces/:ws/datasets/{datasetVersionId}/query`,
   which keys on the **dataset id** (e.g. `98141138-…`). Passing the ingestion's
   `latestIngestion.datasetVersionId` (e.g. `a60911dc-…`) makes that query return
   **`Dataset not found` → 0 rows → an empty chart in the review**, while the
   evidence page still renders. Confirm with: `/datasets/<dataset-id>/query` returns
   rows but `/datasets/<version-id>/query` 404s. Use the **dataset id** in
   `chartEntry.datasetVersionId` (the field name is a misnomer).
2. **Cite the chart at a snapshot that carries the chart's data scope, not the
   rule-result snapshot.** A by-cohort boxplot cited at a DELTA `rule_derived`
   snapshot (only the treated arm) or a STRATIFY group snapshot (one band) loses the
   other cohorts and renders empty/near-empty. Mint a snapshot whose filters match
   the chart's own scope (e.g. `measure=…, timepoint=Baseline` across all cohorts)
   and cite the chart there; the rule run stays linked via provenance.

Also: **`PATCH /view-analyses/evidences/:id` REPLACES the version — always resend
`title` + `text` alongside `chartEntries`**, or the title/text blank out (sending
`chartEntries` alone wiped the title). And a **published version is immutable**:
fixing the evidence does not retro-update an already-published version — you must
publish again to bundle the corrected evidence version into a new review version.

### 8b. The definitive rule: an evidence chart must live on the ANALYSIS's own dataset

The two rendering surfaces resolve the chart's dataset **differently**, and both
must succeed:

- **Evidence page** (`EvidenceDetail.tsx`) renders charts against
  **`viewAnalysis.datasetId`** — the analysis's own dataset — and ignores the
  chart entry's `datasetVersionId`.
- **Review section** (`SponsorReviewDocument.tsx` → `EvidenceDetailDrawer`) renders
  against **`chartEntry.datasetVersionId`** (which must be the dataset **id**, §8.1).

Consequence: a chart from a *different* dataset than the analysis (e.g. a FLOW
chart cited on an organ-bound analysis via a linked snapshot) will render on one
surface and fail on the other (`Dataset not found` on the evidence page). **Cite
only charts whose dataset equals the analysis's `datasetId`, and set
`chartEntry.datasetVersionId` to that same dataset id.** If a scenario's finding
lives on a different dataset than its analysis, the honest options are: put the
analysis on that dataset, or cite a chart from the analysis's own dataset and
carry the cross-dataset result in the evidence text + provenance (a linked snapshot
still puts the rule run in the analysis's provenance graph).

### 8c. Two traps that hide the real error from you

- **You may be reading the wrong log stream.** If the backend was started by hand
  inside the container (the recovery in §7: `docker exec -d <c> sh -c 'cd /app &&
  npm run dev > /tmp/devlog 2>&1'`), then **`docker logs` shows only the original
  PID-1 chain, not the stack that is actually serving requests**. Every 4xx/5xx
  you are chasing is in **`/tmp/devlog` inside the container**
  (`docker exec <c> sh -c 'sed -E "s/\x1b\[[0-9;]*m//g" /tmp/devlog | grep -iE "… - 500|RpcExceptionsHandler"'`).
  Symptom: a reproducible 500 with *no* matching line in `docker logs`. Also note
  the container log clock differs from the API `timestamp` (it logged an 11:28
  local event as `9:28 AM`) — search by request path, not by wall-clock time. If
  PID-1's chain later finishes its `npm install`, its second `npm run dev` collides
  on the ports (`EADDRINUSE :::3004`) and its services die, leaving the manual
  stack as the sole server — confirm with `ps`/`netstat` inside the container.
- **"Dataset not found" on the evidence page can be a stale client cache.** After
  you fix a chart entry's ids, the page may keep showing the *previous* request's
  error (the earlier bad ids genuinely 404'd). Confirm with a live watcher on the
  serving log stream while doing a **hard reload** (bypass cache): if nothing is
  logged and the page renders, it was cache — not a data problem.

### 8d. `POST /thresholds` 500 `Argument 'operator' is missing` — use the symbol, not the db token

`ThresholdOperator` (the accepted request value) is **`'>=' | '<=' | '>' | '<' | 'between'`**.
The service maps it through `OPERATOR_TO_DB` to the stored token (`gte/lte/gt/lt/between`).
Sending the *stored* token (`"gte"`) is not a key of that map, resolves to `undefined`,
and — because that mapping isn't inside the 400 try/catch — surfaces as a raw
**500 `PrismaClientValidationError: Argument 'operator' is missing`**, not a
validation 400. `value` is a scalar for the comparison operators and a `[lo, hi]`
pair only for `between`. Verified: `>=` at 590 and 4700 on the S4 plasmablast
boxplot created cleanly and render as the Wallace reference lines.

### 8e. Where declared thresholds actually render

Thresholds reach the plot only via `params.__thresholds`, which is injected in
**exactly one place**: `DatasetChart.tsx` (the "Inspect chart in detail" view).
The evidence gallery cards (`DatasetVisualizations` / `VisualizationCard`), the
evidence drawer, and the review's frozen config (`SponsorReviewDocument` →
`buildPlotlyConfig`) do **not** fetch or inject thresholds, so a declared cutoff
is *not* drawn on those thumbnails. Consequence: declaring a published reference
as a Threshold is the correct, provenance-linked way to encode it (and it shows
in the inspector, with its citation Annotation), but it will not visually
distinguish two same-template charts on the evidence/review surfaces. If a
scenario needs to look different *at a glance* there, change the chart's form
(template/data), not just its thresholds.
