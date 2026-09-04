# Axiome — REST Operating Manual for Agents

**Purpose.** Everything an autonomous agent needs to operate the Axiome platform
**entirely over its REST API** — create a governed study, run deterministic rules
(delta, statistical test, stratification), cite the results as evidence, record an
interpretation, and publish — **without access to source code, a database, or the
UI.** Every route, shape, ordering rule and failure mode below was verified against
a live instance. Nothing here requires reading code.

**Audience.** A third-party or automated client holding only an HTTP client and a
user credential. **Regulatory posture:** the platform is *Research Use Only (RUO)*
— it never asserts a diagnosis; outputs describe where a *measurement* sits, never
what a *patient* is (see §12).

---

## 1. Connection and authentication

| | |
|---|---|
| Base URL | `https://<host>/api/v1` (local dev: `http://localhost:<port>/api/v1`) |
| Auth model | plain email + password → JWT. **There are no API keys, service accounts or impersonation.** A "service identity" is an ordinary user whose password your client holds. |

```
POST /auth/login          { "email": "...", "password": "..." }
  → 200 { "accessToken": "<jwt>", "refreshToken": "<jwt>" }
GET  /auth/me             → your own user id / email (the only self-lookup)
```

Send `Authorization: Bearer <accessToken>` on every call.

**Two rules that bite:**
- **Access tokens expire quickly.** Any long sequence must **re-login on a 401** and
  retry; do not assume a token lasts a session.
- **`X-Workspace-Id: <workspaceId>` is required on every `/projects/*` call** even
  when `workspaceId` is also in the body. Send it on all workspace-scoped calls.

---

## 2. The resource model and the order you must create things in

Dependencies are enforced by what later calls need to exist. Create in this order:

```
organization → workspace → project → dataset (+ingestion)
  → project gets a semantic profile, datasets get linked      (§3 — required before any rule run)
  → analysis (view-analysis) framing: review question, assumptions
    → snapshots (a frozen filter slice of the analysis)
      → charts  (user-created; bound to the analysis)
      → thresholds + citation annotations   (on a chart)
      → rule runs (rooted on a snapshot)     (§6)
        → evidence  (cites a chart at a snapshot)   (§9)
          → decision / interpretation (cites evidence) → reviewed → approved
            → publish (bundles evidence versions + decisions)   (§10)
```

**Publish is append-only and has no uniqueness constraint** — every call mints a
new version; enforce "publish once" client-side (§10).

### 2.1 Discovering datasets and reading rows

```
GET  /workspaces/{ws}/datasets?page=1&limit=50
  → { "data": [ { "id", "originalFilename", "availability", "latestIngestion": { "rowCount", ... } } ] }

POST /workspaces/{ws}/datasets/{datasetId}/query
     { "filters": [ { "column": "measure", "operator": "eq", "value": "TFHtot_cells_uL" } ],
       "limit": 500, "offset": 0 }
  → { "rows": [ { "<column>": <value>, ... } ] }
```

Filter operators: `eq`, `in` (value is an array). **Use the dataset `id` in these
paths — never an ingestion/version id** (§13, trap 1).

Long-format flow data looks like `{ subject_id, cohort, timepoint, measure, value }`:
one row per subject × timepoint × measure. Discover the distinct `measure` /
`timepoint` / `cohort` values by querying and de-duplicating before you design
charts or runs — **a paired (before→after) run needs a measure that actually has
both timepoints per subject.**

---

## 3. Prerequisite for any rule run: semantic profile + linked datasets

Rule runs resolve which column is the **subject key** and which is the **pairing
axis** (timepoint) from *per-dataset field mappings*. Those mappings exist only when
the project has a semantic profile **and** the dataset is linked to the project.
Without them every run fails with:

> `Referent is not compatible with a delta run: no subject key or pairing axis mapped for this dataset`

```
# 1) bind a profile (static, pre-defined; not creatable via API)
PATCH /projects/{projectId}/profile        { "profileId": "immunology" }      # immunology | immuno_oncology | oncology

# 2) link EVERY dataset a run will read (mappings are computed on link; profile must already be set)
POST  /projects/{projectId}/datasets       { "datasetId": "<datasetId>" }      → 201

# 3) verify the two canonical mappings are `matched`
GET   /projects/{projectId}/field-mappings
  → rows containing  subject_id → patient_id [matched]   and   timepoint → timepoint [matched]
```

The profile maps common aliases automatically (`subject_id` → `patient_id`,
`timepoint`). The feature column and value column are **not** mapped — you name
them per run (§6). Order matters: **profile first, then link.**

---

## 4. Analyses, framing, snapshots

```
POST  /view-analyses                       { "projectId", "datasetId", "name" }          → { "id" }
GET   /view-analyses?projectId={id}&origin=user_created                                → { "data": [...] }
PATCH /view-analyses/{id}/review-question  { "text": "..." }      # ≤ ~250 chars — longer text returns a 500
POST  /view-analyses/{id}/assumptions      { "type": "cohort_definition" | "data_filter" | "methodological_choice" | "domain_assumption", "text": "..." }
GET   /view-analyses/{id}/framing
```

**Snapshots** freeze a filter slice of an analysis and are what everything else
hangs off (charts render at a snapshot; rule runs are rooted on one; evidence
cites one).

```
POST /view-analyses/snapshots
     { "viewAnalysisId": "...", "filters": [ ...same filter objects as §2.1... ] }
     # to point an analysis at a DIFFERENT dataset than its own: add  "datasetId": "...", "origin": "linked"
  → { "id", "version" }

GET  /view-analyses/{id}/snapshots?page=1&limit=40        # page is REQUIRED (omitting it errors)
  → { "data": [ { "id", "version", "origin": "filter" | "linked" | "rule_derived", "ruleRunId", "datasetId", "filters" } ] }
```

`origin` tells you what a snapshot is: `filter` (a slice you minted), `linked`
(a slice on another dataset), **`rule_derived` (the result of a rule run — carries
`ruleRunId`)**. There is no single-snapshot GET; use the list.

---

## 5. Charts (visualization specs)

A chart is a template + column bindings + frozen filters, created against a
dataset and bound to an analysis.

```
POST /workspaces/{ws}/datasets/{datasetId}/candidates?viewAnalysisId={analysisId}
{
  "templateId": "boxplot_v1", "templateVersion": "1.0.0",
  "bindings": { "y": { "column_id": "col_value" }, "group": { "column_id": "col_cohort" } },
  "params": {}, "filters": [ { "column": "measure", "operator": "eq", "value": "plasmablasts_cells_mL" } ],
  "combinator": null, "columnCombinators": null,
  "title": "Plasmablasts (cells/mL) at Baseline by cohort",
  "viewAnalysisId": "{analysisId}"
}
  → 201 { "id", "origin": "user", "datasetVersionId", ... }

GET    /workspaces/{ws}/datasets/{datasetId}/candidates          → all specs on the dataset (origin "auto" or "user")
DELETE /workspaces/{ws}/datasets/{datasetId}/candidates/{specId} → 204
```

- Column ids are **`col_<column name>`**.
- Templates seen live and their bindings: `boxplot_v1` `{y, group}` ·
  `faceted_grouped_line_v1` `{x, y, color, facet}` · `faceted_grouped_boxplot_v1`
  `{x, y, facet}` · `bar_count_v1` `{x}` · `treemap_v1` `{labels, parents}` ·
  `sunburst_v1` `{labels, parents}` · `table_preview_v1` `{}`.
- Never trigger auto-generation routes; create only `origin:"user"` charts.
- **A chart must live on the same dataset as the analysis it will be cited from** (§13, trap 2).

---

## 6. Rule runs — the deterministic compute

```
POST /rule-runs   → 201 { "ruleRunId", "status": "QUEUED" | "DEDUPED", "runFingerprint" }
GET  /rule-runs/{id}   → { "status": QUEUED|RUNNING|SUCCEEDED|FAILED|DEDUPED, "summaryJson", "preconditionWarnings", "materializedNodeId", "errorMessage" }
GET  /rule-runs/operations   → the registered operations and their parameters
```

Execution is asynchronous: **poll `GET /rule-runs/{id}` until `SUCCEEDED`/`FAILED`.**

Common fields for every kind: `ruleId`, `projectId`, `workspaceId` (**required**),
`datasetId` (**required even when `snapshotId` is given**), `snapshotId`,
`viewAnalysisId`, `runKind`, `scope:"FILTERED"`, `filters`.

`ruleId` may be **any published rule** — the run's behaviour comes from `runKind`,
not from the rule. Pick a thematically apt published rule (`GET /rules?status=published&limit=100`).

### 6.1 DELTA — a value against the same subject's other timepoint (self-reference)

```
{ "runKind": "DELTA", "formula": "difference",                      # difference | ratio | log2fc | percent_change
  "ordering": { "levelFrom": "Baseline", "levelTo": "Post-treatment" },   # literal values of the timepoint column
  "pivot":    { "featureColumn": "measure", "valueColumn": "value" },      # literal source column names
  "outputMode": "annotate",                                          # see below
  "filters": [ { "column": "measure", "operator": "eq", "value": "TFHtot_cells_uL" } ] }
```

Computes `value(levelTo) − value(levelFrom)` **once per subject** — each output row
*is* one subject. That, not a filter, is how a patient is identified.

**`outputMode` decides whether the result merges onto your table:**
- `"delta_table"` (default) → a *separate* collapsed table, one row per subject:
  `subject_id, value_Baseline, value_Post-treatment, delta_value, delta_value_state`.
- `"annotate"` → **keeps every source row and adds `delta_value` / `delta_value_state`
  as new columns** on the `levelTo` row. Use this when you want "a new column on the table."

Read the result: `GET /rule-runs/{id}/table?page=1&limit=50 → { "rows": [...] }`.

### 6.2 STATISTICAL — a governed published test (paired t-test)

```
{ "runKind": "STATISTICAL", "operationId": "stats.paired_ttest",
  "operationParams": { "alternative": "two_sided", "confidence": 0.95 },   # alternative: two_sided | greater | less
  "ordering": { "levelFrom": "Baseline", "levelTo": "Post-treatment" },
  "pivot": { "featureColumn": "measure", "valueColumn": "value" },
  "filters": [ ...restrict to one measure and the paired subjects... ] }
```

Result (`/table`): one row per feature — `nPairs, nDroppedSubjects, meanDifference,
tStatistic, pValue, effectSize, ciLow, ciHigh, reason` (`reason` is set exactly
when the statistics are null: too few pairs / zero variance). Not de-duplicated.

### 6.3 STRATIFY — partition subjects into declared groups (bands, categories)

```
{ "runKind": "STRATIFY",
  "partitionRule": { "field": "value", "kind": "numeric",
    "groups": [ { "id": "low",  "label": "< 590/mL",   "max": 590,  "max_inclusive": false },
                { "id": "mid",  "label": "590–4700",   "min": 590,  "min_inclusive": true, "max": 4700, "max_inclusive": false },
                { "id": "high", "label": ">= 4700/mL", "min": 4700, "min_inclusive": true } ] },
  "filters": [ { "column": "measure", "operator": "eq", "value": "plasmablasts_cells_mL" },
               { "column": "timepoint", "operator": "eq", "value": "Baseline" } ] }
```

`kind` is `"numeric"` (bands with `min`/`max` + `_inclusive`) or `"categorical"`
(each group carries `"levels": [...]`). This is the way to **encode a published
threshold once** and apply it to every measurement.

**STRATIFY is subject-level: the partition field must be constant across all of a
subject's rows.** A field that varies within a subject (one row per organ, per
measure…) is rejected: `referent has N subject(s) with conflicting values for
partition field`. Filter to one row per subject first (e.g. one timepoint).

Read the result with **`GET /rule-runs/{id}/summary`** (`scopeN`, `unassignedN`,
`groups[] { groupId, groupLabel, n }`). `/table` is *not* for stratify (400).

### 6.4 How a run's result reaches the analysis — and the two rules that make it visible

1. **Root the run on a snapshot of the analysis** (`snapshotId` + `datasetId` +
   `viewAnalysisId`). A run given only `datasetId` still executes but raises the
   warning `whole_dataset_referent` and **never appears in the analysis's provenance
   graph** (which is seeded from the analysis's snapshots).
2. **A re-run with identical inputs is DEDUPED** (fingerprint = dataset version +
   operation + params + ordering + `filters`; the snapshot is *not* part of it). To
   force a fresh, snapshot-rooted run, give it a distinct `filters` scope.

What each kind materializes:

| Kind | Provenance node | Snapshot created on the analysis | Read result |
|---|---|---|---|
| DELTA | `MaterializedView` | **one `rule_derived` snapshot** (`ruleRunId` set) — open it to see the result; with `annotate` it is the source table + new columns | `/table` |
| STRATIFY | `StratifyRun` + one node per group | **one `filter` snapshot per group** (each group's members) | `/summary` |
| STATISTICAL | `MaterializedView` only | **none** (by design — a table of p-values is a result *about* a dataset, not a dataset) | `/table` |

```
GET /view-analyses/{id}/provenance-graph
  → { "nodes": [ { "id", "nodeType", "referenceId", "metadata" } ], "edges": [ { "type": "DERIVED_FROM" | "SUPPORTS" | "INFORMED" | "CONTAINS" } ] }
```
A rule run shows as a node whose `referenceId` is the `ruleRunId`.

### 6.5 The two-referent comparability gate (Safe Compare)

```
POST /rule-runs/comparability   { <comparability facts for each of two referents>, <baseline declaration> }
  → 200  comparable | blocked (naming the failing axis + reason) | "blocked pending metadata capture"
```
Evaluates caller-supplied facts (gate parent/denominator, cryopreservation state,
panel, gating-strategy version, unit/scale, batch); reads no tenant data. A blocked
comparison is a **200 with a stated reason, never an error.** Where the upstream
metadata is not captured, the honest verdict is *blocked pending metadata capture*.

---

## 7. Rules (the governed rule registry) and the UI "relationship rule" picker

```
GET   /rules?status=published&limit=100
POST  /rules  { "code", "title", "question", "logicSummary", "signals": [...],
                "scope": "workspace", "category": "qc_guard", "protocolType": "FEATURE_RULE",
                "tags": ["relationship-rule"], "workspaceId" }                       → draft
PATCH /rules/{id}   { ...fields..., "outputFields": [...] }      # DRAFTS ONLY — published rules cannot be edited
POST  /rules/{id}/publish
```

- `scope:"system"` requires a platform administrator → use `"workspace"`.
- **Publishing enforces protocol compliance**: each `protocolType` needs specific
  `outputFields`. The leanest valid set is `protocolType:"FEATURE_RULE"` with
  `outputFields:[{"key":"feature_name","type":"string"},{"key":"value","type":"number"}]`.
- The UI's "Run relationship rule" picker lists only rules tagged **`relationship-rule`**
  (+ `stratify` to run as STRATIFY; otherwise DELTA) **and** `status:"published"`.
  The statistical test is not a member of that family — run it via §6.2.

---

## 8. Thresholds (published reference lines) and their citations

The platform's native way to *"encode a published threshold once, with its
reference and applicability condition."*

```
POST /thresholds   { "visualizationSpecId": "<chart id>", "field": "value",
                     "operator": ">=",            # ">=" | "<=" | ">" | "<" | "between"   — the SYMBOL
                     "value": 4700,               # a [lo, hi] pair only for "between"
                     "label": "Wallace 2015 — active untreated IgG4-RD median (~4700/mL)" }   → { "id" }
POST /annotations  { "visualizationSpecId", "text": "<the citation and applicability condition>",
                     "author": "...", "target": { "type": "threshold", "thresholdId": "<id>" } }
GET  /visualization-specs/{specId}/thresholds?status=active
```

**Send the operator as the symbol.** The stored token (`"gte"`) is *not* accepted
and produces a raw **500 `Argument 'operator' is missing`** rather than a 400.
Thresholds render as reference lines in the chart's detailed inspector; they are
not drawn on evidence thumbnails or the review page (see §13, trap 7).

---

## 9. Evidence — citing a chart (and a rule result) as the warrant

```
POST /view-analyses/evidences
{ "viewAnalysisId": "...",
  "chartEntries": [ { "chartArtifactId": "<chart id>", "snapshotId": "<snapshot id>", "datasetVersionId": "<DATASET id>" } ],
  "title": "<states the finding>", "text": "<numbers, comparator, caveat>" }
  → 201 { "id", "currentVersion": { "id" } }

PATCH /view-analyses/evidences/{id}        { "chartEntries": [...], "title", "text" }   # REPLACES the version — resend all three
PATCH /view-analyses/evidences/{id}/status { "status": "draft" | "approved" | "unapproved" }   # "unapproved" = retire
GET   /view-analyses/{analysisId}/evidences?page=1&limit=30   → { "data": [...] }
GET   /view-analyses/evidences/{id}        → full record incl. currentVersion.charts[] {chartArtifactId, snapshotId, datasetVersionId}
```

**Three rules that decide whether the cited chart actually renders (see §13):**
1. `datasetVersionId` must be the **dataset id** (the id in `/datasets/{id}`), not an
   ingestion/version id — despite the field's name.
2. The chart must belong to the **analysis's own dataset**.
3. Cite the chart at a snapshot that carries the **chart's full data scope** — not at
   a narrow rule-result snapshot that strips the other groups.

To tie evidence to a rule result, cite the chart at the run's `rule_derived`
snapshot (delta) or a group snapshot (stratify). There is **no evidence delete**;
retire with status `unapproved`.

**Write descriptive evidence.** Title = the finding as a sentence; text = the real
numbers, the named comparator, the surviving-point count, and the honest caveat:

> *"Circulating TFH falls from each patient's own baseline in 10 of 11 treated
> patients"* — *"…fell in 10/11 (median 36→18 cells/µL); IGG4-004 is the lone riser
> (44→105). The count fell, per patient — not a claim about the patient."*

---

## 10. Decisions (interpretations) and publishing

```
POST /workspaces/{ws}/decisions
  { "label", "type": "phenotype_classification" | "qc_assessment" | "cohort_stratification" | "biomarker_threshold" | "assay_qualification",
    "confidence": "low" | "medium" | "high", "context": { "intendedUse": "RUO" },
    "evidenceLinks": [ { "evidenceId": "..." } ] }                                   → { "id", "status": "draft" }
POST /workspaces/{ws}/decisions/{id}/transition   { "targetStatus": "reviewed" }   # single-step: draft→reviewed→approved
POST /workspaces/{ws}/decisions/{id}/transition   { "targetStatus": "approved" }

POST /view-analyses/publish   { "viewAnalysisId", "evidenceVersionIds": [ "<currentVersion.id>" ], "decisionIds": [ "<id>" ] }   → new version
GET  /view-analyses/{id}/published-versions?status=published   → { "data": [ { "id", "versionNumber", "evidenceVersionIds", "decisionIds", "status" } ] }
```

**Published versions are immutable.** Fixing an evidence afterwards does not change
an already-published version — publish again to bundle the corrected evidence
version. **Publish has no uniqueness guard**: check `published-versions` first if
you intend exactly one.

---

## 11. Comments

```
POST /snapshot-comments   { "anchorType": "view_analysis", "anchorId": "<analysisId>",
                            "commentType": "question" | "interpretation_note" | "qc_concern" | "assumption" | "action_item",
                            "content": "..." }
GET  /snapshot-comments?anchorType=view_analysis&anchorId={id}   → { "comments": [...] }      # note: `comments`, not `data`
```

---

## 12. Output grammar (the RUO boundary, as conduct)

Every statement an agent writes into evidence, decisions or comments must pass three tests:

1. **Tense** — observational (past/present). Never predictive or prescriptive ("relapse is impending" ✗).
2. **Subject** — the **measurement** is the subject ("the count fell"), never the patient ("the patient is at risk" ✗).
3. **Comparator** — named, with the surviving-point count ("above the 75th percentile of 19 comparable cohort points"), never an implied universal standard.

A blocked or suppressed comparison is a **first-class result with a stated reason**,
not an error and not a caveat.

---

## 13. Failure catalog — symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| `no subject key or pairing axis mapped for this dataset` | no semantic profile, or dataset not linked to the project | §3: bind profile, then `POST /projects/{id}/datasets` per dataset, verify field-mappings |
| Run succeeded but absent from `provenance-graph`; warning `whole_dataset_referent` | run rooted on the dataset, not a snapshot | pass `snapshotId` **and** `datasetId` |
| `Provide either datasetId or stepRunId+artifactName` (400) | sent `snapshotId` without `datasetId` | send both |
| `status: "DEDUPED"` on a re-run | same fingerprint (snapshot not included) | change the `filters` scope |
| Ran a rule but no new column on the table | `outputMode:"delta_table"` is a separate table | use `"annotate"`, open the run's `rule_derived` snapshot |
| STRATIFY `conflicting values for partition field` | field varies within a subject | partition on a per-subject-constant field / one row per subject |
| STRATIFY `/table` 400 `has no delta_features` | wrong reader | use `/summary` |
| STATISTICAL run has no snapshot to open | by design | read `/table`; add a DELTA/STRATIFY for a viewable result |
| `GET /rule-runs/{id}/table` → 500 `… (reading 'openBuffer')` | server's parquet reader misconfigured (host-side) | not fixable over the API — report to the operator |
| `PATCH …/review-question` → 500 | text longer than ~256 chars | shorten |
| "Run relationship rule" picker empty | no published rule tagged `relationship-rule` | §7 |
| `POST /rules` 403 `Only platform administrators may create system-scope rules` | `scope:"system"` | `scope:"workspace"` |
| `POST /rules/{id}/publish` 400 `Protocol compliance failed … requires output field` | missing `outputFields` for the protocol | `FEATURE_RULE` + `feature_name`/`value` |
| `POST /thresholds` 500 `Argument 'operator' is missing` | operator sent as token (`"gte"`) | send the symbol (`">="`) |
| Evidence chart **empty in the review**, fine on the evidence page | `datasetVersionId` was an ingestion/version id → its `/datasets/{id}/query` returns *Dataset not found* | use the **dataset id** |
| Evidence chart empty / near-empty (missing groups) | cited at a narrow rule-result snapshot | cite at a snapshot with the chart's full scope |
| Evidence page `Dataset not found`, chart from another dataset | chart not on the analysis's own dataset | cite a chart on the analysis dataset; carry the cross-dataset result in text + provenance |
| Evidence page `Dataset not found` **after** you fixed the ids | stale client cache of the earlier failure | hard reload (bypass cache) |
| Evidence title/text vanished after a PATCH | PATCH replaces the version | always resend `title` + `text` with `chartEntries` |
| `citationContext.kind:"table"` evidence → 500 | table-citation path unavailable / needs a `rule_derived` snapshot | use chart-citation (`chartEntries`) |
| Review doesn't show the corrected evidence | published versions are immutable | publish again |
| Extra published versions appear | publish has no uniqueness | check `published-versions` before publishing |
| `GET …/snapshots` errors | `page` omitted | always send `page=1&limit=N` |
| 401 mid-sequence | token expired | re-login and retry |

---

## 14. Worked recipe — the four comparison scenarios as a template

Reusable pattern for any "compare a measurement" study. Steps 1–3 are done once per
project; 4–9 once per scenario.

1. **Setup** — §3 (profile + link + verify mappings).
2. **Discover** — §2.1: find measures with both timepoints per subject (self-reference
   needs paired data); note which cohorts exist.
3. **Frame** — create the analysis; review question ≤250 chars; 3 assumptions
   (cohort definition, method, applicability/comparability declaration).
4. **Snapshot** the slice the scenario reads (§4).
5. **Run the rule** rooted on that snapshot (§6):
   - *Patient vs. self* → DELTA `annotate` (per-subject delta merged as columns).
   - *Patient vs. cohort* → DELTA on the cohort slice; the platform's subject-comparison
     view ranks each subject against all subjects per timepoint.
   - *Governed statistical method* → STATISTICAL `stats.paired_ttest` (method, version,
     columns, cohort all pinned) — plus a STRATIFY if you also need a viewable subgroup result.
   - *Published threshold* → STRATIFY numeric bands from the published values (§6.3)
     **and** declare the same values as Thresholds with citation Annotations (§8).
6. **Confirm** the run is in `provenance-graph` and read its result (`/table` or `/summary`).
7. **Chart** the finding on the analysis's own dataset (§5) and **cite it as evidence**
   at a snapshot carrying its full scope, `datasetVersionId` = dataset id (§9), with a
   descriptive title/text (§12 grammar).
8. **Decide** — create the decision (RUO) citing the evidence → reviewed → approved (§10).
9. **Publish** once (§10). Re-publish only after a deliberate correction.

**Honest limits to state in your outputs:** a statistical run yields a summary, not
a per-row column; stratify yields group membership, not a cell value; the
comparability gate answers only from the metadata it is given.

---

*Verified 2026-09-04 against a live instance. Routes are stable; enumerations
(`type`, `commentType`, operators, templates) are the values observed live — read
`GET /rule-runs/operations` and `GET /rules` at run time rather than assuming.*
