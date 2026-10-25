# AXI-2073 Evidence Audit Report — E2E campaign, owner fixes O1 / O3 / O4

> Paths below are relative to this folder. Playwright traces (`trace.zip`) were NOT committed: they carry the test user's bearer token (NFR6). `playwright-report/` and `test-results/` hold screenshots and results only. `bundles/*` contain the demo's synthetic source datasets (no real patient data).

Date 2026-10-25. Backend: axiome-back `AXI-2073-redesign` @188a9ab0 on http://localhost:3011 (sidecar `axiome-2073r-backend`, bind-mounts the back worktree, restarted to load the new code; shared demo DB untouched). Front: axiome-front origin/main @9c16be3 on http://localhost:5174, API pointed at :3011. Specs: this branch (`tests/AXI-2073/`).

**Deep-link note.** The "demo" link (:5173) opens the demo front on the main gateway, so "Download audit report" there returns the OLD (main) bundle. Use the "branch front" link (:5174) to download the bundle with O1/O3/O4. Credentials: admin@cro-one.com / admin.

## What changed (renderer only, no schema / data / bio-compute contract change)

- **O1**: the chart's template, template version and origin, and the snapshot's origin, are printed again: the "What this evidence shows" chart line, the Population "Cited data" line, and a new **Details** column in Appendix A.
- **O3** (audit path only): when a spec's `params` has no `chart_title` / `x_title`, the audit PNG falls back to `dataview_specs.title` and to the grouping column's name. An explicit value wins, the empty string included. The shared chart-image renderer and the ExportsService output did not change.
- **O4**: the slice is phrased from its filters: "the whole dataset (no filter)" or "a filtered view of the dataset". With no filter: "Rows: all N rows of dataset version v (no filter)", where N is the RECORDED profiling row count (otherwise "not recorded"). Cohort filters are put into words, and raw filter JSON is never printed.

## Summary

| Group | Pass | Fail | Not run |
|---|---|---|---|
| Playwright `tests/AXI-2073` (25 tests + 2 auth setup) | 27 | 0 | 0 |
| - redesign audit-bundle R1–R6 (regression) | 6 | 0 | 0 |
| - owner fixes O1/O3/O4 (new) | 5 | 0 | 0 |
| - AXI-2077 endpoint | 5 | 0 | 0 |
| - AXI-2078 UI download | 3 | 0 | 0 |
| - AXI-2081 methods / R-equivalence | 2 | 0 | 0 |
| - AXI-2087 cohort step (updated for the Details column and the new cohort wording) | 4 | 0 | 0 |
| Bundle verification (9 downloads: 7 targets + includeSource=false + determinism re-fetch) | all checks PASS | 0 | 0 |
| Back unit tests: full org-service jest (`AXIOME_DOCS_ROOT` set) | 833 suites / 12260 tests | 0 | 3 suites / 7 tests skipped (pre-existing) |
| Gateway tests | — | — | not run (gateway not touched) |

The first run had one failure. AXI-2087 FR2/AC2 parsed Appendix A by column position, and the new Details column shifted the columns. I fixed the spec (it adds `details` to its column list and uses the new cohort-line regex) and reran it. The run reported here is that rerun: 27/27 passed.

Run: `E2E_TEST_EMAIL=admin@cro-one.com E2E_TEST_PASSWORD=admin API_BASE_URL=http://localhost:3011 BASE_URL=http://localhost:5174 npx playwright test -c playwright.campaign.config.ts tests/AXI-2073` (the campaign config is an untracked wrapper that only changes reporters, trace, screenshot and outputDir). JSON: `results.json`. HTML: `playwright-report/index.html`.

## New Playwright tests (owner fixes)

| Title | Description | Deep link | Result | Evidence (artifact path) |
|---|---|---|---|---|
| O1 fixture | Fixture evidence: the chart line carries the template and its version; the Appendix A chart row's Details reads `template … · origin …`; Population names the snapshot origin | fixture org created by the spec (no seeded link) | PASS | `results.json`, `test-results/` |
| O4 fixture | An unfiltered slice reads "the whole dataset (no filter)" and gives the RECORDED row count; no `{"`/`filters` JSON anywhere in report.md | fixture org created by the spec (no seeded link) | PASS | `results.json`, `test-results/` |
| O1/O4 demo 949d5bcf v3 | "box plot (template boxplot_v1 v1.0.0), made by a user"; the filtered view keeps "Rows in the slice: not recorded" | [demo](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) · [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS | `bundles/949d5bcf-v3/unzipped/report.md` |
| O4 demo b305a9bf v1 | Whole dataset, "Rows: all 23 rows of dataset version 2 (no filter)", cohort "rows: no filter — all rows", no raw JSON | [demo](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) · [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) | PASS | `bundles/b305a9bf-v1/unzipped/report.md` |
| O3 demo PNG ink | Spec 4c6138e6 (`params {}`): the top 6% band has more than 500 dark pixels (title) and the bottom 4.5% band more than 100 (x label). Spec 18606f58 (explicit `x_title ""`): title present, bottom band exactly 0 dark pixels | [949d5bcf branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) · [b305a9bf branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) | PASS. Measured: 4c6138e6 top/bottom = 3826/652 (previous campaign 0/0); 18606f58 = 3783/0 | `bundles/949d5bcf-v3/unzipped/data/charts/`, `bundles/b305a9bf-v1/unzipped/data/charts/` |

I also opened the 949d5bcf PNG and looked at it. It now carries the title "synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis)" and the x-axis label "group".

## Bundle verification (`verify_bundles.py`, output in `verification.json`)

Checks:
- the manifest SHA-256 of every file;
- the report hash, recomputed from report.md without the `Generated:` and `Report SHA-256:` lines;
- `Raw file SHA-256` equals the sha256 of `data/source/*`;
- with includeSource=false, no `data/source/` and no `data/charts/` CSV;
- an NFR4 grep (hosts, URLs, secrets, absolute paths, e-mails).

| Title | Description | Deep link | Result | Evidence (artifact path) |
|---|---|---|---|---|
| Microbiote synthetic reproduction CER228 v3 | Download from :3011 and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS (6/6) | `bundles/949d5bcf-v3/` |
| Same, includeSource=false | No source, no row-level chart CSV | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS (6/6) | `bundles/949d5bcf-v3-nosource/` |
| Safe Compare organ involvement (S3a) v6 | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/safe-compare-four-comparison-scenarios-igg4-rd/projects/7a8b2e86-5849-4911-adf6-a225d8665627/view-analyses/ace88f1b-8fe1-44cb-b960-e07942cc4e99/evidences/5891a5ac-d01e-4fa1-bc27-1ca397015c82) | PASS (6/6) | `bundles/5891a5ac-v6/` |
| ENT059 vs ACR/EULAR cluster (Kruskal-Wallis) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) | PASS (6/6) | `bundles/b305a9bf-v1/` |
| ENT059 vs pancreato-biliary (Mann-Whitney) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/d37eff12-f141-4524-9758-0e8b09a67880) | PASS (6/6) | `bundles/d37eff12-v1/` |
| Faceted Dunn post-hoc (3 facets) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) | PASS (6/6) | `bundles/c700a6bd-v1/` |
| Heatmap, no linked run | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/ef250266-36fe-421f-b45a-2b7b2f02329a/evidences/eb9ab5bf-6486-4536-94d5-9ff335311164) | PASS (6/6) | `bundles/eb9ab5bf-v1/` |
| Statistical trigger surface, 20 runs (e2e org) | Download and verify | [branch front](http://localhost:5174/axiome-e2e-org/axi-1435-statistical-trigger-surface/axi-1435-statistical-trigger-surface/projects/368ce863-6d44-4ff3-afc6-2e1efc1772dd/view-analyses/9b0df399-16ab-4bc7-9d55-2e918e9dcad8/evidences/90efa713-6909-4797-9454-a98badd0ec2d) | PASS (6/6) | `bundles/90efa713-v1/` |
| Determinism: 949d5bcf v3 fetched twice, 61 s apart | Diff first vs second download | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS. In report.md only the `Generated:` line differs; in the manifest only `generatedAt` and the report.md hash differ. PNG and CSV bytes are identical | `bundles/949d5bcf-v3-second/`, `verification.json` |

None of the 9 report.md files contains raw filter JSON (`"filters"`, `filterCombinator`, `as recorded:`).

## Report excerpts (from the downloaded bundles)

### b305a9bf v1 (whole dataset)

```
- Data: the whole dataset (no filter) — a saved filtered view (origin: filter), not a computed result
- Chart: synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — image charts/18606f58-43a1-45b0-bfd1-dc15d8b83439.png
- Cited data: the whole dataset (no filter) — a saved filtered view (origin: filter), not a computed result; snapshot v1, saved 23/10/2026 19:58 UTC by Local Admin
- Rows: all 23 rows of dataset version 2 (no filter)
- Cohort: Cohort v1 (rows: no filter — all rows), locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 sha256:a5969f385e7e868b2b21a5823e1cfd5be8ac966b8c58d32b51a7b6e768541ac8
| 8 | Result snapshot | snapshot v1 | f9e834e3-5aa9-48b0-af16-8206fa520669 | 1 | origin filter | 2026-10-23T19:58:33.017Z | Local Admin | — | — | recorded | per-column filter combinators, producing run |
| 9 | Chart | synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis) | 18606f58-43a1-45b0-bfd1-dc15d8b83439 | — | template boxplot_v1 v1.0.0 · origin user | 2026-10-23T19:58:38.940Z | Local Admin | — | — | recorded | content hash |
```

### 949d5bcf v3 (filtered view)

```
- Data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result — group is one of HD, IgG4-RD, SD and reference = CER 228
- Chart: synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — image charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png
- Cited data: a filtered view of the dataset — a saved filtered view (origin: filter), not a computed result; snapshot v2, saved 19/10/2026 23:35 UTC by Local Admin
- Rows kept: group is one of HD, IgG4-RD, SD and reference = CER 228
- Rows in the slice: not recorded (the row count of a slice is not stored)
- Cohort: not recorded
| 8 | Result snapshot | snapshot v2 | a2ef532c-14d6-4c06-9425-210a6a0fc93f | 2 | origin filter | 2026-10-19T23:35:48.556Z | Local Admin | — | — | recorded | per-column filter combinators, producing run |
| 9 | Chart | synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) | 4c6138e6-1640-48cb-9745-7b49658daf7b | — | template boxplot_v1 v1.0.0 · origin user | 2026-10-20T00:20:05.881Z | Local Admin | — | — | recorded | content hash |
```

## Decisions and deviations

- **`chart_title: ""` counts as explicit and wins.** It is not replaced by the fallback. This follows the brief's "a present key is set" rule, and keeps b305a9bf's `x_title ""` empty.
- The O3 fallback lives in the audit chart-render adapter (audit path only). A cached image produced by the export path is used as is, so it gets no fallback.
- The sidecar was **restarted** (`docker restart`), not recreated. It bind-mounts the back worktree, so a restart loads the new code. The shared demo containers (:3000, :5173, DB) were not touched.
- The "Rows: all N rows" count is the ingestion profiling `rowCount` recorded for that dataset version. Nothing is counted at render time (FR4).
