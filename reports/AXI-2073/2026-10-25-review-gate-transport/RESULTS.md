# AXI-2073 Evidence Audit Report: re-run after the review gate (transport ceiling)

> Paths are relative to this folder. Playwright traces (`trace.zip`, `playwright-report/data/*.zip`) are NOT committed, because they carry the test user's bearer token (NFR6). They are git-ignored. `playwright-report/trace/` holds only the viewer's static assets. `bundles/*` hold the demo's synthetic datasets (no real patient data).

Date 2026-10-25.
- Backend: axiome-back `AXI-2073-redesign` @2752d267 on http://localhost:3011. This is the sidecar `axiome-2073r-backend`. It bind-mounts the back worktree and was restarted with `docker restart` to load the new code. The shared demo stack and DB were not touched.
- Front: http://localhost:5174.
- Docs: axiome-docs `AXI-2073-redesign` @7e5cd74 (FR19 amended; EC13 and AC22 added).
- Previous run: [`../2026-10-25-review-points/RESULTS.md`](../2026-10-25-review-points/RESULTS.md).

## The blocker and the fix

The review gate found one blocker. The bundle travels to the gateway as base64 inside one RabbitMQ reply. A 100 MiB default source file gives a bundle of about 140 MiB once encoded, and RabbitMQ 3.13 rejects any message over its default `max_message_size` of 128 MiB. The download would fail with a 500.

- **(a) Lower default.** `AUDIT_BUNDLE_SOURCE_MAX_BYTES` now defaults to 67108864 bytes (64 MiB), which encodes to about 85.3 MiB.
- **(b) Transport ceiling.** After the zip is built, the organization-service checks its encoded size, `ceil(bytes / 3) × 4`, against `AUDIT_BUNDLE_TRANSPORT_MAX_ENCODED_BYTES` = 100663296 bytes (96 MiB). The constant's comment ties it to RabbitMQ's 128 MiB default and leaves 32 MiB for the JSON envelope. If the bundle would exceed it, every attached source file is dropped and the bundle is rebuilt once, through the same exclusion path as an over-limit file (EC12/EC13).
  - The rebuild is a pure function of the first gather. Nothing is read again, so it stays deterministic.
  - The manifest's `excludedFiles` records `reason: "over_transport_limit"` together with `sizeBytes` (the streamed size), `limitBytes` (the encoded ceiling) and the **recorded** `rawFileHash` (null when none was recorded).
  - The SHA-256 computed while the file streamed is thrown away with the bytes, so it is never written anywhere (FR4).
  - The ceiling is not an env setting, because it follows the broker. A test seam (the `AUDIT_BUNDLE_TRANSPORT_CEILING` injection token, optional) lets unit tests force a rebuild without 96 MiB of data.
- **MiB labels.** Sizes now print as B/KiB/MiB/GiB/TiB. This covers the config comments, spec FR19 and the report.

The new report line (Data section; the hash part reads "SHA-256 — not recorded" when there is no recorded hash):

```
- Source file not included — with this <size> file the bundle would exceed the transport size limit of 96 MiB (base64-encoded); SHA-256 recorded: sha256:<rawFileHash>
```

The raw-hash line for that dataset reads: `- Raw file SHA-256: sha256:<rawFileHash> — not checked — the source file would push the bundle over the transport size limit (see below)`.

The per-file line now reads, for example: `- Source file not included — 150 MiB exceeds the bundle limit of 64 MiB; SHA-256 recorded: sha256:<rawFileHash>`.

## Results

| Check | Result | Evidence |
|---|---|---|
| Back unit tests: full org-service jest (`AXIOME_DOCS_ROOT` set) | 834 suites passed, 3 skipped. 12289 tests passed, 7 skipped, 0 failed | back commit 2752d267 |
| `tsc --noEmit -p apps/organization-service/tsconfig.app.json` | clean | — |
| New unit tests UT-GRAPH-2314..2318 | PASS. 2314: overflow drops the source and rebuilds, the encoded bundle is within the ceiling, `over_transport_limit`, exact line, object opened and streamed once. 2315: the rebuild is deterministic. 2316: at or under the ceiling nothing changes. 2317: no recorded hash gives null, and the streamed hash appears nowhere. 2318: base64 length, 96 MiB < 128 MiB, encoded 64 MiB default < ceiling | `apps/organization-service/src/provenance/audit-report/UT.md` |
| Playwright `tests/AXI-2073`, headless, against :3011 | **31/31 passed** (33.8 s) | `results.json`, `playwright-report/index.html` |
| `verify_bundles.py` on 10 re-fetched bundles | all PASS. Manifest hashes, recomputed report hash, source SHA-256 = `rawFileHash`, NFR4 grep. 949d5bcf v3 determinism: only `generatedAt` differs | `verification.json` |
| `verify_review_points.py` (RP1/RP2) | all PASS. includeSource=false determinism: only `generatedAt` differs | `verification.json` |
| `verify_transport.py` (new) | all PASS on 10 bundles. Every encoded size is within 96 MiB (largest: eb9ab5bf v1 at 226156 encoded bytes). No `over_transport_limit` exclusion and no transport line. No " MB" label in any report | `verification.json`, `verify_transport.py` |
| Report hashes vs the previous run | identical for all 10 bundles. No live bundle is near either limit, so its report text is unchanged | `bundles/*/unzipped/manifest.json` vs `../2026-10-25-review-points/bundles/` |

Bundles: `bundles/` holds 949d5bcf-v3 (and -second, -nosource, -nosource-second), 5891a5ac-v6, b305a9bf-v1, d37eff12-v1, c700a6bd-v1, eb9ab5bf-v1 and 90efa713-v1. Each was fetched with `../2026-10-25-o1-o3-o4-fixes/fetch_bundle.py`.

## Decisions and deviations

- **The over-limit and over-ceiling paths were not exercised live.** No live source file comes near 64 MiB, and the sidecar would have to be recreated (not just restarted) to take a smaller limit. It carries the shared `axiome-demo` compose labels, and the ceiling is deliberately not an env setting. Unit tests UT-GRAPH-2300..2307 and 2314..2318 cover both paths.
- **The rebuild drops every attached source file**, not only the largest. This keeps the rule simple and deterministic, with one rebuild. Leaving out the source still leaves the recorded hash in the report and manifest.
- **Residual:** if a bundle is still over the ceiling with no source file attached (aggregate and chart CSVs alone), it is not reduced further and would still fail at the broker. No live bundle is anywhere near this (all are under 0.25 MiB encoded).
- **`limitBytes` changes meaning by reason.** For `over_size_limit` it is in raw bytes. For `over_transport_limit` it is the encoded ceiling. Both are documented in FR19 and on the `SourceExclusion` type.
- RP4's title now names the 64 MiB default and the 96 MiB ceiling. It also asserts that no `excludedFiles` entry exists.
- The 2026-10-24 campaign RESULTS.md no longer claims committed traces (advisory). The previous review-points RESULTS.md was relabelled in MiB and points here.
- Untracked files this campaign did not create were left alone: `playwright.campaign.config.ts` and `reports/AXI-2073/2026-10-25-round2-phase1-findings/`.

Run: `E2E_TEST_EMAIL=admin@cro-one.com E2E_TEST_PASSWORD=admin API_BASE_URL=http://localhost:3011 BASE_URL=http://localhost:5174 PLAYWRIGHT_HTML_OUTPUT_DIR=$R/playwright-report PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_JSON_OUTPUT_FILE=$R/results.json npx playwright test tests/AXI-2073 --output $R/test-results --reporter=list,html,json --trace on`. Then `python3 -I ../2026-10-25-o1-o3-o4-fixes/verify_bundles.py bundles`, `python3 -I ../2026-10-25-review-points/verify_review_points.py bundles` and `python3 -I verify_transport.py bundles`, each run from `reports/AXI-2073/` with that folder's paths.
