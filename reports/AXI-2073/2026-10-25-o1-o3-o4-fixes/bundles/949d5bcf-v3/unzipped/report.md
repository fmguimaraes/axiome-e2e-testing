# Audit report — CER228: IgG4 microbiote differs by group (Kruskal-Wallis)

Project: Microbiote IgG4 — synthetic reproduction (AXI-2064) · Evidence v3 (latest)
Evidence ID: 949d5bcf-926d-43ec-bfeb-aeae93b3faf2 · version ID: c72fa2eb-1ffd-4f1a-9e38-5b1ecceae804
Generated: 25/10/2026 05:26 UTC by Local Admin
Report SHA-256: sha256:c0757192a6745656576daf1e90e3791653300cb1bc7fa0f70398caed2e22239c
Source data: included. This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.

## Verdict

**Incomplete — the chain has a broken link (error).**

| Status | Where | What |
| --- | --- | --- |
| broken link (error) | Result · Run | The evidence does not record the computation behind its result. 2 run(s) read the cited data before this evidence version was saved; they are listed under Methods as not linked. |
| not yet done | Review | No interpretation has been recorded. |
| not yet done | Review | The evidence is not yet published. |
| not yet done | Review | The evidence is draft, not approved. |
| not recorded | Result · Result snapshot (snapshot v2) | per-column filter combinators, producing run — not recorded |
| not recorded | Result · Chart (synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis)) | content hash — not recorded |

## What this evidence shows

> CER228: IgG4 microbiote differs by group (Kruskal-Wallis)

- Evidence status: draft

- Data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result — group is one of HD, IgG4-RD, SD and reference = CER 228
- Computation: none linked — broken link (error). The evidence does not record the computation behind its result.
- Chart: synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — image charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png

## Data

### tableau1_long_synthetic.csv

- File: tableau1_long_synthetic.csv
- Uploaded by Local Admin on 19/10/2026 23:35 UTC
- Raw file SHA-256: sha256:e29be23e337ef731a4a16a2479a25d6310d50cbf2b977a288365124858a13aed — matches the attached file data/source/tableau1_long_synthetic.csv
- Dataset ID: 9315c385-e5a3-422c-a83b-fc728629e703
- Dataset version: 3 (dataset version SHA-256 sha256:4282cab0870c05072d30f111373844855bdf3e771c6be8a422cfcfd89dbe3fa7)
- Size: 462 rows × 5 columns (ingestion 1)
- Ingestion: 19/10/2026 23:35 UTC by system; profiled with polars-1.44.1 (profiler 1.1.0)
- Ingestion ID: fb586015-4172-4bc8-87fd-cae2fc7ed060

## Population

- Cited data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result; snapshot v2, saved 19/10/2026 23:35 UTC by Local Admin
- Rows kept: group is one of HD, IgG4-RD, SD and reference = CER 228
- Rows in the slice: not recorded (the row count of a slice is not stored)
- Cohort: not recorded

## Methods

### Runs not linked to this evidence (read the cited snapshot)

The evidence does not record which computation it rests on. These runs read the same cited data slice before this evidence version was saved. They are listed for traceability only: none of them is recorded as the source of this evidence.

#### Kruskal-Wallis test — not linked to this evidence (read the cited snapshot)

- What it asks: Test whether the distribution of a measurement differs across every bound group, without assuming normality.
- Rule: STAT-KRUSKAL-WALLIS — Kruskal-Wallis test (rule version 3)
- Grouping column: group (categorical)
- Variable(s) tested: pct (numeric)
- Units: not recorded
- Groups and n: not recorded (recordable since 19/10/2026 21:14 UTC)
- Parameters: none recorded (the operation ran with its defaults)
- Random seed: none recorded
- Significance threshold (alpha): not a run parameter — the run reports the p-value; a threshold belongs to the decision, not the computation
- Rows excluded: not recorded
- Library: pingouin 0.5.5 (the rule's library pin; the run did not report its own)
- Function called: not recorded
- Build SHA: not recorded (recordable since 19/10/2026 21:14 UTC)
- Image digest: not recorded (recordable since 19/10/2026 21:14 UTC)
- R-equivalent call: not recorded
- R-equivalence entry: none exists
- Outputs:

  | Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |
  | --- | --- | --- | --- | --- | --- |
  | pct | H = 0.8699 | 0.6473 | not applicable | -0.02628 | no interval computed by this method |

  Full result table: data/runs/eb353146-f43f-41a3-9461-a3e2c787eb8e.csv.
- Run: eb353146-f43f-41a3-9461-a3e2c787eb8e · status SUCCEEDED · started 19/10/2026 23:35 UTC by Local Admin
- Run fingerprint: sha256:362150793a16b6c01a1b83ec34d4e7933078c48003ff9d7389c45726e271f8e7

#### Dunn's post-hoc test — not linked to this evidence (read the cited snapshot)

- What it asks: For every pair of bound groups, test whether a measurement's rank distribution differs, using ranks pooled across all compared groups with a tie-corrected variance, Holm-adjusted.
- Rule: STAT-DUNN-POSTHOC — Dunn's post-hoc test (rule version 2)
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
  | pct · HD · IgG4-RD | z = 0.6531 | 0.5137 | 1 (holm) | none declared | no interval computed by this method |
  | pct · HD · SD | z = 0.9247 | 0.3551 | 1 (holm) | none declared | no interval computed by this method |
  | pct · IgG4-RD · SD | z = 0.4582 | 0.6468 | 1 (holm) | none declared | no interval computed by this method |

  Full result table: data/runs/1ad15a6c-d411-4485-ab82-b94e923f3e00.csv.
- Run: 1ad15a6c-d411-4485-ab82-b94e923f3e00 · status SUCCEEDED · started 20/10/2026 05:46 UTC by Local Admin
- Run fingerprint: sha256:2108b4fbe89adefe3ff9f3504d4c99d1b6498875e845fa5a922df4283095be95

## Review & publication

- Evidence: version 3 (the latest version), saved 20/10/2026 15:14 UTC by Local Admin
- Evidence status: draft (the evidence's current status)
- Evidence content SHA-256: sha256:e737d1af5e42eea872759f726828a75c0fbcfd3f3c3a66ed3d2f57bd42685340
- Interpretation: not yet done (no interpretation cites this evidence version)
- Publication: not yet done (no published version contains this evidence version)

## Appendix A — Technical chain

### Result — cited snapshot a2ef532c-14d6-4c06-9425-210a6a0fc93f

| # | Step | Name | ID | Version | Details | Created | Actor | Parents | Hash | Status | Not recorded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Source file | tableau1_long_synthetic.csv | 9315c385-e5a3-422c-a83b-fc728629e703 | — | — | 2026-10-19T23:35:30.511Z | Local Admin | — | sha256:e29be23e337ef731a4a16a2479a25d6310d50cbf2b977a288365124858a13aed | recorded | — |
| 2 | Dataset version | version 3 | 9315c385-e5a3-422c-a83b-fc728629e703 | 3 | — | 2026-10-19T23:35:30.511Z | Local Admin | — | sha256:4282cab0870c05072d30f111373844855bdf3e771c6be8a422cfcfd89dbe3fa7 | recorded | — |
| 3 | Ingestion & profiling | ingestion 1 | fb586015-4172-4bc8-87fd-cae2fc7ed060 | 1 | — | 2026-10-19T23:35:30.480Z | system | 9315c385-e5a3-422c-a83b-fc728629e703 | — | recorded | — |
| 4 | Cohort | — | not recorded | — | — | — | — | — | — | not recorded | cohort, cohort version, cohort hash, filters, lock state, locked by, locked at |
| 5 | Analysis | synthetic — CER228 reproduction | 086aade1-961e-48a5-a94c-a8faa06b2c3b | — | — | 2026-10-19T23:35:48.493Z | Local Admin | — | — | recorded | — |
| 6 | Rule | — | not recorded | — | — | — | — | — | — | not recorded | rule version |
| 7 | Run | — | not recorded | — | — | — | — | — | — | broken link (error) | — |
| 8 | Result snapshot | snapshot v2 | a2ef532c-14d6-4c06-9425-210a6a0fc93f | 2 | origin filter | 2026-10-19T23:35:48.556Z | Local Admin | — | — | recorded | per-column filter combinators, producing run |
| 9 | Chart | synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) | 4c6138e6-1640-48cb-9745-7b49658daf7b | — | template boxplot_v1 v1.0.0 · origin user | 2026-10-20T00:20:05.881Z | Local Admin | — | — | recorded | content hash |
| 10 | Evidence | CER228: IgG4 microbiote differs by group (Kruskal-Wallis) | c72fa2eb-1ffd-4f1a-9e38-5b1ecceae804 | 3 | — | 2026-10-20T15:14:28.355Z | Local Admin | 949d5bcf-926d-43ec-bfeb-aeae93b3faf2 | sha256:e737d1af5e42eea872759f726828a75c0fbcfd3f3c3a66ed3d2f57bd42685340 | current | — |
| 11 | Interpretation | — | not recorded | — | — | — | — | — | — | not yet done | interpretation |
| 12 | Publication | — | not recorded | — | — | — | — | — | — | not yet published | — |
| U1 | Cohort | — | not recorded | — | — | — | — | — | — | not recorded; not linked (read the cited snapshot) | cohort, cohort version, cohort hash, filters, lock state, locked by, locked at |
| U2 | Rule | STAT-KRUSKAL-WALLIS | 1f830792-0d11-4232-9169-88e17427f971 | 3 | — | — | — | — | sha256:b4e7074be9c3323f2866cc4b8d854d6c54947e3b3a785304082a32c9cd794288 | recorded; not linked (read the cited snapshot) | — |
| U3 | Run | Kruskal-Wallis test | eb353146-f43f-41a3-9461-a3e2c787eb8e | — | — | 2026-10-19T23:35:48.764Z | Local Admin | — | sha256:362150793a16b6c01a1b83ec34d4e7933078c48003ff9d7389c45726e271f8e7 | recorded; not linked (read the cited snapshot) | random seed, build SHA, image digest, library name, library version, n per group |
| U4 | Cohort | — | not recorded | — | — | — | — | — | — | not recorded; not linked (read the cited snapshot) | cohort, cohort version, cohort hash, filters, lock state, locked by, locked at |
| U5 | Rule | STAT-DUNN-POSTHOC | aa9ed9c6-cd0f-41f4-9480-49f9e5647758 | 2 | — | — | — | — | sha256:845f3a53ab3c4e8d41da7b0447431da5a74a58efd7393af748b98d6abb23b23f | recorded; not linked (read the cited snapshot) | — |
| U6 | Run | Dunn's post-hoc test | 1ad15a6c-d411-4485-ab82-b94e923f3e00 | — | — | 2026-10-20T05:46:53.641Z | Local Admin | — | sha256:2108b4fbe89adefe3ff9f3504d4c99d1b6498875e845fa5a922df4283095be95 | recorded; not linked (read the cited snapshot) | random seed, build SHA, image digest |

Rows U1, U2, … are runs that read the cited snapshot; they are not linked to this evidence.

## Appendix B — Attached files

| File | SHA-256 |
| --- | --- |
| [charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png](./charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png) | in manifest.json (rendered on download) |
| [data/charts/4c6138e6-1640-48cb-9745-7b49658daf7b.csv](./data/charts/4c6138e6-1640-48cb-9745-7b49658daf7b.csv) | sha256:0c8d16afdfae6f5879c0d7a2f7ce64c356fe46a1eeb0aa6de5380b1b1b25866c |
| [data/runs/1ad15a6c-d411-4485-ab82-b94e923f3e00.csv](./data/runs/1ad15a6c-d411-4485-ab82-b94e923f3e00.csv) | sha256:003ad2d37178fbccb0803d6e3940bedde04121ed410621b16f98c977992a1f68 |
| [data/runs/eb353146-f43f-41a3-9461-a3e2c787eb8e.csv](./data/runs/eb353146-f43f-41a3-9461-a3e2c787eb8e.csv) | sha256:dc32ffa62a2f94135487d097e53509a6f35ac57a9d430a843b63024f4dd3f197 |
| [data/source/tableau1_long_synthetic.csv](./data/source/tableau1_long_synthetic.csv) | sha256:e29be23e337ef731a4a16a2479a25d6310d50cbf2b977a288365124858a13aed |

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are rendered when the bundle is built, so their bytes may differ between downloads; their hash is in manifest.json only and is not part of the Report SHA-256.
- This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.
