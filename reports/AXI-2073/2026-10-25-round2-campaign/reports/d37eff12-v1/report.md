# Audit report — ENT059: association with pancreato-biliary involvement (Mann-Whitney U)

Project: Microbiote IgG4 — final reference set (synthetic) · Evidence v1 (latest)
Evidence ID: d37eff12-f141-4524-9758-0e8b09a67880 · version ID: 665367dd-010e-42e1-abbd-13476db9cbe4
Generated: 25/10/2026 10:02 UTC by Local Admin
Report SHA-256: sha256:d3dfdca6e204d02486209de6658e1d938cbfe9e69745915381a6357fde048b94
Source data: not included (includeSource=false).

## Verdict

**Traceable — with warnings**

### Evidence

| Severity | Where | What |
| --- | --- | --- |
| warning | Review · Interpretation | Interpretation "ENT059 IgG4 reactivity shows no association with pancreato-biliary involvement (Mann-Whitney U, ns)" was approved by its author (Local Admin). |
| warning | Review · Evidence | The evidence was approved by the author of this version (Local Admin). |
| not recorded | Result · Chart (synthetic — ENT059 by pancreato-biliary involvement (Mann-Whitney U)) | content hash — not recorded |
| not yet done | Review | The evidence is not yet published. |

### Mann-Whitney U test (run 2c861ac5…)

| Severity | Where | What |
| --- | --- | --- |
| not recorded | Run | build SHA, image digest — not recorded (recordable since 19/10/2026 21:14 UTC) |

## What this evidence shows

> ENT059: association with pancreato-biliary involvement (Mann-Whitney U)

- Evidence status: approved

- Data: a saved data view (origin: filter), not a computed result — no filter; read by run 2c861ac5
- Computation: Mann-Whitney U test (linked to the cited chart) — rows: all (no filter); cohort: Cohort v1 (rows: no filter — all rows), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8; n per group: 0: 0, 1: 0

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | microbiote_igg4_ent_059 | U = 77.5 | 0.3705 | not applicable | 0.2302 | no interval computed by this method |

  Full result table: data/runs/2c861ac5-f579-4bf2-8f81-8a532b48fd21.csv.
- Chart: synthetic — ENT059 by pancreato-biliary involvement (Mann-Whitney U) — box plot (template boxplot_v1 v1.0.0), made by a user — Chart image withheld — source data excluded from this bundle (chart b844f219, template boxplot_v1 v1.0.0)

## Data

### final_tableau2_synthetic.csv

- File: final_tableau2_synthetic.csv
- Uploaded by Local Admin on 23/10/2026 19:58 UTC
- Raw file SHA-256: sha256:42fede8a595e05f09589910d5ba91f1602d4a5762c4f834de075d472743e3cbc — source file not included in this bundle (includeSource=false)
- Dataset ID: 77965a8f-3f70-45b6-9376-ed8cd43308fb
- Dataset version: 2 (dataset version SHA-256 sha256:1ced7aab84387f8f63ed31ae91ceab7354b857f49b8bd224dba2caab961bfe19)
- Size: 23 rows × 21 columns (ingestion 1)
- Ingestion: 23/10/2026 19:58 UTC by service: ingestion; profiled with polars-1.44.1 (profiler 1.1.0)
- Ingestion ID: 5276fea6-55e2-4b91-b17b-912d912508ab

## Population

- Cited data: a saved data view (origin: filter), not a computed result; snapshot v1, saved 23/10/2026 19:58 UTC by Local Admin
- Rows: all 23 rows of dataset version 2 (no filter)
- Producing run: not applicable — snapshot is a data view, results come from runs linked via chart b844f219-434d-4a64-b733-ae7f0a59b34d
- Read by: Mann-Whitney U test (run 2c861ac5…)
- Mann-Whitney U test (run 2c861ac5…): rows: all (no filter); cohort: Cohort v1 (rows: no filter — all rows), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8; n per group: 0: 0, 1: 0

## Methods

### Mann-Whitney U test (run 2c861ac5…) — linked to the cited chart

- What it asks: Test whether the distribution of a measurement differs between two independent groups, without assuming normality.
- Rule: STAT-MANN-WHITNEY-U — Mann-Whitney U test (rule version 3)
- Grouping column: atteinte_pancreatique (numeric)
- Variable(s) tested: microbiote_igg4_ent_059 (numeric)
- Units: microbiote_igg4_ent_059: unit — not recorded
- Groups and n: 0: 0, 1: 0
- Parameters: alternative = two_sided; groupFrom = 0; groupTo = 1
- Random seed: 16980926
- Significance threshold (alpha): not a run parameter — the run reports the p-value; a threshold belongs to the decision, not the computation
- Rows excluded: not recorded
- Multiple-comparison adjustment: none declared by this test
- Library: pingouin 0.5.5
- Function called: not recorded
- Build SHA: not recorded (recordable since 19/10/2026 21:14 UTC)
- Image digest: not recorded (recordable since 19/10/2026 21:14 UTC)
- R-equivalent call: not recorded
- R-equivalence entry: none exists
- Outputs:

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | microbiote_igg4_ent_059 | U = 77.5 | 0.3705 | not applicable | 0.2302 | no interval computed by this method |

  Full result table: data/runs/2c861ac5-f579-4bf2-8f81-8a532b48fd21.csv.
- Run: 2c861ac5-f579-4bf2-8f81-8a532b48fd21 · status SUCCEEDED · started 23/10/2026 19:58 UTC by Local Admin
- Run fingerprint: sha256:235651a389a42998b3924896873b56861721884f27123e1eca08750794319533

## Review & publication

- Evidence: version 1 (the latest version), saved 23/10/2026 19:58 UTC by Local Admin
- Evidence status: approved (the evidence's current status)
- Evidence approved by Local Admin on 23/10/2026 21:16 UTC
- Evidence content SHA-256: sha256:130b8d6da248e60032da54224f525914834eeed74fa179d9c93d10fd3820248f
- Interpretation: "ENT059 IgG4 reactivity shows no association with pancreato-biliary involvement (Mann-Whitney U, ns)" by Local Admin — approved by Local Admin on 24/10/2026 07:52 UTC
- Publication: not yet done (no published version contains this evidence version)

## Appendix A — Technical chain

### Result — cited snapshot f9e834e3-5aa9-48b0-af16-8206fa520669

| # | Step | Name | ID | Version | Details | Created | Actor | Parents | Hash | Status | Not recorded | Not applicable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Source file | final_tableau2_synthetic.csv | 77965a8f-3f70-45b6-9376-ed8cd43308fb | — | — | 2026-10-23T19:58:32.444Z | Local Admin | — | sha256:42fede8a595e05f09589910d5ba91f1602d4a5762c4f834de075d472743e3cbc | recorded | — | — |
| 2 | Dataset version | version 2 | 77965a8f-3f70-45b6-9376-ed8cd43308fb | 2 | — | 2026-10-23T19:58:32.444Z | Local Admin | — | sha256:1ced7aab84387f8f63ed31ae91ceab7354b857f49b8bd224dba2caab961bfe19 | recorded | — | — |
| 3 | Ingestion & profiling | ingestion 1 | 5276fea6-55e2-4b91-b17b-912d912508ab | 1 | — | 2026-10-23T19:58:32.458Z | service: ingestion | 77965a8f-3f70-45b6-9376-ed8cd43308fb | — | recorded | — | — |
| 4 | Cohort | Cohort v1 | 7001ed6d-ef11-45ad-8a43-f22228121155 | 1 | filters {"filterColumnCombinators": null, "filterCombinator": "AND", "filters": []} | 2026-10-23T19:58:36.811Z | Local Admin | — | sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8 | recorded | — | — |
| 5 | Analysis | synthetic — Slide 3: phenotype (ENT059) and Spearman runs | 2ce28a75-3587-4eac-9ddc-d8de480e1e0a | — | — | 2026-10-23T19:58:33.013Z | Local Admin | — | — | recorded | — | — |
| 6 | Rule | STAT-MANN-WHITNEY-U | 4b4e72d6-b371-432a-83c7-2bde952d70ec | 3 | — | — | — | — | sha256:397e0bc0c0e34701530ee79f9a8582f54e3414b421680090984798e1e40b3451 | recorded | — | — |
| 7 | Run | Mann-Whitney U test | 2c861ac5-f579-4bf2-8f81-8a532b48fd21 | — | — | 2026-10-23T19:58:37.885Z | Local Admin | — | sha256:235651a389a42998b3924896873b56861721884f27123e1eca08750794319533 | recorded | build SHA, image digest | — |
| 8 | Result snapshot | snapshot v1 | f9e834e3-5aa9-48b0-af16-8206fa520669 | 1 | origin filter | 2026-10-23T19:58:33.017Z | Local Admin | — | — | recorded | — | per-column filter combinators, producing run |
| 9 | Chart | synthetic — ENT059 by pancreato-biliary involvement (Mann-Whitney U) | b844f219-434d-4a64-b733-ae7f0a59b34d | — | template boxplot_v1 v1.0.0 · origin user | 2026-10-23T19:58:39.055Z | Local Admin | — | — | recorded | content hash | — |
| 10 | Evidence | ENT059: association with pancreato-biliary involvement (Mann-Whitney U) | 665367dd-010e-42e1-abbd-13476db9cbe4 | 1 | — | 2026-10-23T19:58:39.121Z | Local Admin | d37eff12-f141-4524-9758-0e8b09a67880 | sha256:130b8d6da248e60032da54224f525914834eeed74fa179d9c93d10fd3820248f | current | — | — |
| 11 | Interpretation | ENT059 IgG4 reactivity shows no association with pancreato-biliary involvement (Mann-Whitney U, ns) | e66d2e50-7eea-4718-bd61-a3f76eb7463b | — | — | 2026-10-24T07:52:29.816Z | Local Admin | — | sha256:1519fcb66ff71a2c13dd615d31e55b353527ffeddc7bc155bb5dc4b168ba2e2a | approved | — | — |
| 12 | Publication | — | not recorded | — | — | — | — | — | — | not yet published | — | — |

## Appendix B — Attached files

| File | SHA-256 |
| --- | --- |
| [data/runs/2c861ac5-f579-4bf2-8f81-8a532b48fd21.csv](./data/runs/2c861ac5-f579-4bf2-8f81-8a532b48fd21.csv) | sha256:12a15aebcfead50f400c16ba33351632ab904f9242044189d6cfab48c679616a |

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are withheld from this bundle because the source data is excluded (a chart can show one point per patient).
