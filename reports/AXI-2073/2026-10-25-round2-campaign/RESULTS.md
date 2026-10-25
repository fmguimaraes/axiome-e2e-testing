# AXI-2257 — round 2 audit fixes (F1–F7) — E2E campaign, 2026-10-25

- Spec: `tests/AXI-2073/AXI-2257-round2-audit-findings.spec.ts` (read-only, REST)
- Stack: sidecar `axiome-2257-backend` on http://localhost:3012 (back worktree AXI-2257, shared demo DB, RabbitMQ vhost `axi-2257`, Redis db 12)
- Run: headless, `--project=chromium --no-deps`. **17/17 passed** in 6.5 s (re-run after the owner heading fix; sidecar restarted) (`results.json`, `playwright-report/`)
- Negative control: the same spec against the demo backend :3000 (AXI-2256 code) fails at R2-1 (headline "Traceable — some facts were not recorded."). The suite runs in serial mode, so the remaining tests did not run there.
- Bundles: `reports/<evidence>-v<n>/report.md` + `manifest.json` from the sidecar (`c700-v1` with source, all others with `includeSource=false`). No zip and no trace is stored.

Front links point at the demo stack (:5173). The report itself is the sidecar's download.

| Title | Description | Deeplink |
| --- | --- | --- |
| R2-1 Headline | c700a6bd v1 opens with "Traceable — with warnings" (FR18, AC23) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-2 Grouping | The Evidence group comes first, then one group per facet run: ENT 059, CER 229, CER 215 et 234 (FR18, FR24) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-2b Methods headings | Each Methods run heading is the verdict group label plus its link, e.g. "### Dunn's post-hoc test — facet ENT 059 (run 3a4d494d…) — linked to the cited chart" (owner fix at approval, FR5) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-3 Row order | Inside every group, rows run error → warning → not recorded (AC25) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-4 Scope mismatch | The snapshot keeps ENT 059 and the chart keeps all 3 facets; the warning names both sides (F3, FR22) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-5 Adjustment family | Warning: per-facet Holm with no correction across the 3 facets. Methods: "Holm over 3 comparisons within facet X" (F1, FR5, FR20) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-6 Omnibus (undeclared) | The runs cite STAT-DUNN-POSTHOC v2, which has no prerequisite, so no omnibus line appears (F2, EC16). The declared case is covered by unit test UT-GRAPH-2327. | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-7 Attribution | The interpretation was approved by its author (warning). The evidence was approved by Felipe Machado Guimaraes (from the audit log, no warning). `system` prints as "service: ingestion" (F4, FR23) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-8 Evidence self-approval | b305a9bf v1 was approved by the author of the version, which raises a warning (F4, FR23) | [b305a9bf](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/2ce28a75-3587-4eac-9ddc-d8de480e1e0a/evidences/b305a9bf-19b4-4cb7-be72-dc866562346a) |
| R2-9 Data view | Producing run: "not applicable — snapshot is a data view …", plus a "Read by" line and the data-view wording (F3, F5, EC14) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-10 Not applicable | n/a facts never appear in the verdict. Appendix A lists them in a "Not applicable" column; the seed is n/a ×3 (F5, AC24) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-11 Population per run | One line per run in facet_order, with rows, cohort and n per group (F3, F7, FR24) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-12 Plain language | Raw cohort JSON appears only in Appendix A; units read "unit — not recorded" (F7) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-13 Broken link | 949d5bcf v3 shows "Not traceable" with an error row first (AC12 amended) | [949d5bcf](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-synthetic-reproduction-axi-2064/projects/22585add-60ab-4d8e-a8ff-0f1071862553/view-analyses/086aade1-961e-48a5-a94c-a8faa06b2c3b/evidences/949d5bcf-926d-43ec-bfeb-aeae93b3faf2) |
| R2-14 Headline set | The headline is one of the four FR18 headlines | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-15 Determinism | Two downloads give the same report hash, and the recorded hash verifies (FR13, NFR2, AC30) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |
| R2-16 includeSource=false | Same verdict, with no PNG and no source file, and the "image withheld" line (FR12, AC20) | [c700a6bd](http://localhost:5173/cerainom-igg4/mag4/microbiote-igg4-final-reference-set-synthetic/projects/b7b274bc-48a3-494a-a66f-76390bb433a8/view-analyses/a55a06a9-c984-40b1-81ee-3c6cdf3b22b3/evidences/c700a6bd-e4e6-419d-b506-34190cc7fb0e) |

## Headlines across the demo evidences (sidecar)

| Evidence | Headline |
| --- | --- |
| c700a6bd v1 (faceted Dunn, published) | Traceable — with warnings |
| b305a9bf v1 (Kruskal-Wallis) | Traceable — with warnings (interpretation + evidence self-approval) |
| d37eff12 v1 (Mann-Whitney) | Traceable — with warnings (interpretation + evidence self-approval) |
| 949d5bcf v3 (no linked run) | Not traceable |
| 5891a5ac v6 (no linked run) | Not traceable |
| eb9ab5bf v1 (heatmap, no linked run) | Not traceable |
| 90efa713 v1 (20 correlation runs, e2e org) | Traceable — some facts not recorded |
