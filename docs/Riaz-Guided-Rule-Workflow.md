# Riaz 2017 — the guided, rule-bound question

A second demo pack on top of [Headless-Riaz-Staging.md](Headless-Riaz-Staging.md).
It asks one scientifically relevant question of the Riaz 2017 nivolumab cohort,
answers it through the platform's governed execution kernel, gates the answer
behind a real QC rule, interprets it with a designed rule library, and closes
it as an approved, evidence-linked decision. Every id and deep link the demo
needs is written to `docs/riaz-guided-trace.json`.

## The question

> **Does nivolumab induce an on-treatment cytotoxic / IFN-γ transcriptional
> program in melanoma, and is that induction confined to responders?**

This is the central finding of Riaz et al., *Cell* 2017: pre-treatment immune
signatures did not separate responders; the **on-treatment change** did.
Responders showed an on-treatment rise in cytotoxic / T-cell effector genes
(CD8A, PRF1, GZMB, IFNG) and checkpoint genes (PDCD1, LAG3); non-responders did not.
The workflow reproduces that comparison from the public BMS038 count matrix.

## Data

`riaz_de/build_immune_paired_long_dataset.py` (superrepo) derives
`riaz2017_immune_paired_log2cpm_long.csv` from `CountData.BMS038.txt` +
`SampleTableCorrected.9.19.16.csv`:

| Property | Value |
|---|---|
| Shape | 1 296 rows — 27 patients × 24 genes × 2 timepoints (Pre, On) |
| Patients | fully paired, best response R (CR/PR, n=9) or NR (PD, n=18); SD excluded |
| Genes | IFNG, CXCL9, CXCL10, CXCL11, STAT1, IRF1, IDO1, HLA-DRA, GZMA, GZMB, PRF1, NKG7, CD8A, CD3E, CD27, IL2RA, LCK, PDCD1, CD274, LAG3, HAVCR2, TIGIT, CTLA4, TOX |
| Value | `log2_cpm` = log2(CPM + 1) over the full library |
| Columns | `patient_id, timepoint, response, prior_ipi, gene, log2_cpm` |

It is registered as the fourth dataset of the Riaz pack
(`RIAZ_PAIRED_LONG_DATASET` in `staging/steps/stageRiaz.ts`, role
`paired_expression_long`). The `immuno_oncology` profile maps `patient_id`,
`timepoint`, `response` and `gene` to canonical fields, which is what the
paired operation needs for subject / level binding.

## The rule library

Four rules, one per protocol layer (`rules/protocol-registry.ts`), defined in
[`staging/steps/riazGuidedRules.ts`](../staging/steps/riazGuidedRules.ts).
All are RUO and tagged `riaz-2017, demo`.

| Code | Protocol | Category | Logic | Output |
|---|---|---|---|---|
| `RIAZ-QC-PAIRED-01` | QC_RULE | qc_guard | `sample_size >= 240` (5 fully paired patients × 24 genes × 2) | `include_mask`, `qc_fail_reasons`, `paired_completeness_adequate`; guard cap 0.5 + human review |
| `RIAZ-INT-CYTO-01` | INTERPRET_RULE | microenvironment_state | K-of-N, k=4 of 6: `paired_mean_delta_log2cpm:<gene> >= 0.5` for CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3 | `state_label` = `cytotoxic_program_induced` / `…_not_induced`, `genes_fired`, confidence 0.85 / 0.6 / 0.3 by how many fired genes have paired p < 0.05 |
| `RIAZ-INT-RESP-01` | INTERPRET_RULE | research_stratification | AND: CYTO fires on responders **and** does not fire on non-responders | `state_label` = `responder_restricted` / `shared_induction` / `no_induction`; cap 0.8 + human review |
| `RIAZ-DEC-01` | DECISION_RULE | research_stratification | RESP = `responder_restricted` → `consistent_with_riaz_2017`; CYTO fires in R but induction shared → `partially_consistent`; else `inconsistent` | `verdict`, `confidence` (≤ 0.8), `evidence_refs`, `disclaimer_flags`; `safetyFlags: [RUO]` |

Design notes:

- **Only the QC rule executes on the platform.** The plan's `qc_check` node
  cites it by code; the kernel resolves it (`{code, status: published,
  scope system OR organizationId}`), runs it as a real QC rule run, and the
  `qc-outcome@1` gate blocks / degrades / passes every downstream node.
- **INTERPRET and DECISION rules are authoring-only today** (no executor;
  AXI-1491 dependency R1). They are published so the decision can cite them
  by code and so the rule pages exist for the demo. `stageRiazGuided.ts`
  evaluates their predicates deterministically (`evaluateCyto`,
  `evaluateResp`, `evaluateDecision`) over the paired-test tables the
  governed run produced, and prints which leaves fired. Nothing here drives
  platform logic except the QC rule — this matches the doctrine
  "annotations never drive logic".
- **Why K-of-N and a 0.5 log2 CPM delta.** A hand-picked six-gene panel is a
  hypothesis-scoring rule, not a signature; K-of-N makes a single gene unable
  to fire the state. 0.5 log2 CPM ≈ 1.4× is a conservative effect for bulk
  RNA-seq on 2–4-week on-treatment biopsies.
- **Why the responder rule is negative-controlled.** "Induced in responders"
  alone would also be true if nivolumab induced the program in everyone;
  the paper's claim is the *difference*, so the rule requires the
  non-responder cohort not to fire.

## The governed plan

`buildPlan()` in `stageRiazGuided.ts` submits one plan with six nodes
(`versionHash` = the dataset's `fileHash`):

```
qc_paired  (qc_check, ruleCode RIAZ-QC-PAIRED-01)
  └─ induction_all             compare_paired   stats.paired_ttest, all 27 patients
  └─ responders                filter           response eq R
       └─ induction_responders compare_paired   stats.paired_ttest, 9 patients
  └─ non_responders            filter           response eq NR
       └─ induction_non_responders  compare_paired  stats.paired_ttest, 18 patients
```

Operation binding: `operationParams {alternative: two_sided}`, pivot
`{featureColumn: gene, valueColumn: log2_cpm}`, ordering Pre → On,
subject / level from the canonical `patient_id` / `timepoint` mappings;
declared multiplicity family = BH FDR over the three paired tests.

## Command

```bash
# once: derive the paired long CSV (superrepo root)
python3 riaz_de/build_immune_paired_long_dataset.py

cd axiome-global/axiome-e2e-testing
npm run stage:riaz          # base pack (now also uploads the paired dataset)
npm run stage:riaz-guided   # this workflow
```

Entry point: [`staging/steps/stageRiazGuided.ts`](../staging/steps/stageRiazGuided.ts).
Prerequisites are those of `stage:riaz` (demo stack up, `admin@axiome.local`,
identity store from `npm run stage:identities`). Extra env:

| Env | Default | Purpose |
|---|---|---|
| `STAGING_RIAZ_PAIRED_LONG_CSV_PATH` | `/home/felipe/dev/axiome/riaz_de/riaz2017_immune_paired_log2cpm_long.csv` | source CSV |
| `STAGING_RIAZ_GUIDED_TRACE` | `docs/riaz-guided-trace.json` | where the trace is written |
| `STAGING_RIAZ_GUIDED_REUSE_RUN` + `_REUSE_ANALYSIS` | unset | skip submit and re-read an existing run (`GR-…`, analysis id) |
| `FRONT_URL` | `http://localhost:5173` | base for the printed deep links |

Steps, in order: ensure identities → resolve workspace / project / org →
set profile `immuno_oncology` → upload the paired dataset (idempotent by
filename) → check field mappings → create / patch / publish the four rules
(idempotent by code) → submit the plan → poll status to completion → read
rule runs from the analysis's `rule_derived` snapshots → read the three
paired-test tables → evaluate the rule library offline → approve the
`interpretation` node → record a `phenotype_classification` decision as
Marc Ottavi (`cast-biologist`) linked to the four result snapshots →
transition it `reviewed` → `approved` as the service identity → write the
trace and print the deep links.

Expected tail: `PASSED — stage:riaz-guided: run GR-… (ok), decision … (approved).`

## Result on the demo stack (2026-09-22)

| Cohort | n pairs | Genes ≥ 0.5 log2 CPM | Paired p < 0.05 | CYTO state |
|---|---|---|---|---|
| All | 27 | PRF1, PDCD1, LAG3 | PRF1, PDCD1 | not induced (3 of 6) |
| Responders | 9 | CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3 | PDCD1 | **induced** (6 of 6, confidence 0.3) |
| Non-responders | 18 | none | none | not induced |

`RIAZ-INT-RESP-01` → **responder_restricted** (0.55).
`RIAZ-DEC-01` → **consistent_with_riaz_2017** (0.55 → draft confidence medium).
QC verdict pass on 1 296 rows (guard: cap 0.5, human review).

Trace ids (`docs/riaz-guided-trace.json`):

| Object | Id |
|---|---|
| Governed run | `GR-bef16bdd` |
| Analysis | `b511e309-de32-42dc-937d-7f9c5e3156ee` |
| Dataset | `7703a6b4-db1e-4780-9936-778015eebf0a` |
| QC rule run / result snapshot | `4450c8e0-3714-4d87-9a14-c3de6ae90093` / `09261a77-225f-4693-aaea-170eee093d22` |
| Paired t-test, all / result | `6ff7d387-a1c2-44fc-a0a7-1fa989eb6ca6` / `1ed44734-305f-4519-9ad2-2d4a7a86aae6` |
| Paired t-test, responders / result | `3d377096-4be8-478f-be0a-66b8fe41a5c2` / `5ce2733d-f541-46e9-b5ef-a251e0d3a1fd` |
| Paired t-test, non-responders / result | `f3f77a04-d447-4d19-afdc-410e896b00be` / `387229d7-861c-4bf1-ace8-06befd4a6569` |
| Decision | `7ee630ad-2bc4-4f9d-a4ff-e4225a6878e6` (approved) |
| Rules | QC `40f34ddf-66af-4bc1-8d25-6ff6620acca7`, CYTO `e4b34821-9770-4c45-a91f-fc65cc73be86`, RESP `eb4a825e-7ef0-4a1f-9c35-13dc3c0a1e71`, DEC `74b7818a-f85c-48af-a618-7729e696a449` (all v3, published) |

## Demo beat — deep links (log in as Marc Ottavi)

| Beat | Link |
|---|---|
| Project overview | http://localhost:5173/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview |
| Guided analyses history (the run GR-bef16bdd) | http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses |
| The analysis — QC + 3 paired-test snapshots | http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/b511e309-de32-42dc-937d-7f9c5e3156ee |
| Provenance graph (root → filters → rule-derived) | http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/b511e309-de32-42dc-937d-7f9c5e3156ee/provenance |
| Decisions list | http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/b511e309-de32-42dc-937d-7f9c5e3156ee/decisions |
| The approved decision | http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/b511e309-de32-42dc-937d-7f9c5e3156ee/decisions/7ee630ad-2bc4-4f9d-a4ff-e4225a6878e6 |
| Rule — QC guard | http://localhost:5173/rules/40f34ddf-66af-4bc1-8d25-6ff6620acca7 |
| Rule — cytotoxic induction | http://localhost:5173/rules/e4b34821-9770-4c45-a91f-fc65cc73be86 |
| Rule — responder-restricted | http://localhost:5173/rules/eb4a825e-7ef0-4a1f-9c35-13dc3c0a1e71 |
| Rule — decision | http://localhost:5173/rules/74b7818a-f85c-48af-a618-7729e696a449 |

Suggested narration: question → the four rule pages (what we committed to
*before* looking) → guided history (the plan, the QC gate) → analysis
snapshots (27 / 9 / 18 pairs; PDCD1 and PRF1 rise; responders fire all six)
→ provenance → decision (RUO, medium, human-approved, linked to the four
evidence snapshots).

## Gotchas

- **Filter operators are bio-compute's vocabulary**: `eq`, `neq`, `in`, `gt`,
  `gte`, `lt`, `lte`, `is_null`. `==` fails the node with
  `Unsupported filter operator` (run GR-98873d46 on the project is that
  failure, left as-is).
- **Rule scope**: `RuleScope` is `system | workspace | project`. Organization
  rules are `scope: workspace` stamped with `organizationId` (the citation
  resolves by `organizationId`, not by workspace).
- **Dataset upload needs the org**: `POST /workspaces/:ws/datasets` 500s with
  `organizationId is missing` unless the provisioning context carries `orgId`.
- **Rule-run listing** (`GET /rule-runs?datasetId`) returns `{ruleRuns}` and
  rows carry no analysis / snapshot id. Derive rule runs from the analysis's
  `origin: rule_derived` snapshots (`ruleRunId`, `parentSnapshotId`).
- **Decision transitions** need `decision:review`; the author
  (`cast-biologist`) cannot review their own draft, so `reviewed` →
  `approved` are done as the service identity.
- **Runs are not idempotent.** Every `stage:riaz-guided` submits a new
  governed run and a new analysis; re-running adds a sibling. Use the
  `STAGING_RIAZ_GUIDED_REUSE_*` env pair to re-read (and re-document) the
  existing run instead.
- **`GET /governed-execution/status`** carries no `viewAnalysisId`; keep the
  one returned by `submit`.
- Interpretation / decision verdicts are computed by the script, not by the
  platform; if someone edits the rules in the UI the script's evaluators
  will not follow. Keep `riazGuidedRules.ts` and the published rules in sync.
