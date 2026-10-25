# AXI-2073 Evidence Audit Report: E2E campaign for the owner's review points 1 and 2

> Paths are relative to this folder. Playwright traces (`trace.zip`, `playwright-report/data/*.zip`) are NOT committed, because they carry the test user's bearer token (NFR6). They are git-ignored. `bundles/*` hold the demo's synthetic datasets (no real patient data).

Date 2026-10-25.

> **Superseded in part by the review gate (same day).** The default source limit is now 64 MiB (67108864), the base64-encoded bundle is held under a 96 MiB transport ceiling, and sizes print with KiB/MiB/GiB labels. Re-run and results: [`../2026-10-25-review-gate-transport/RESULTS.md`](../2026-10-25-review-gate-transport/RESULTS.md). The figures below are this run's, relabelled in MiB.
- Backend: axiome-back `AXI-2073-redesign` @89f4f83d on http://localhost:3011. This is the sidecar `axiome-2073r-backend`. It bind-mounts the back worktree and was restarted with `docker restart` to load the new code. The shared demo DB was not touched.
- Front: http://localhost:5174.
- Docs: axiome-docs `AXI-2073-redesign` @a9bc5a5 (FR12 amended; FR19, EC12, AC20 and AC21 added).

## What changed

- **Review point 1: no chart image without the source data.** With `includeSource=false`, no chart image is read, rendered or attached, for every chart type. There is no per-template allow-list, because a chart can draw one mark per patient (a strip chart draws one point per patient). Where the image would be, report.md now says the image is withheld (exact line below). The manifest lists no PNG, and Appendix B says the images are withheld. Nothing changes with `includeSource=true`.
- **Review point 2: source size limit, with streaming.** `AUDIT_BUNDLE_SOURCE_MAX_BYTES` (organization-service, default at the time 104857600 = 100 MiB; now 64 MiB) limits the source file. The file is streamed from storage into the zip entry: each chunk is hashed (SHA-256, CRC-32) and deflated as it arrives. When `Dataset.sizeBytes` records the size, that size decides, so an oversized file is never downloaded. When no size is recorded, the stream stops as soon as the limit is passed. Over the limit, report.md, the CSVs and the manifest still ship. The report gives the over-limit line below, and the manifest's `excludedFiles` records `datasetId`, `filename`, `reason: "over_size_limit"`, `sizeBytes` (null when not recorded), `limitBytes` and the recorded `rawFileHash` (null when not recorded). No hash is ever computed (FR4).

Rendered lines:

```
- Chart: synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — Chart image withheld — source data excluded from this bundle (chart 4c6138e6, template boxplot_v1 v1.0.0)
- Source file not included — 150 MiB exceeds the bundle limit of 100 MiB; SHA-256 recorded: sha256:<rawFileHash>
- Source file not included — more than 10 B exceeds the bundle limit of 10 B; SHA-256 recorded: sha256:<rawFileHash>   (no recorded size; the stream stopped at the limit)
- Source file not included — 2 MiB exceeds the bundle limit of 1 MiB; SHA-256 — not recorded   (no rawFileHash recorded)
```

- The withheld line comes from the live bundle `bundles/949d5bcf-v3-nosource/unzipped/report.md`.
- The over-limit lines come from the back unit tests UT-GRAPH-2301, -2302, -2304 and -2309, which assert them exactly.
- The over-limit path was **not** exercised live. Every live source file is far below 100 MiB. To use a smaller limit, the sidecar would have to be recreated rather than restarted, and it carries the shared `axiome-demo` compose labels, so recreating it is not simple. The unit tests cover this path instead.

## Summary

| Group | Pass | Fail | Not run |
|---|---|---|---|
| Playwright `tests/AXI-2073` (29 tests + 2 auth setup) | 31 | 0 | 0 |
| - review points RP1–RP4 (new) | 4 | 0 | 0 |
| - redesign R1–R6, owner fixes O1/O3/O4, AXI-2077, AXI-2078, AXI-2081, AXI-2087 (regression) | 25 | 0 | 0 |
| Bundle verification `verify_bundles.py` (8 bundles + 2 determinism re-downloads) | all checks PASS | 0 | 0 |
| Review-point checks `verify_review_points.py` (same 10 downloads + includeSource=false determinism) | all checks PASS | 0 | 0 |
| Back unit tests: full org-service jest (`AXIOME_DOCS_ROOT` set) | 834 suites / 12284 tests | 0 | 3 suites / 7 tests skipped (pre-existing) |
| `tsc --noEmit -p apps/organization-service/tsconfig.app.json` | clean | 0 | — |
| Gateway tests | — | — | not run (gateway not touched) |

Run command:

```
E2E_TEST_EMAIL=admin@cro-one.com E2E_TEST_PASSWORD=admin API_BASE_URL=http://localhost:3011 BASE_URL=http://localhost:5174 \
PLAYWRIGHT_HTML_OUTPUT_DIR=<this folder>/playwright-report PLAYWRIGHT_JSON_OUTPUT_FILE=<this folder>/results.json \
npx playwright test tests/AXI-2073 --output <this folder>/test-results --reporter=list,html,json --trace on
```

JSON: `results.json`. HTML: `playwright-report/index.html`.

## New Playwright tests

| Title | Description | Deep link | Result | Evidence |
|---|---|---|---|---|
| RP1 fixture AC20 | With `includeSource=false`, the zip has no `charts/` file or PNG and the manifest lists no PNG. The chart line ends with "Chart image withheld — source data excluded from this bundle (chart `<id8>`, template scatter_v1 v1)". Appendix B says the images are withheld | fixture org created by the spec (no seeded link) | PASS | `results.json` |
| RP2 fixture AC20/FR13 | Two `includeSource=false` downloads: same report hash, and every non-report file hash in the manifest is identical | fixture org created by the spec | PASS | `results.json` |
| RP3 demo 949d5bcf v3 AC20 | Box plot (live spec): with `false`, no PNG and the exact withheld line `(chart 4c6138e6, template boxplot_v1 v1.0.0)`; with `true`, `charts/4c6138e6-….png` is attached, listed in the manifest, and named on the chart line | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS | `bundles/949d5bcf-v3*/` |
| RP4 fixture FR19 | Under the 100 MiB default (at the time), the source is streamed in whole: `data/source/statistical-trigger.csv` hashes to its manifest entry, the manifest has no `excludedFiles`, and the report has no "Source file not included" line | fixture org created by the spec | PASS | `results.json` |

## Bundle verification

Both scripts write their output to `verification.json`:
- `../2026-10-25-o1-o3-o4-fixes/verify_bundles.py bundles`
- then `verify_review_points.py bundles`, which appends its results

`verify_bundles.py` checks:
- the manifest SHA-256 of every file;
- the report hash, recomputed from report.md;
- that the manifest's report hash equals the stated one;
- `Raw file SHA-256` against `data/source/*`;
- with `includeSource=false`, that there is no source file and no chart CSV;
- an NFR4 grep.

`verify_review_points.py` checks:
- with `true`, that every chart line naming an image has its PNG attached and listed, and that no withheld line appears;
- with `false`, that there is no PNG in the zip, the manifest or report.md, and one withheld line per chart;
- that no bundle records an exclusion (all are under the limit);
- that the two `includeSource=false` downloads are identical except for `generatedAt` and the `Generated:` line.

| Title | Description | Deep link | Result | Evidence |
|---|---|---|---|---|
| Microbiote synthetic reproduction CER228 v3 | `includeSource` default (true) | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) | PASS (6/6 + 2/2) | `bundles/949d5bcf-v3/` |
| Same, includeSource=false | No source, no chart CSV, **no PNG**, withheld line | same | PASS (6/6 + 2/2) | `bundles/949d5bcf-v3-nosource/` |
| Safe Compare organ involvement (S3a) v6 | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/safe-compare-four-comparison-scenarios-igg4-rd/projects/7a8b2e86-5849-4911-adf6-a225d8665627/view-analyses/ace88f1b-8fe1-44cb-b960-e07942cc4e99/evidences/5891a5ac-d01e-4fa1-bc27-1ca397015c82) | PASS (6/6 + 2/2) | `bundles/5891a5ac-v6/` |
| ENT059 vs ACR/EULAR cluster (Kruskal-Wallis) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) | PASS (6/6 + 2/2) | `bundles/b305a9bf-v1/` |
| ENT059 vs pancreato-biliary (Mann-Whitney) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/d37eff12-f141-4524-9758-0e8b09a67880) | PASS (6/6 + 2/2) | `bundles/d37eff12-v1/` |
| Faceted Dunn post-hoc (3 facets) | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) | PASS (6/6 + 2/2) | `bundles/c700a6bd-v1/` |
| Heatmap, no linked run | Download and verify | [branch front](http://localhost:5174/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/ef250266-36fe-421f-b45a-2b7b2f02329a/evidences/eb9ab5bf-6486-4536-94d5-9ff335311164) | PASS (6/6 + 2/2) | `bundles/eb9ab5bf-v1/` |
| Statistical trigger surface, 20 runs (e2e org) | Download and verify | [branch front](http://localhost:5174/axiome-e2e-org/axi-1435-statistical-trigger-surface/axi-1435-statistical-trigger-surface/projects/368ce863-6d44-4ff3-afc6-2e1efc1772dd/view-analyses/9b0df399-16ab-4bc7-9d55-2e918e9dcad8/evidences/90efa713-6909-4797-9454-a98badd0ec2d) | PASS (6/6 + 2/2) | `bundles/90efa713-v1/` |
| Determinism (default): 949d5bcf v3 fetched twice | Diff of the first and second download | 949d5bcf link above | PASS. Only the manifest's `generatedAt` differs; report.md, PNG and CSV bytes are identical | `bundles/949d5bcf-v3-second/` |
| Determinism (includeSource=false): 949d5bcf v3 fetched twice | Diff of the first and second download | 949d5bcf link above | PASS. Only `generatedAt` differs; every non-report file hash is identical (no render-dependent file is left) | `bundles/949d5bcf-v3-nosource-second/` |

## Decisions and deviations

- **Streaming is partial.** The source bytes stream through an incremental deflate, so the raw file is never held whole. The finished bundle is still one in-memory buffer, because it crosses the gateway ↔ organization-service RabbitMQ message as base64 and the gateway sends it with a `Content-Length`. Streaming the whole response end to end would need a different transport. The zip writer is the module's own deterministic ZIP32 writer, not a library. It gained a pre-compressed entry form, and the limit is capped at 4 GiB − 1.
- **Unknown size.** With no recorded size and a stream that passes the limit, the true size is unknown, so `<size>` reads "more than `<limit>`" (manifest `sizeBytes: null`). A recorded size at or under the limit whose stream runs past it is stopped the same way.
- **Sizes print in binary units**, with at most one decimal (100 MiB = 104857600 bytes; labelled KiB/MiB/GiB since the review gate).
- **The short chart id** is the chart id's first 8 characters. Appendix A still shows the full id.
- **No strip-chart evidence was reachable** from the admin's workspaces on this stack, so the live checks use a box plot and a scatter. The rule applies to every chart type with no allow-list. UT-GRAPH-2296 covers a cached frozen render and a live on-demand render.
- Untracked files that this campaign did not create were left alone: `playwright.campaign.config.ts` and `reports/AXI-2073/2026-10-25-round2-phase1-findings/`.
