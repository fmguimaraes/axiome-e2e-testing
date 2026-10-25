# Audit report — Spearman correlation heatmap: 6 clinical variables x 7 references (BH within reference)

Project: Microbiote IgG4 — final reference set (synthetic) · Evidence v1 (latest)
Evidence ID: eb9ab5bf-6486-4536-94d5-9ff335311164 · version ID: e3f3b251-e4d9-4d05-93a3-7cf6be7d9209
Generated: 25/10/2026 06:29 UTC by Local Admin
Report SHA-256: sha256:d812650f8bfc4e3561c6eb807f22a4aa38a7fd8c491073548ec900cfa6ba8cb1
Source data: included. This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.

## Verdict

**Incomplete — the chain has a broken link (error).**

| Status | Where | What |
| --- | --- | --- |
| broken link (error) | Result · Run | The evidence does not record the computation behind its result. |
| not yet done | Review | The evidence is not yet published. |
| not recorded | Result · Result snapshot (snapshot v1) | per-column filter combinators, producing run — not recorded |
| not recorded | Result · Chart (synthetic — Spearman heatmap: 6 clinical variables x 7 references (slide layout)) | content hash — not recorded |

## What this evidence shows

> Spearman correlation heatmap: 6 clinical variables x 7 references (BH within reference)

- Evidence status: approved

- Data: the whole dataset (no filter) — a saved filtered view (origin: filter), not a computed result
- Computation: none linked — broken link (error). The evidence does not record the computation behind its result.
- Chart: synthetic — Spearman heatmap: 6 clinical variables x 7 references (slide layout) — heatmap annotated (template heatmap_annotated_v1 v1.0.0), made by a user — image charts/402ddb56-1a0f-470e-8447-0028d1ff45d4.png

## Data

### final_heatmap_synthetic.csv

- File: final_heatmap_synthetic.csv
- Uploaded by Local Admin on 23/10/2026 19:59 UTC
- Raw file SHA-256: sha256:559f35b8b59d86c372bf03b49d93c933f6f73477b61b8a3a2289a64afb86b3cf — matches the attached file data/source/final_heatmap_synthetic.csv
- Dataset ID: 457560d8-d268-42e0-afa5-e0e82acdc12b
- Dataset version: 2 (dataset version SHA-256 sha256:53e91d9c1d8aa86165eb3a3d2e814401077be639b28fed8d6863ec5f14ce6cbb)
- Size: 42 rows × 7 columns (ingestion 1)
- Ingestion: 23/10/2026 19:59 UTC by system; profiled with polars-1.44.1 (profiler 1.1.0)
- Ingestion ID: 32d517e0-d247-4a89-abe5-9131daa209b7

## Population

- Cited data: the whole dataset (no filter) — a saved filtered view (origin: filter), not a computed result; snapshot v1, saved 23/10/2026 19:59 UTC by Local Admin
- Rows: all 42 rows of dataset version 2 (no filter)
- Cohort: not recorded

## Methods

No computation is recorded in this chain.

## Review & publication

- Evidence: version 1 (the latest version), saved 23/10/2026 19:59 UTC by Local Admin
- Evidence status: approved (the evidence's current status)
- Evidence content SHA-256: sha256:e9a786d1f5f13b7d5be8b8b3694e1f10b1e00cbb86a64ddff4b12afb31d46329
- Interpretation: "Clinical IgG4-RD measures correlate with microbiota reactivity in a reference-dependent pattern (Spearman, BH q<0.05 within each reference)" by Local Admin — approved by Local Admin on 24/10/2026 07:52 UTC
- Publication: not yet done (no published version contains this evidence version)

## Appendix A — Technical chain

### Result — cited snapshot ad3f115b-50be-4a23-adbc-46c8a3e89ce7

| # | Step | Name | ID | Version | Details | Created | Actor | Parents | Hash | Status | Not recorded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Source file | final_heatmap_synthetic.csv | 457560d8-d268-42e0-afa5-e0e82acdc12b | — | — | 2026-10-23T19:59:25.724Z | Local Admin | — | sha256:559f35b8b59d86c372bf03b49d93c933f6f73477b61b8a3a2289a64afb86b3cf | recorded | — |
| 2 | Dataset version | version 2 | 457560d8-d268-42e0-afa5-e0e82acdc12b | 2 | — | 2026-10-23T19:59:25.724Z | Local Admin | — | sha256:53e91d9c1d8aa86165eb3a3d2e814401077be639b28fed8d6863ec5f14ce6cbb | recorded | — |
| 3 | Ingestion & profiling | ingestion 1 | 32d517e0-d247-4a89-abe5-9131daa209b7 | 1 | — | 2026-10-23T19:59:25.743Z | system | 457560d8-d268-42e0-afa5-e0e82acdc12b | — | recorded | — |
| 4 | Cohort | — | not recorded | — | — | — | — | — | — | not recorded | cohort, cohort version, cohort hash, filters, lock state, locked by, locked at |
| 5 | Analysis | synthetic — Slide 3: Spearman heatmap (6 x 7) | ef250266-36fe-421f-b45a-2b7b2f02329a | — | — | 2026-10-23T19:59:26.304Z | Local Admin | — | — | recorded | — |
| 6 | Rule | — | not recorded | — | — | — | — | — | — | not recorded | rule version |
| 7 | Run | — | not recorded | — | — | — | — | — | — | broken link (error) | — |
| 8 | Result snapshot | snapshot v1 | ad3f115b-50be-4a23-adbc-46c8a3e89ce7 | 1 | origin filter | 2026-10-23T19:59:26.308Z | Local Admin | — | — | recorded | per-column filter combinators, producing run |
| 9 | Chart | synthetic — Spearman heatmap: 6 clinical variables x 7 references (slide layout) | 402ddb56-1a0f-470e-8447-0028d1ff45d4 | — | template heatmap_annotated_v1 v1.0.0 · origin user | 2026-10-23T19:59:26.378Z | Local Admin | — | — | recorded | content hash |
| 10 | Evidence | Spearman correlation heatmap: 6 clinical variables x 7 references (BH within reference) | e3f3b251-e4d9-4d05-93a3-7cf6be7d9209 | 1 | — | 2026-10-23T19:59:26.410Z | Local Admin | eb9ab5bf-6486-4536-94d5-9ff335311164 | sha256:e9a786d1f5f13b7d5be8b8b3694e1f10b1e00cbb86a64ddff4b12afb31d46329 | current | — |
| 11 | Interpretation | Clinical IgG4-RD measures correlate with microbiota reactivity in a reference-dependent pattern (Spearman, BH q<0.05 within each reference) | 9bb54d75-943e-4784-b0b8-5cc41fbbedce | — | — | 2026-10-24T07:52:29.848Z | Local Admin | — | sha256:85e2ce3d440cce9c8b4751012f501b493d406ccba8eebb5ae7eb0289d8c76d11 | approved | — |
| 12 | Publication | — | not recorded | — | — | — | — | — | — | not yet published | — |

## Appendix B — Attached files

| File | SHA-256 |
| --- | --- |
| [charts/402ddb56-1a0f-470e-8447-0028d1ff45d4.png](./charts/402ddb56-1a0f-470e-8447-0028d1ff45d4.png) | in manifest.json (rendered on download) |
| [data/charts/402ddb56-1a0f-470e-8447-0028d1ff45d4.csv](./data/charts/402ddb56-1a0f-470e-8447-0028d1ff45d4.csv) | sha256:6c7fa95ac316dfc6c0732ce035149820881de77b8bae1045158541742085b883 |
| [data/source/final_heatmap_synthetic.csv](./data/source/final_heatmap_synthetic.csv) | sha256:559f35b8b59d86c372bf03b49d93c933f6f73477b61b8a3a2289a64afb86b3cf |

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are rendered when the bundle is built, so their bytes may differ between downloads; their hash is in manifest.json only and is not part of the Report SHA-256.
- This bundle contains the source file and row-level chart data, which may contain patient-level data. Handle it under your data-protection rules.
