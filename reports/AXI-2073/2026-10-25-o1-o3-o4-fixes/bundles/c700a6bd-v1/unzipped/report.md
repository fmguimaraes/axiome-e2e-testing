# Audit report — Slide 2 (IgG4): IgG4-reactive microbiota by group for ENT059, CER229, CER215+234, with Dunn post-hoc brackets vs IgG4-RD (Holm-adjusted)

Project: Microbiote IgG4 — final reference set (synthetic) · Evidence v1 (latest)
Evidence ID: c700a6bd-e4e6-419d-b506-34190cc7fb0e · version ID: 8614f83d-b068-40d7-9eb6-e4b225bb704c
Generated: 25/10/2026 05:26 UTC by Local Admin
Report SHA-256: sha256:683e24c2804eba28ae5824141e91bf8d8c0ebee934bc48145d254a2b0c0a2fa1
Source data: included. This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.

## Verdict

**Traceable — some facts were not recorded.**

| Status | Where | What |
| --- | --- | --- |
| not recorded | Result · Run (Dunn's post-hoc test) | random seed — not recorded |
| not recorded | Result · Run (Dunn's post-hoc test) | build SHA, image digest — not recorded (recordable since 19/10/2026 21:14 UTC) |
| not recorded | Result · Run (Dunn's post-hoc test) | random seed — not recorded |
| not recorded | Result · Run (Dunn's post-hoc test) | build SHA, image digest — not recorded (recordable since 19/10/2026 21:14 UTC) |
| not recorded | Result · Run (Dunn's post-hoc test) | random seed — not recorded |
| not recorded | Result · Run (Dunn's post-hoc test) | build SHA, image digest — not recorded (recordable since 19/10/2026 21:14 UTC) |
| not recorded | Result · Result snapshot (snapshot v2) | per-column filter combinators, producing run — not recorded |
| not recorded | Result · Chart (Slide 2 — IgG4-reactive microbiota by group, 3 references (strip + median, Dunn vs IgG4-RD)) | content hash — not recorded |

## What this evidence shows

> Slide 2 (IgG4): IgG4-reactive microbiota by group for ENT059, CER229, CER215+234, with Dunn post-hoc brackets vs IgG4-RD (Holm-adjusted)

- Evidence status: approved

- Data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result — group is one of HD, IgG4-RD, SD and reference = ENT 059
- Computation: Dunn's post-hoc test — facet CER 215 et 234 (linked to the cited chart)

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = 0.7769 | 0.4372 | 0.4372 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = 1.809 | 0.07043 | 0.2113 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 1.397 | 0.1623 | 0.3246 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/5bca31b5-dbd9-4a3e-a27e-d0658ab76d24.csv.
- Computation: Dunn's post-hoc test — facet CER 229 (linked to the cited chart)

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = -2.495 | 0.0126 | 0.0378 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = -0.08332 | 0.9336 | 0.9336 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 2.395 | 0.01663 | 0.0378 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c.csv.
- Computation: Dunn's post-hoc test — facet ENT 059 (linked to the cited chart)

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = -2.685 | 0.007242 | 0.02173 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = -0.04184 | 0.9666 | 0.9666 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 2.635 | 0.008409 | 0.02173 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/3a4d494d-061e-4060-9feb-7ed8af6c979b.csv.
- Chart: Slide 2 — IgG4-reactive microbiota by group, 3 references (strip + median, Dunn vs IgG4-RD) — strip (template strip_v1 v1.0.0), made by a user — image charts/2aefc664-0111-441e-aa51-5a528c00c7c9.png

## Data

### final_tableau1_long_synthetic.csv

- File: final_tableau1_long_synthetic.csv
- Uploaded by Local Admin on 23/10/2026 19:58 UTC
- Raw file SHA-256: sha256:bc98a928ef3bce6a44b8bb2a180e16fb24f20bb72710697dd1ef3169e3f64b36 — matches the attached file data/source/final_tableau1_long_synthetic.csv
- Dataset ID: 59bf54b5-7ccc-4e08-8afc-2cc30d7699f2
- Dataset version: 2 (dataset version SHA-256 sha256:2da87eb48b126c770128ddd4db0929534bb915644abf18cdbcccfc3abe90f8d3)
- Size: 462 rows × 5 columns (ingestion 1)
- Ingestion: 23/10/2026 19:58 UTC by system; profiled with polars-1.44.1 (profiler 1.1.0)
- Ingestion ID: 582bc2a6-4900-4265-b15c-8c5cbb7fde59

## Population

- Cited data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result; snapshot v2, saved 23/10/2026 19:58 UTC by Local Admin
- Rows kept: group is one of HD, IgG4-RD, SD and reference = ENT 059
- Rows in the slice: not recorded (the row count of a slice is not stored)
- Cohort (run 1): Cohort v1 (rows: group is one of HD, IgG4-RD, SD and reference = CER 215 et 234), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:7cc222a182f585c214ae72ebc178be8dca6e46090eaf921af51879455575f94c
- Cohort (run 2): Cohort v1 (rows: group is one of HD, IgG4-RD, SD and reference = CER 229), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:e088fe23b6ea3179568458dd2928c5fe98f64a9affa83fe3373e45f7f811b871
- Cohort (run 3): Cohort v1 (rows: group is one of HD, IgG4-RD, SD and reference = ENT 059), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:befa91977e2fe91a21af6ff3ab04d488107cbc884b3b3d7d12f725f9fd83870b

## Methods

### Dunn's post-hoc test — linked to the cited chart

- What it asks: For every pair of bound groups, test whether a measurement's rank distribution differs, using ranks pooled across all compared groups with a tie-corrected variance, Holm-adjusted.
- Rule: STAT-DUNN-POSTHOC — Dunn's post-hoc test (rule version 2)
- Facet: CER 215 et 234
- Grouping column: group (categorical)
- Variable(s) tested: pct (numeric)
- Units: not recorded
- Groups and n: HD: 10, IgG4-RD: 26, SD: 10
- Parameters: none recorded (the operation ran with its defaults)
- Random seed: none recorded
- Significance threshold (alpha): not a run parameter — the run reports the p-value; a threshold belongs to the decision, not the computation
- Rows excluded: not recorded
- Library: axiome-bio-compute/stats_execution 1.0.0
- Function called: not recorded
- Build SHA: not recorded (recordable since 19/10/2026 21:14 UTC)
- Image digest: not recorded (recordable since 19/10/2026 21:14 UTC)
- R-equivalent call: not recorded
- R-equivalence entry: none exists
- Outputs:

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = 0.7769 | 0.4372 | 0.4372 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = 1.809 | 0.07043 | 0.2113 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 1.397 | 0.1623 | 0.3246 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/5bca31b5-dbd9-4a3e-a27e-d0658ab76d24.csv.
- Run: 5bca31b5-dbd9-4a3e-a27e-d0658ab76d24 · status SUCCEEDED · started 23/10/2026 19:58 UTC by Local Admin
- Run fingerprint: sha256:b9f067948b63da2aae230efc8b6f2287d1bd3f15fcfd0501a03d7daf9b080fc8

### Dunn's post-hoc test — linked to the cited chart

- What it asks: For every pair of bound groups, test whether a measurement's rank distribution differs, using ranks pooled across all compared groups with a tie-corrected variance, Holm-adjusted.
- Rule: STAT-DUNN-POSTHOC — Dunn's post-hoc test (rule version 2)
- Facet: CER 229
- Grouping column: group (categorical)
- Variable(s) tested: pct (numeric)
- Units: not recorded
- Groups and n: HD: 10, IgG4-RD: 26, SD: 10
- Parameters: none recorded (the operation ran with its defaults)
- Random seed: none recorded
- Significance threshold (alpha): not a run parameter — the run reports the p-value; a threshold belongs to the decision, not the computation
- Rows excluded: not recorded
- Library: axiome-bio-compute/stats_execution 1.0.0
- Function called: not recorded
- Build SHA: not recorded (recordable since 19/10/2026 21:14 UTC)
- Image digest: not recorded (recordable since 19/10/2026 21:14 UTC)
- R-equivalent call: not recorded
- R-equivalence entry: none exists
- Outputs:

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = -2.495 | 0.0126 | 0.0378 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = -0.08332 | 0.9336 | 0.9336 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 2.395 | 0.01663 | 0.0378 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c.csv.
- Run: 3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c · status SUCCEEDED · started 23/10/2026 19:58 UTC by Local Admin
- Run fingerprint: sha256:f3d50733b32d0708141db54b84a449508cb2c09d2ae8359b37fd505f5be40723

### Dunn's post-hoc test — linked to the cited chart

- What it asks: For every pair of bound groups, test whether a measurement's rank distribution differs, using ranks pooled across all compared groups with a tie-corrected variance, Holm-adjusted.
- Rule: STAT-DUNN-POSTHOC — Dunn's post-hoc test (rule version 2)
- Facet: ENT 059
- Grouping column: group (categorical)
- Variable(s) tested: pct (numeric)
- Units: not recorded
- Groups and n: HD: 10, IgG4-RD: 26, SD: 10
- Parameters: none recorded (the operation ran with its defaults)
- Random seed: none recorded
- Significance threshold (alpha): not a run parameter — the run reports the p-value; a threshold belongs to the decision, not the computation
- Rows excluded: not recorded
- Library: axiome-bio-compute/stats_execution 1.0.0
- Function called: not recorded
- Build SHA: not recorded (recordable since 19/10/2026 21:14 UTC)
- Image digest: not recorded (recordable since 19/10/2026 21:14 UTC)
- R-equivalent call: not recorded
- R-equivalence entry: none exists
- Outputs:

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct · HD · IgG4-RD | z = -2.685 | 0.007242 | 0.02173 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = -0.04184 | 0.9666 | 0.9666 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 2.635 | 0.008409 | 0.02173 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/3a4d494d-061e-4060-9feb-7ed8af6c979b.csv.
- Run: 3a4d494d-061e-4060-9feb-7ed8af6c979b · status SUCCEEDED · started 23/10/2026 19:58 UTC by Local Admin
- Run fingerprint: sha256:512d1d34f5e3c84fc5e682a236d63fad2fb550424da9f5f578bc70e523492460

## Review & publication

- Evidence: version 1 (the latest version), saved 23/10/2026 19:58 UTC by Local Admin
- Evidence status: approved (the evidence's current status)
- Evidence content SHA-256: sha256:cfa6f357f3cb76f3ba41ff5973306c963fdaa7dffb27d9374a1cc91894ad6427
- Interpretation: "ENT059 and CER229 IgG4 reactivity distinguish IgG4-RD from HD and SD (Dunn, Holm-adjusted); CER215+234 does not" by Local Admin — approved by Local Admin on 24/10/2026 07:52 UTC
- Publication: published version 1 by Felipe Machado Guimaraes on 24/10/2026 08:44 UTC

## Appendix A — Technical chain

### Result — cited snapshot b52539a3-d552-4e5d-a995-ef1d4e917771

| # | Step | Name | ID | Version | Details | Created | Actor | Parents | Hash | Status | Not recorded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Source file | final_tableau1_long_synthetic.csv | 59bf54b5-7ccc-4e08-8afc-2cc30d7699f2 | — | — | 2026-10-23T19:58:31.828Z | Local Admin | — | sha256:bc98a928ef3bce6a44b8bb2a180e16fb24f20bb72710697dd1ef3169e3f64b36 | recorded | — |
| 2 | Dataset version | version 2 | 59bf54b5-7ccc-4e08-8afc-2cc30d7699f2 | 2 | — | 2026-10-23T19:58:31.828Z | Local Admin | — | sha256:2da87eb48b126c770128ddd4db0929534bb915644abf18cdbcccfc3abe90f8d3 | recorded | — |
| 3 | Ingestion & profiling | ingestion 1 | 582bc2a6-4900-4265-b15c-8c5cbb7fde59 | 1 | — | 2026-10-23T19:58:31.849Z | system | 59bf54b5-7ccc-4e08-8afc-2cc30d7699f2 | — | recorded | — |
| 4 | Cohort | Cohort v1 | 1b1d0ef8-6a2c-4d6b-9aa2-38b0bc90afe7 | 1 | — | 2026-10-23T19:58:35.422Z | Local Admin | — | sha256:7cc222a182f585c214ae72ebc178be8dca6e46090eaf921af51879455575f94c | recorded | — |
| 5 | Cohort | Cohort v1 | 5b84e13c-cfc2-4250-ae08-51e1a37e40c3 | 1 | — | 2026-10-23T19:58:34.251Z | Local Admin | — | sha256:e088fe23b6ea3179568458dd2928c5fe98f64a9affa83fe3373e45f7f811b871 | recorded | — |
| 6 | Cohort | Cohort v1 | f79fd9d5-0586-4720-a825-2711d43f1f35 | 1 | — | 2026-10-23T19:58:33.103Z | Local Admin | — | sha256:befa91977e2fe91a21af6ff3ab04d488107cbc884b3b3d7d12f725f9fd83870b | recorded | — |
| 7 | Analysis | synthetic — Slide 2: IgG4 by group, 3 references | a55a06a9-c984-40b1-81ee-3c6cdf3b22b3 | — | — | 2026-10-23T19:58:32.414Z | Local Admin | — | — | recorded | — |
| 8 | Rule | STAT-DUNN-POSTHOC | aa9ed9c6-cd0f-41f4-9480-49f9e5647758 | 2 | — | — | — | — | sha256:845f3a53ab3c4e8d41da7b0447431da5a74a58efd7393af748b98d6abb23b23f | recorded | — |
| 9 | Run | Dunn's post-hoc test | 5bca31b5-dbd9-4a3e-a27e-d0658ab76d24 | — | — | 2026-10-23T19:58:35.439Z | Local Admin | — | sha256:b9f067948b63da2aae230efc8b6f2287d1bd3f15fcfd0501a03d7daf9b080fc8 | recorded | random seed, build SHA, image digest |
| 10 | Rule | STAT-DUNN-POSTHOC | aa9ed9c6-cd0f-41f4-9480-49f9e5647758 | 2 | — | — | — | — | sha256:845f3a53ab3c4e8d41da7b0447431da5a74a58efd7393af748b98d6abb23b23f | recorded | — |
| 11 | Run | Dunn's post-hoc test | 3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c | — | — | 2026-10-23T19:58:34.266Z | Local Admin | — | sha256:f3d50733b32d0708141db54b84a449508cb2c09d2ae8359b37fd505f5be40723 | recorded | random seed, build SHA, image digest |
| 12 | Rule | STAT-DUNN-POSTHOC | aa9ed9c6-cd0f-41f4-9480-49f9e5647758 | 2 | — | — | — | — | sha256:845f3a53ab3c4e8d41da7b0447431da5a74a58efd7393af748b98d6abb23b23f | recorded | — |
| 13 | Run | Dunn's post-hoc test | 3a4d494d-061e-4060-9feb-7ed8af6c979b | — | — | 2026-10-23T19:58:33.112Z | Local Admin | — | sha256:512d1d34f5e3c84fc5e682a236d63fad2fb550424da9f5f578bc70e523492460 | recorded | random seed, build SHA, image digest |
| 14 | Result snapshot | snapshot v2 | b52539a3-d552-4e5d-a995-ef1d4e917771 | 2 | origin filter | 2026-10-23T19:58:33.072Z | Local Admin | — | — | recorded | per-column filter combinators, producing run |
| 15 | Chart | Slide 2 — IgG4-reactive microbiota by group, 3 references (strip + median, Dunn vs IgG4-RD) | 2aefc664-0111-441e-aa51-5a528c00c7c9 | — | template strip_v1 v1.0.0 · origin user | 2026-10-23T19:58:36.519Z | Local Admin | — | — | recorded | content hash |
| 16 | Evidence | Slide 2 (IgG4): IgG4-reactive microbiota by group for ENT059, CER229, CER215+234, with Dunn post-hoc brackets vs IgG4-RD (Holm-adjusted) | 8614f83d-b068-40d7-9eb6-e4b225bb704c | 1 | — | 2026-10-23T19:58:36.589Z | Local Admin | c700a6bd-e4e6-419d-b506-34190cc7fb0e | sha256:cfa6f357f3cb76f3ba41ff5973306c963fdaa7dffb27d9374a1cc91894ad6427 | current | — |
| 17 | Interpretation | ENT059 and CER229 IgG4 reactivity distinguish IgG4-RD from HD and SD (Dunn, Holm-adjusted); CER215+234 does not | 066d2bb5-a1a8-4cda-ba15-3ca5aa2f5cac | — | — | 2026-10-24T07:52:29.692Z | Local Admin | — | sha256:f25d30afa782550c58ee36a4943c0b1d435bdd2d1bb2ddc69677a35049c652c3 | approved | — |
| 18 | Publication | published version 1 | c17de8e5-3ecb-48ba-9f48-636bf207ffb4 | 1 | — | 2026-10-24T08:44:22.660Z | Felipe Machado Guimaraes | — | sha256:0fe074842f697cde1bd70676d5087369e4f8bf8bd99eb36d2e59647f769c1452 | published | — |

## Appendix B — Attached files

| File | SHA-256 |
| --- | --- |
| [charts/2aefc664-0111-441e-aa51-5a528c00c7c9.png](./charts/2aefc664-0111-441e-aa51-5a528c00c7c9.png) | in manifest.json (rendered on download) |
| [data/charts/2aefc664-0111-441e-aa51-5a528c00c7c9.csv](./data/charts/2aefc664-0111-441e-aa51-5a528c00c7c9.csv) | sha256:5e67e0944833ebf53ad4e91f795889b768349fd88b18545b48dfffab7b88d6ff |
| [data/runs/3a4d494d-061e-4060-9feb-7ed8af6c979b.csv](./data/runs/3a4d494d-061e-4060-9feb-7ed8af6c979b.csv) | sha256:d8f69e04ca6cd656d41e3d4b298f7e5238b4e21bb94e35ad180621dcfc0a7ed9 |
| [data/runs/3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c.csv](./data/runs/3debaa8f-9be6-4ef6-bba7-20bcd2e0c49c.csv) | sha256:814e940ab8a2ff97fb0c8a0059f2c5f6bd7b8c3066627754dc3fd9bb56b2434d |
| [data/runs/5bca31b5-dbd9-4a3e-a27e-d0658ab76d24.csv](./data/runs/5bca31b5-dbd9-4a3e-a27e-d0658ab76d24.csv) | sha256:fdeb2f914be16ab7f60bc9abefb3ac93d2386e215c460a213870c15aef9e7799 |
| [data/source/final_tableau1_long_synthetic.csv](./data/source/final_tableau1_long_synthetic.csv) | sha256:bc98a928ef3bce6a44b8bb2a180e16fb24f20bb72710697dd1ef3169e3f64b36 |

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are rendered when the bundle is built, so their bytes may differ between downloads; their hash is in manifest.json only and is not part of the Report SHA-256.
- This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.
