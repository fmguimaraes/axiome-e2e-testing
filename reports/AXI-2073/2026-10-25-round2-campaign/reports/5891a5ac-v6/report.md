# Audit report — Post-treatment TFH trends down (mean −12.4 cells/µL) but is not significant at n=11; the cohort splits into three TFH tertiles

Project: Safe Compare — Four Comparison Scenarios (IgG4-RD) · Evidence v6 (latest)
Evidence ID: 5891a5ac-d01e-4fa1-bc27-1ca397015c82 · version ID: e2dfa97a-6ff0-4c94-a01c-0bfe619b30c1
Generated: 25/10/2026 10:02 UTC by Local Admin
Report SHA-256: sha256:f1694420cc8fd4e018bb6ef0e13c0af836c19ce5addc4653b5ae3f17d594937e
Source data: not included (includeSource=false).

## Verdict

**Not traceable**

### Evidence

| Severity | Where | What |
| --- | --- | --- |
| error | Result · Run | The evidence does not record the computation behind its result. |
| not recorded | Result · Chart (S3a — Organ-involvement frequency (partition inputs for phenotypic subgroups)) | content hash — not recorded |
| not recorded | Result · Evidence (Post-treatment TFH trends down (mean −12.4 cells/µL) but is not significant at n=11; the cohort splits into three TFH tertiles) | content hash — not recorded (created before the content hash feature, 19/10/2026 21:14 UTC) |
| not yet done | Review | No interpretation has been recorded. |
| not recorded | Result · Publication (published version 8) | content hash — not recorded (created before the content hash feature, 19/10/2026 21:14 UTC) |
| not yet done | Review | The evidence is draft, not approved. |

## What this evidence shows

> Post-treatment TFH trends down (mean −12.4 cells/µL) but is not significant at n=11; the cohort splits into three TFH tertiles

- Evidence status: draft

- Data: a saved data view (origin: filter), not a computed result — no filter
- Computation: none linked — broken link (error). The evidence does not record the computation behind its result.
- Chart: S3a — Organ-involvement frequency (partition inputs for phenotypic subgroups) — bar count (template bar_count_v1 v1.0.0), made by a user — Chart image withheld — source data excluded from this bundle (chart abe9eabf, template bar_count_v1 v1.0.0)

## Data

### 03-organ-involvement.csv

- File: 03-organ-involvement.csv
- Uploaded by Local Admin on 04/09/2026 08:06 UTC
- Raw file SHA-256: sha256:534ba2c496efe2c89fb5717317f1babe94b56e02c18cdf2bfad4af3520aa4cec — source file not included in this bundle (includeSource=false)
- Dataset ID: d111027c-e03b-48a7-9f2e-fe8282b24cf0
- Dataset version: 2 (dataset version SHA-256 sha256:c50c623d424bae3a58538c57b0d63b9affaaa34f2862aac1b34b57020ec60946)
- Size: 72 rows × 5 columns (ingestion 1)
- Ingestion: 04/09/2026 08:06 UTC by service: ingestion; profiled with polars-1.44.1 (profiler 1.1.0)
- Ingestion ID: 167eee55-2436-455c-b96d-6f7bbd959455

## Population

- Cited data: a saved data view (origin: filter), not a computed result; snapshot v5, saved 04/09/2026 10:27 UTC by Local Admin
- Rows: all 72 rows of dataset version 2 (no filter)
- Producing run: not applicable — snapshot is a data view, results come from runs linked via chart abe9eabf-3fee-482a-9d0e-b3da92b693e9
- Cohort: not recorded

## Methods

No computation is recorded in this chain.

## Review & publication

- Evidence: version 6 (the latest version), saved 04/09/2026 11:07 UTC by Local Admin
- Evidence status: draft (the evidence's current status)
- Evidence content SHA-256: not recorded (created before the content hash feature, 19/10/2026 21:14 UTC)
- Interpretation: not yet done (no interpretation cites this evidence version)
- Publication: published version 8 by Local Admin on 04/09/2026 11:07 UTC

## Appendix A — Technical chain

### Result — cited snapshot 93140af5-bf48-4df5-b729-c749932657e0

| # | Step | Name | ID | Version | Details | Created | Actor | Parents | Hash | Status | Not recorded | Not applicable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Source file | 03-organ-involvement.csv | d111027c-e03b-48a7-9f2e-fe8282b24cf0 | — | — | 2026-09-04T08:06:10.499Z | Local Admin | — | sha256:534ba2c496efe2c89fb5717317f1babe94b56e02c18cdf2bfad4af3520aa4cec | recorded | — | — |
| 2 | Dataset version | version 2 | d111027c-e03b-48a7-9f2e-fe8282b24cf0 | 2 | — | 2026-09-04T08:06:10.499Z | Local Admin | — | sha256:c50c623d424bae3a58538c57b0d63b9affaaa34f2862aac1b34b57020ec60946 | recorded | — | — |
| 3 | Ingestion & profiling | ingestion 1 | 167eee55-2436-455c-b96d-6f7bbd959455 | 1 | — | 2026-09-04T08:06:10.544Z | service: ingestion | d111027c-e03b-48a7-9f2e-fe8282b24cf0 | — | recorded | — | — |
| 4 | Cohort | — | not recorded | — | — | — | — | — | — | not recorded | cohort, cohort version, cohort hash, filters, lock state, locked by, locked at | — |
| 5 | Analysis | 3 — Statistical-rule enrichment: phenotypic subgroup partition (governed application) | ace88f1b-8fe1-44cb-b960-e07942cc4e99 | — | — | 2026-09-04T08:34:19.176Z | Local Admin | — | — | recorded | — | — |
| 6 | Rule | — | not recorded | — | — | — | — | — | — | not recorded | rule version | — |
| 7 | Run | — | not recorded | — | — | — | — | — | — | broken link (error) | — | — |
| 8 | Result snapshot | snapshot v5 | 93140af5-bf48-4df5-b729-c749932657e0 | 5 | origin filter | 2026-09-04T10:27:20.132Z | Local Admin | — | — | recorded | — | per-column filter combinators, producing run |
| 9 | Chart | S3a — Organ-involvement frequency (partition inputs for phenotypic subgroups) | abe9eabf-3fee-482a-9d0e-b3da92b693e9 | — | template bar_count_v1 v1.0.0 · origin user | 2026-09-04T08:34:20.034Z | Local Admin | — | — | recorded | content hash | — |
| 10 | Evidence | Post-treatment TFH trends down (mean −12.4 cells/µL) but is not significant at n=11; the cohort splits into three TFH tertiles | e2dfa97a-6ff0-4c94-a01c-0bfe619b30c1 | 6 | — | 2026-09-04T11:07:57.798Z | Local Admin | 5891a5ac-d01e-4fa1-bc27-1ca397015c82 | — | current | content hash | — |
| 11 | Interpretation | — | not recorded | — | — | — | — | — | — | not yet done | interpretation | — |
| 12 | Publication | published version 8 | 80f680bd-dd05-4d12-a584-71db151a5ca9 | 8 | — | 2026-09-04T11:07:57.905Z | Local Admin | — | — | published | content hash | — |

## Appendix B — Attached files

No files are attached.

- report.md and manifest.json are listed with their SHA-256 in manifest.json.
- To verify this report: delete the two lines that start with "Generated:" and "Report SHA-256:"; the SHA-256 of the remaining text (UTF-8) is the Report SHA-256.
- Chart images are withheld from this bundle because the source data is excluded (a chart can show one point per patient).
