# AXI-2073 round 2 — Phase 1 findings + Phase 2 plan (evidence c700a6bd v1)

Read-only diagnosis, 2026-10-25. Nothing was changed in any repo or the DB: demo DB SELECT-only, Mongo audit_logs and MinIO run parquets read-only.

Code read:
- back worktree `7d062075`, plus the uncommitted O1/O3/O4 edits
- bio-compute `c60725f`
- knowledge `eb9f395`
- docs redesign branch `9418860`

Today's bundle came from the :3011 sidecar (report.md sha `542ec6d7…`).

## Record map

| Object | ID | Facts |
|---|---|---|
| Evidence version | 8614f83d v1 | `snapshot_ids={b52539a3}`, chart 2aefc664, created by db2d9dcb (Local Admin), 23/10 19:58 |
| Chart (DataviewSpec) | 2aefc664 | strip_v1, origin user. Filters: reference in [ENT 059, CER 229, CER 215 et 234]. `facet_compute_run_ids`: ENT 059 → 3a4d494d, CER 229 → 3debaa8f, CER 215 et 234 → 5bca31b5. `params.facet_order`: ENT 059, CER 229, CER 215 et 234 |
| Cited snapshot | b52539a3 v2 | Origin filter. rule_run_id NULL. Reference = ENT 059 |
| Run ENT 059 | 3a4d494d | stats.dunn_posthoc. Input snapshot b52539a3. Result snapshot 91d6533f (rule_derived, rule_run_id 3a4d494d, parent b52539a3). Cohort f79fd9d5 |
| Run CER 229 | 3debaa8f | Input snapshot 4706e8b9 (filter). Result snapshot d6b370d4 |
| Run CER 215 et 234 | 5bca31b5 | Input snapshot 1b4f6183 (filter). Result snapshot cab4e52b |
| Rule version | aa9ed9c6 | STAT-DUNN-POSTHOC v2, published, author_kind claude |
| Interpretation | 066d2bb5 | Approved. `created_by` = `reviewed_by` = db2d9dcb |

## Item 1 — Adjustment family

**Finding:** Holm is applied inside one run, over the defined pairs of one measurement × feature. Here that is each run's 3 pairwise rows. It is not applied across runs.

**The family is not recorded as a structured fact anywhere.** What is persisted:
- Each result row stores `adjustmentMethod="holm"` (stats_results.parquet).
- The rule version describes the family only in prose:
  - `youWillGet`: "Holm applied over every defined pair of one measurement".
  - `fieldHelp…valueColumns.why`: "No multiple-testing correction is applied across columns or features."
- `rule_runs.operation_params` is NULL.
- `summary_json` holds only counts: features 1, measurements 1, computed_rows 3, pairs_compared 3, undefined_rows 0, group_ns HD 10 / IgG4-RD 26 / SD 10.

**Where the code fixes the family:**
- bio-compute:
  - `src/adapters/dunn_posthoc.py:25-29` and `:190`: `holm([...ordered_keys])` inside one call.
  - `src/adapters/holm.py:13`: "which p-values form a family — a caller decision".
  - `src/pipelines/stats_execution.py:322`.
- back:
  - `rule-runs/kernel/operation-registry.ts:1308-1318`: a comment only.
  - `OperationDefinition` (`operation-registry.types.ts:825-849`) has no adjustment field.

**Stored values compared with a recomputation** (closed-form Holm):

| Run | Pair | p | Stored adj. p | Holm over the run's 3 | Holm over all 9 |
|---|---|---|---|---|---|
| 3a4d494d ENT 059 | HD·IgG4-RD | 0.0072422101587166 | 0.0217266304761498 | 0.0217266304761498 | 0.06518 |
| | HD·SD | 0.966623078564228 | 0.966623078564228 | same | 1 |
| | IgG4-RD·SD | 0.00840861234483539 | 0.0217266304761498 | same | 0.06727 |
| 3debaa8f CER 229 | HD·IgG4-RD | 0.0126013398783573 | 0.0378040196350718 | same | 0.08821 |
| | HD·SD | 0.933600807080782 | 0.933600807080782 | same | 1 |
| | IgG4-RD·SD | 0.0166335631871723 | 0.0378040196350718 | same | 0.09980 |
| 5bca31b5 CER 215 et 234 | HD·IgG4-RD | 0.437208300273287 | 0.437208300273287 | same | 1 |
| | HD·SD | 0.0704331052213639 | 0.211299315664092 | same | 0.3522 |
| | IgG4-RD·SD | 0.162302382885804 | 0.324604765771608 | same | 0.6492 |

**Confirmed:** each run's adjusted p equals Holm over that run's own 3 comparisons. Every row matches to within 1e-12. Holm over all 9 comparisons matches none of them.

This is arithmetic, not a scientific ruling. Over a 9-comparison family, the cited 0.022 and 0.038 would become 0.065 and 0.088. The workspace has 113 `stats.family_adjust` runs (BH); none of them refers to these runs.

## Item 2 — Omnibus test

**The catalogue does not declare Kruskal-Wallis as a prerequisite:**
- The rule-version snapshot has no prerequisite field. The only mention is prose in `whenToUse`: "After a significant Kruskal-Wallis result…".
- `OperationDefinition` has no such field either.
- DUNN_POSTHOC (`operation-registry.ts:1319-1363`) only reuses the Kruskal-Wallis table input scheme.
- The knowledge node library lists preconditions only.

**No Kruskal-Wallis run exists for these facets.** Dataset 59bf54b5 has only 3 runs, all `stats.dunn_posthoc`. Other datasets do have Kruskal-Wallis runs; for example, 4c1bd11e has 21 Kruskal-Wallis and 21 Dunn runs sharing input snapshots.

**No link mechanism exists.** `rule_runs` has no omnibus column. Linking runs because they share an input snapshot would be inference (FR4).

## Item 3 — Snapshot, runs and evidence scope

**Why one ENT 059 snapshot stands for 3 references.** The seed script cited the ENT 059 run's input slice:
- `axiome-docs/demo/mag4-microbiote/scripts/build_final_project.py:363-366`
- The chart entry takes one snapshot (`:204-212`).

**The recorded scopes disagree:**
- Snapshot: ENT 059 only.
- Chart: 3 references.
- Each run: 1 reference (`rule_runs.filters`).
- The interpretation's `evidence_values` attribute the CER 229 value (0.038) to `sourceSnapshotId` b52539a3, the ENT 059 snapshot.

**Why the producing run shows as "not recorded".** b52539a3 is a filter data view: it is run 3a4d494d's input. The run's output is 91d6533f.

**The snapshot → run link is written today, where it applies:**

| Snapshot origin | Snapshots | With rule_run_id | Notes |
|---|---|---|---|
| rule_derived | 4224 | 4223 | 1 exception from 2026-10-02 |
| filter | 2503 | 32 | stratify group snapshots and split arms, by design |
| linked | 62 | 0 | |

- `persistRuleDerivedSnapshot` (`rule-runs.service.ts:9408-9430`) sets the link.
- `persistSnapshot` (`view-analyses.service.ts:1103-1125`) never sets it, by design.

**Decision:** report the producing run as "not applicable — snapshot is a data view, results come from runs linked via chart 2aefc664". The write path is correct; the label in §10 step 8 is wrong for a filter-origin snapshot. The real defect is that the evidence cites a 1-facet slice for a 3-facet chart.

## Item 4 — Self-approval

**Interpretation 066d2bb5**
- On the row, `created_by` = `reviewed_by` = db2d9dcb, `reviewed_at` 07:52:56.359, and `approval_event_id` is NULL.
- `decision-drafts.service.ts:681-688` stamps the reviewer only on the reviewed and valid transitions. The reviewed → approved transition writes nothing to the row.
- The approve actor is recorded only in the event-service log in Mongo. Every event there is by db2d9dcb:
  - created at 07:52:29.703
  - draft → reviewed at 07:52:56.369
  - reviewed → approved at 07:52:56.388
  - `decision_draft.updated` (evidence links) at 08:42:00, after approval
- The audit report reads `reviewedBy` as the approver (`audit-chain-assembler.service.ts:263-273`).

**Evidence c700a6bd**
- There is no approver column. Status changes are logged in `organization_svc.view_analysis_audit_logs` (`evidence_status_updated`, `performed_by`):
  - 23/10 21:16:52, db2d9dcb (the author): draft → approved.
  - 24/10 08:41:27–29, 4663ed45 (Felipe): approved → approved, approved → draft, then draft → approved (the current state).
- The current approver is not the author. The first approval was a self-approval. Today's report shows no evidence approver.

**Author ≠ approver enforcement** exists only for:
- content approvals (`content-approvals/content-approval-policy.ts:16-27,103-133`)
- rule acquisition
- Claude-authored rules

There is none for decision drafts or for `updateEvidenceStatus` (`view-analyses.service.ts:892-920`).

**Local Admin**
- db2d9dcb is admin@cro-one.com, the shared demo/dev login (role USER).
- No account type is persisted anywhere. The only service actor is the literal `system`.
- **Consequence:** F4's non-personal-account warning needs a schema field. This is a stop-and-ask item.

## Phase 2 plan

**Overlaps with the O1/O3/O4 work:**
- **F3:** reuse O1's `report-sections/snapshot-scope.ts` origin map.
- **F7:** O4 already covers cohort filters in words and the no-filter wording. F7 only adds:
  - one Population line per run
  - units
  - raw JSON in Appendix A only
- Test IDs UT-GRAPH-2300..2349 are pre-allocated.

### F1 — Adjustment family

No persisted fact holds the family today. Three possible routes (decision 1):
- (a) Declare it in code on the operation: `OperationDefinition.adjustment`. No schema change.
- (b) Record it per run: a migration adding `rule_runs.adjustment_*` columns, plus a new bio-compute callback field (R2 pair).
- (c) Treat `computed_rows` as the family size. This conflicts with "never derive the family from row counts".

Verdict lines:
- Error, when the family is missing: "adjustment family — not recorded".
- Evidence-level warning: "per facet; no correction across the 3 facets". It is suppressed when a `family_adjust` run covers all the cited runs.

### F2 — Omnibus linkage

The catalogue does not declare the prerequisite, so it must be declared somewhere (decision 2):
- in a STAT-DUNN-POSTHOC v3 rule version (rule data; needs a human publish), or
- as an `OperationDefinition` field.

A link also needs a schema field (decision 3): `rule_runs.omnibus_run_id` or `dataview_specs.facet_omnibus_run_ids`.

Verdict line: a warning per run, "post-hoc test without a linked omnibus test".

### F3 — Scope consistency

- A snapshot with filter or linked origin gets "not applicable" for the producing run, and the report adds "read by run …".
- Population and "What this evidence shows" get one line per run.
- A new scope-consistency check warns when the cited snapshot's scope differs from the runs' scopes.
- Optional data fix: re-cite the evidence on root snapshot 8620844f and fix the seed script.

### F4 — Attribution

- Warning when the interpretation's author is also its approver. The approver source is decision 6.
- The evidence approver comes from the latest approved entry in `view_analysis_audit_logs`. The report shows approver and time, and warns when the approver is the version's author.
- The non-personal-account warning is blocked until the schema has an account type (decision 5).
- The literal `system` gets the label "service: ingestion" and no warning.

### F5 — Not applicable

- New status `not_applicable`, driven only by declarations:
  - Seed: needs an `OperationDefinition.randomSource` field (decision 7). A NULL `effective_seed` cannot tell "no random source" apart from a run made before seeds were recorded.
  - Producing run: from the snapshot origin, as in F3.
- The verdict never lists n/a facts.

### F6 — Verdict readability

- Group verdict rows by run, plus an evidence-level group.
- Order rows error → warning → not recorded.
- Use the 4 headlines. How "deleted" and "not yet done" map onto them, and the FR18 amendment, are decision 8.

### F7 — Plain language

- Raw cohort JSON appears in Appendix A only.
- Population follows Methods order. Which order that is: decision 9.
- No column records a unit, so the report shows "pct: unit — not recorded".

**Expected verdict for c700**, assuming F1 route (a), F2 declared and no account type yet: "Traceable — with warnings".
- Evidence-level warnings:
  - scope mismatch
  - per-facet adjustment
  - interpretation author = approver
- For each of the 3 runs:
  - warning: no linked omnibus test
  - not recorded: build SHA, image digest, function called, R-equivalent call
- If a missing family stays an error, every existing Dunn evidence becomes "Not traceable".

## Owner decisions

1. **F1 recording route:** (a), (b) or (c). Also: should a missing family be an error, given that this turns every existing Dunn evidence "Not traceable"?
2. **F2 declaration home:** a v3 rule version (rule data) or an `OperationDefinition` field.
3. **F2 link field (schema change):** `rule_runs.omnibus_run_id` or `dataview_specs.facet_omnibus_run_ids`.
4. **F3:** confirm "not applicable" for filter and linked snapshots, and the filter-equality mismatch rule. Should the evidence be re-cited and the seed script fixed?
5. **F4 (schema change):** add `User.accountKind`? If so, which accounts are non-personal?
6. **F4 interpretation approver:** use `reviewed_by`, add `approved_by`/`approved_at` (schema change), or read the event log (new contract).
7. **F5:** add the `OperationDefinition.randomSource` field? Is `filterColumnCombinators` not applicable when each column has at most one filter?
8. **F6:** how "deleted" and "not yet done" map onto the 4 headlines; the FR18 amendment.
9. **F7 run order:** sort by facet value (spec §10) or follow the chart's `facet_order`.
10. **Out of scope, observed:**
    - The interpretation was edited 50 minutes after approval, although approved interpretations are meant to be immutable.
    - One rule_derived snapshot has no run (from 2026-10-02).
11. **Spec §11a:** the SI-015 line contradicts D2. F2 and F5 add SI-017. F4 adds user-service if decision 5 is yes.
