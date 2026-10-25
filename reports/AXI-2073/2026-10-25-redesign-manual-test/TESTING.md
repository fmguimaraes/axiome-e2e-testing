# AXI-2256 — Evidence Audit Report clinician redesign: owner manual test

Epic AXI-2073 · story AXI-2256 · written 2026-10-25 after the merge to main.

## What shipped (main)

| Repo | main SHA | Content |
| --- | --- | --- |
| axiome-back | `fea5aa11` | Squash of `AXI-2073-redesign` (4 commits): producing-run link, clinician report, source bundle, O1/O3/O4 fixes, review points (chart image withheld when `includeSource=false`), review gate (64 MiB source limit, 96 MiB base64 transport ceiling) |
| axiome-docs | `10e5614` | Feature and epic amendments (FR4/5/11/12/17/18/19, EC10-EC13, AC12-AC22), manual-e2e redesign scenarios, `audit_kpi` normalisers |
| axiome-e2e-testing | `76f6a94` | Redesign specs (R1-R6, O1/O3/O4, RP1-RP4, transport), campaign reports, owner round-2 phase-1 findings |

Squashed-tree gate before push (axiome-back): organization-service jest 834 suites / 12292 tests passed (3 suites and 7 tests skipped). `tsc --noEmit` passed for organization-service and gateway. Gateway jest: 1013/1014. The one red is `UT-GW-AUTHZ-1546-D` (`candidates.getFittingRuns`, from AXI-2253). It already failed on origin/main `0817cfdd` before this merge and has nothing to do with this story.

The demo backend (`axiome-demo-backend`, :3000, mounts the axiome-back main checkout) was restarted on `fea5aa11`. It rebuilt and started cleanly.

## How to log in

1. Open http://localhost:5173 and sign in as **admin@cro-one.com / admin**.
2. Pick the **Mag4** workspace (`8946e06a-4fe6-45ee-8d9a-58f7142e803a`). All evidences below belong to it.
3. Open a deep link. The evidence detail page has a **Download audit report** button. It downloads the bundle for the version shown (the current version), named `audit-<evidenceId>-v<n>.zip`.

The UI has **no includeSource toggle**: the button always asks for the source. To get the bundle without the source, call the gateway directly (row 2):

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@cro-one.com","password":"admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -s -o audit-949d5bcf-v3-nosource.zip \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: 8946e06a-4fe6-45ee-8d9a-58f7142e803a" \
  "http://localhost:3000/api/v1/view-analyses/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2/versions/3/audit-report?includeSource=false"
```

## Automated campaign evidence (this repo)

- `reports/AXI-2073/2026-10-24-redesign-campaign/`: redesign campaign, 22/22, bundles for 7 demo targets.
- `reports/AXI-2073/2026-10-25-o1-o3-o4-fixes/`: owner fixes O1/O3/O4.
- `reports/AXI-2073/2026-10-25-review-points/`: RP1-RP4, 31/31.
- `reports/AXI-2073/2026-10-25-review-gate-transport/`: review-gate re-run, 31/31, plus `verify_transport`.
- `reports/AXI-2073/2026-10-25-round2-phase1-findings/FINDINGS.md`: owner round-2 findings (input to AXI-2257).

Every link and expected result below was checked on 2026-10-25 against the restarted :3000 backend. Each front route returned HTTP 200, `GET /api/v1/view-analyses/evidences/<id>` returned the evidence, and each bundle was downloaded and unzipped.

## Tests

| # | Title | Description (what to do + expected result) | Deep link |
| --- | --- | --- | --- |
| 1 | 949d5bcf v3: download with source | Click **Download audit report**. Expected: the zip holds `charts/4c6138e6-….png`, `data/charts/4c6138e6-….csv`, 2 `data/runs/*.csv`, `data/source/tableau1_long_synthetic.csv`, `manifest.json` and `report.md`. The PNG title reads **"synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis)"** and the x label reads **"group"**. In report.md, the "What this evidence shows" Chart line reads "… — **box plot (template boxplot_v1 v1.0.0), made by a user** — image charts/4c6138e6-….png". In Appendix A, row 9 (Chart) has the Details column `template boxplot_v1 v1.0.0 · origin user`, and row 8 (Result snapshot) has `origin filter`. The verdict is "Incomplete — the chain has a broken link (error)" because no computation is linked; that is expected. | [949d5bcf](http://localhost:5173/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) |
| 2 | 949d5bcf v3: download WITHOUT the source | The UI has no toggle, so run the curl command from "How to log in" (`?includeSource=false`). Expected: the zip has **no PNG**, no `data/source/` and no `data/charts/`. It holds only the 2 `data/runs/*.csv`, `manifest.json` and `report.md`. The manifest has `includeSource: false` and lists 3 files. The report Chart line ends with "**Chart image withheld — source data excluded from this bundle (chart 4c6138e6, template boxplot_v1 v1.0.0)**". The Raw file SHA-256 line says "source file not included in this bundle (includeSource=false)". The notes say "Chart images are withheld from this bundle because the source data is excluded …". | [949d5bcf](http://localhost:5173/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) (page), then the gateway URL `http://localhost:3000/api/v1/view-analyses/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2/versions/3/audit-report?includeSource=false` |
| 3 | b305a9bf v1: Population wording, no raw JSON | Download the bundle and open report.md, Population section. Expected: "**Rows: all 23 rows of dataset version 2 (no filter)**" and "**Cohort: Cohort v1 (rows: no filter — all rows)**, locked by Local Admin on 23/10/2026 19:58 UTC; cohort SHA-256 …". Search report.md for `{`, `}` or `"key":`: there should be **no raw JSON** anywhere (0 matches). | [b305a9bf](http://localhost:5173/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) |
| 4 | b305a9bf v1: Appendix A Details column | Same bundle, Appendix A. Expected: the table header has a **Details** column. Row 8 (Result snapshot, snapshot v1) reads `origin filter`. Row 9 (Chart "synthetic — ENT059 by ACR/EULAR 2019 cluster (Kruskal-Wallis)") reads `template boxplot_v1 v1.0.0 · origin user`. Row 4 (Cohort v1) is recorded with its cohort SHA-256. | [b305a9bf](http://localhost:5173/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) |
| 5 | 5891a5ac v6 and reference heatmap eb9ab5bf v1: broken link under the new rule | Download both bundles. Expected: both verdicts read "**Incomplete — the chain has a broken link (error)**". The Computation line reads "none linked — broken link (error). The evidence does not record the computation behind its result." This is **expected**: under the redesign, an evidence without a recorded producing computation is a broken link, not "traceable". The bundles still contain the chart PNG, chart CSV and source CSV. | [5891a5ac](http://localhost:5173/projects/7a8b2e86-5849-4911-adf6-a225d8665627/view-analyses/ace88f1b-8fe1-44cb-b960-e07942cc4e99/evidences/5891a5ac-d01e-4fa1-bc27-1ca397015c82) · [eb9ab5bf](http://localhost:5173/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/ef250266-36fe-421f-b45a-2b7b2f02329a/evidences/eb9ab5bf-6486-4536-94d5-9ff335311164) |
| 6 | c700a6bd v1: baseline BEFORE round 2 (AXI-2257) | Download the bundle and keep it as the baseline for the round-2 comparison. Expected today: verdict "Traceable — some facts were not recorded". There are 3 linked Dunn's post-hoc computations (facets CER 215 et 234, CER 229, …), each with its z / p / Holm-adjusted p table, and a slide-2 strip chart PNG. **Known issues that round 2 will fix:** (a) no adjustment family is named, (b) there is no omnibus (Kruskal-Wallis) result before the post-hoc, (c) scope mismatch: the Data line says `reference = ENT 059` while the computations are other facets, (d) self-approval is not flagged (the Interpretation reads "by Local Admin — approved by Local Admin on 24/10/2026 07:52 UTC" with no warning). | [c700a6bd](http://localhost:5173/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| 7 | Determinism: same bundle twice | Download 949d5bcf v3 twice (row 1) and compare file by file. Expected: the PNG, chart CSV, run CSVs and source CSV are **byte-identical**. The `Report SHA-256:` line is identical. Only `Generated:` in report.md (minute resolution, so it changes only across a minute) and `generatedAt` in manifest.json differ. When `Generated:` changes, the report.md file hash in the manifest changes with it. Checked 2026-10-25: 5 data files identical, the manifest differed only in `generatedAt`. | [949d5bcf](http://localhost:5173/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) |
| 8 | Manifest hashes and Report SHA-256 | In any bundle: (a) `sha256sum` each file and compare it with its `files[].sha256` in manifest.json; all must match. (b) Delete the two lines starting with `Generated:` and `Report SHA-256:` from report.md and take the SHA-256 of the rest (UTF-8). It must equal the `Report SHA-256:` line and the manifest's `reportSha256`. Checked 2026-10-25 on all 6 bundles (949d5bcf with and without source, b305a9bf, c700a6bd, 5891a5ac, eb9ab5bf): all matched. | [b305a9bf](http://localhost:5173/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) (or any row above) |
| 9 | Size limit (64 MiB source / 96 MiB transport) | **Cannot be exercised on demo data**: every demo source file is under 30 KB and every bundle is under 200 KB. Over the limit, the source file is dropped, report/CSVs/manifest still ship with the recorded rawFileHash, and the manifest lists `excludedFiles` with reason `over_size_limit` / `over_transport_limit`. This is covered by unit tests **UT-GRAPH-2301..2318** (organization-service, green on the squashed tree). Nothing to click. | n/a |

## Known limitations

- **Bundle in memory over RMQ:** the bundle is built in memory in organization-service and sent base64-encoded over RabbitMQ to the gateway. The 96 MiB transport ceiling (RabbitMQ 3.13 default `max_message_size` is 128 MiB) guards it, but it is not streamed end to end.
- **CSV-only overflow residual:** only the source file is dropped when the bundle is too large. If report + chart/run CSVs alone exceed the transport ceiling (very large row-level chart CSVs), the bundle can still fail. This has not been seen on any real dataset.
- **O3 export follow-up:** the chart title/x-label fallback applies to the audit render only. The regular chart export is unchanged, so an exported PNG of the same chart may still lack the title/x label until the export follow-up is done This needs its own story because it changes export PNG bytes and the rendered-image cache (notes in the branch's `AXI-2073-REDESIGN-FINDINGS.md` §6, kept outside the repo).
