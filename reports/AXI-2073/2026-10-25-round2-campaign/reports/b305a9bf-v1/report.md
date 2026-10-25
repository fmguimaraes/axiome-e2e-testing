# Audit report — ENT059: association with ACR/EULAR 2019 cluster (Kruskal-Wallis)

Project: Microbiote IgG4 — final reference set (synthetic) · Evidence v1 (latest)
Evidence ID: b305a9bf-19b4-4cb7-be72-dc866562346a · version ID: dc74acd5-e634-48ee-9ce9-2de274c6eb37
Generated: 25/10/2026 10:02 UTC by Local Admin
Report SHA-256: sha256:7548fe6b04057aa639a126eff40e9aefd38b68132f22101d1180583817f58ca8
Source data: not included (includeSource=false).

## Verdict

**Traceable — with warnings**

### Evidence

| Severity | Where | What |
| --- | --- | --- |
| warning | Review · Interpretation | Interpretation "ENT059 IgG4 reactivity shows no association with ACR/EULAR 2019 cluster assignment (Kruskal-Wallis, ns)" was approved by its author (Local Admin). |
| warning | Review · Evidence | The evidence was approved by the author of this version (Local Admin). |
| not recorded | Result · Chart (synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis)) | content hash — not recorded |
| not yet done | Review | The evidence is not yet published. |

### Kruskal-Wallis test (run b2672520…)

| Severity | Where | What |
| --- | --- | --- |
| not recorded | Run | build SHA, image digest — not recorded (recordable since 19/10/2026 21:14 UTC) |

## What this evidence shows

> ENT059: association with ACR/EULAR 2019 cluster (Kruskal-Wallis)

- Evidence status: approved

- Data: a saved data view (origin: filter), not a computed result — no filter; read by run b2672520
- Computation: Kruskal-Wallis test (linked to the cited chart) — rows: all (no filter); cohort: Cohort v1 (rows: no filter — all rows), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8; n per group: C1: 7, C2: 3, C3: 3, C4: 10

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | microbiote_igg4_ent_059 | H = 4.871 | 0.1815 | not applicable | 0.09846 | no interval computed by this method |

  Full result table: data/runs/b2672520-4198-4ab9-9ab8-b1d1936ee6d5.csv.
- Chart: synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — Chart image withheld — source data excluded from this bundle (chart 18606f58, template boxplot_v1 v1.0.0)

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
- Producing run: not applicable — snapshot is a data view, results come from runs linked via chart 18606f58-43a1-45b0-bfd1-dc15d8b83439
- Read by: Kruskal-Wallis test (run b2672520…)
- Kruskal-Wallis test (run b2672520…): rows: all (no filter); cohort: Cohort v1 (rows: no filter — all rows), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8; n per group: C1: 7, C2: 3, C3: 3, C4: 10

## Methods

### Kruskal-Wallis test (run b2672520…) — linked to the cited chart

- What it asks: Test whether the distribution of a measurement differs across every bound group, without assuming normality.
- Rule: STAT-KRUSKAL-WALLIS — Kruskal-Wallis test (rule version 3)
- Grouping column: cluster_selon_acr_eular_2019 (categorical)
- Variable(s) tested: microbiote_igg4_ent_059 (numeric)
- Units: microbiote_igg4_ent_059: unit — not recorded
- Groups and n: C1: 7, C2: 3, C3: 3, C4: 10
- Parameters: none recorded (the operation ran with its defaults)
- Random seed: not applicable — this test uses no randomness
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
  | microbiote_igg4_ent_059 | H = 4.871 | 0.1815 | not applicable | 0.09846 | no interval computed by this method |

  Full result table: data/runs/b2672520-4198-4ab9-9ab8-b1d1936ee6d5.csv.
- Run: b2672520-4198-4ab9-9ab8-b1d1936ee6d5 · status SUCCEEDED · started 23/10/2026 19:58 UTC by Local Admin
- Run fingerprint: sha256:26864ec64614a4cfa8f2ef16f1afe709bf5b7ce6365506e5ac1bb8aa856d271c

## Review & publication

- Evidence: version 1 (the latest version), saved 23/10/2026 19:58 UTC by Local Admin
- Evidence status: approved (the evidence's current status)
- Evidence approved by Local Admin on 23/10/2026 21:16 UTC
- Evidence content SHA-256: sha256:5f7adbc7fcdeb12d24121578399ae9a4618067268d7348a1cd6ea8d4e10f37af
- Interpretation: "ENT059 IgG4 reactivity shows no association with ACR/EULAR 2019 cluster assignment (Kruskal-Wallis, ns)" by Local Admin — approved by Local Admin on 24/10/2026 07:52 UTC
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
| 6 | Rule | STAT-KRUSKAL-WALLIS | 1f830792-0d11-4232-9169-88e17427f971 | 3 | — | — | — | — | sha256:b4e7074be9c3323f2866cc4b8d854d6c54947e3b3a785304082a32c9cd794288 | recorded | — | — |
| 7 | Run | Kruskal-Wallis test | b2672520-4198-4ab9-9ab8-b1d1936ee6d5 | — | — | 2026-10-23T19:58:36.821Z | Local Admin | — | sha256:26864ec64614a4cfa8f2ef16f1afe709bf5b7ce6365506e5ac1bb8aa856d271c | recorded | build SHA, image digest | random seed |
| 8 | Result snapshot | snapshot v1 | f9e834e3-5aa9-48b0-af16-8206fa520669 | 1 | origin filter | 2026-10-23T19:58:33.017Z | Local Admin | — | — | recorded | — | per-column filter combinators, producing run |
| 9 | Chart | synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis) | 18606f58-43a1-45b0-bfd1-dc15d8b83439 | — | template boxplot_v1 v1.0.0 · origin user | 2026-10-23T19:58:38.940Z | Local Admin | — | — | recorded | content hash | — |
| 10 | Evidence | ENT059: association with ACR/EULAR 2019 cluster (Kruskal-Wallis) | dc74acd5-e634-48ee-9ce9-2de274c6eb37 | 1 | — | 2026-10-23T19:58:39.012Z | Local Admin | b305a9bf-19b4-4cb7-be72-dc866562346a | sha256:5f7adbc7fcdeb12d24121578399ae9a4618067268d7348a1cd6ea8d4e10f37af | current | — | — |
| 11 | Interpretation | ENT059 IgG4 reactivity shows no association with ACR/EULAR 2019 cluster assignment (Kruskal-Wallis, ns) | ae31dfc0-9f09-4a2b-9214-e0cc5eca2030 | — | — | 2026-10-24T07:52:29.778Z | Local Admin | — | sha256:59930cdfc23085cd7a942e9d25df300aec3885f6f6dbd960c99e8f7332baa59c | approved | — | — |
| 12 | Publication | — | not recorded | — | — | — | — | — | — | not yet published | — | — |

## Appendix B — Attached files

| File | SHA-256 |
| --- | --- |
| [data/runs/b2672520-4198-4ab9-9ab8-b1d1936ee6d5.csv](./data/runs/b2672520-4198-4ab9-9ab8-b1d1936ee6d5.csv) | sha256:69235cc4f61d943e1ae97f30723f70bc221ff44309d0b52210383934737cecb0 |

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are withheld from this bundle because the source data is excluded (a chart can show one point per patient).
