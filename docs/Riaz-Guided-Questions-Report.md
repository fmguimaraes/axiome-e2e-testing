# Riaz 2017 — ten guided questions, run through the LLM planner (report)

Generated 2026-09-22T21:39:21.111Z from `docs/riaz-questions-trace.json` by `npm run stage:riaz-report`. Each question was asked as Marc Ottavi through the guided-analysis planner (`POST /guided-analysis/plan`, anthropic), the returned plan was submitted unchanged as a governed run (with `organizationId`, which the UI omits), the interpretation node approved as the service identity, and the cited INTERPRET / DECISION rules evaluated offline over the kernel's result tables (no executor exists for those protocols). "Expected" is the verdict computed from the source CSV in docs/Riaz-Guided-Questions.md.

| Q | Plan (planner) | Run | Run status | Rule verdicts matching expectation | Overall | vs paper | Analysis |
|---|---|---|---|---|---|---|---|
| Q2 | PL-8d71bf07 (anthropic) | GR-b3e33786 | ok (8/8 nodes) | 3/3 | ✓ | partial | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707) · [published](http://localhost:5173/published-views/33ae988d-20f6-4e8d-a41b-17f8d1e43efb) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/decisions/60e7f485-c1d1-48f7-8fb0-d0832ec42398) |
| Q3 | PL-3cf41723 (anthropic) | GR-2149c997 | ok (19/19 nodes) | 1/1 | ✓ | partial | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa) · [published](http://localhost:5173/published-views/7bee89e9-4e9c-497f-afb2-b2e86d6954e2) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/decisions/2026497c-38b6-4964-9e6d-ed55ead6cf38) |
| Q4 | PL-883b1199 (anthropic) | GR-064bab44 | ok (15/15 nodes) | 2/2 | ✓ | concordant | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137) · [published](http://localhost:5173/published-views/adc96757-2e99-4665-9180-874ac4e35f79) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/decisions/66266ddd-b12c-43e6-8397-78a71ac533db) |
| Q5 | PL-e1bbb49c (anthropic) | GR-bc664315 | ok (8/8 nodes) | 4/4 | ✓ | partial | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b) · [published](http://localhost:5173/published-views/6e8eb6cc-57b7-4ac3-8719-3917c246343b) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/decisions/582f3e6e-cfb6-48ac-aea5-393c5b45a675) |
| Q6 | PL-c823fbab (anthropic) | GR-3f668bd1 | ok (15/15 nodes) | 1/1 | ✓ | concordant | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773) · [published](http://localhost:5173/published-views/00c48b49-682e-4a32-8e59-f8c4f8b68886) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/decisions/903eeeb6-8922-4bca-842e-e64d2d39dcbc) |
| Q7 | PL-5a794c25 (anthropic) | GR-a959de8c | ok (15/15 nodes) | 2/2 | ✓ | concordant | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825) · [published](http://localhost:5173/published-views/7aefe2e5-20fe-4fdd-ae2e-c07427eb90bc) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/decisions/01328b17-f6c3-4d84-8465-e07b117bc2ec) |
| Q8 | PL-f006b7d2 (anthropic) | GR-9fc19ba4 | ok (7/7 nodes) | 2/2 | ✓ | concordant | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85) · [published](http://localhost:5173/published-views/910d5fce-29f2-407d-9cfc-4a0ce904238e) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85/decisions/cf7b307b-66cb-43e5-a811-5725b15253d0) |
| Q9 | PL-6b3bc807 (anthropic) | GR-8d722a38 | ok (6/6 nodes) | 2/2 | ✓ | partial | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02) · [published](http://localhost:5173/published-views/3dc78a41-1ea4-4438-a62e-fc5916a8e342) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02/decisions/107b999f-6541-4a49-bb2a-7b00a766ff51) |
| Q10 | PL-141536f8 (anthropic) | GR-2650873f | ok (14/14 nodes) | 3/3 | ✓ | partial | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb) · [published](http://localhost:5173/published-views/bee44ce9-02df-4165-a50b-ac8afcaf9f23) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/decisions/c96eba2b-9816-42cd-a844-9d41a9776aa6) |
| Q11 | PL-adfbfd2f (anthropic) | GR-95c2062c | ok (7/7 nodes) | 4/4 | ✓ | concordant | [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373) · [published](http://localhost:5173/published-views/1179af90-0647-4881-ae04-cc79da6d6d4b) · [decision](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/decisions/853fc590-0db7-485a-ba4d-c149185fe1fb) |

Project: http://localhost:5173/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview · Guided history (all planner sessions): http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses · Rules: http://localhost:5173/rules

## Comparison with the published paper

Riaz N. et al., *Tumor and Microenvironment Evolution during Immunotherapy with Nivolumab*, Cell 171:934–949 (2017) — https://pmc.ncbi.nlm.nih.gov/articles/PMC5685550/. The paper's RNA-seq cohort (n=45 baseline, 26 paired) and thresholds (q<0.20 DEG lists) differ from this demo's 27-patient, 24-gene log2CPM panel with Δ≥0.5 / p<0.05 rules, so "concordant" means the rule verdict points the same way as the paper's claim, not that the numbers match.

| Q | Paper claim | Our rule verdict vs paper | Note |
|---|---|---|---|
| Q2 | "Many immune checkpoint genes increased in expression, regardless of response to therapy, including PDCD1 (PD-1), CD274 (PD-L1), CTLA-4, CD80, ICOS, LAG3, and TNFRSF9." | **partial** | PDCD1 rises in the pooled cohort (paper: yes) but the rule reads non-responders as pd1_not_induced; the 24-gene panel with Δ≥0.5 log2CPM and p<0.05 is stricter than the paper's q<0.20 DEG list |
| Q3 | "Significantly more immune-related genes were selectively upregulated in responders than in non-responders" (2670 DEGs pre vs on, R vs NR, q<0.20); baseline responders carry an IFN-γ-consistent signature. | **partial** | the paper reports broad immune up-regulation in responders at q<0.20; our rule needs 5/8 genes at Δ≥0.5 on a 27-patient panel, so the direction agrees while the threshold is not met |
| Q4 | Pre-therapy R vs NR: 189 DEGs (q<0.20), "only marginally predictive of response"; "neither PDCD1 (PD-1) nor CD274 (PD-L1) were differentially expressed" at baseline. | **concordant** | baseline cytotoxic expression does not separate R from NR, matching the paper's "marginally predictive" baseline |
| Q5 | "Increased cytolytic pathway genes as measured by RNA-seq were associated with benefit to Nivo in both Ipi-P and Ipi-N cohorts (p = 0.043 and p = 0.005)"; "a pre-existing 'hot tumor' environment was observed in all Ipi-P patients with CR/PR", Ipi-N responders variable. | **partial** | the paper reports baseline cytolytic association in both strata but does not test on-treatment induction per stratum; our rule reads ipi_naive_only (ipi-progressed tumours are already "hot", leaving less room to induce) |
| Q6 | On therapy, responders up-regulate "additional checkpoint-related genes (TNFRSF4 [OX40], TIGIT, HAVCR2 [TIM-3], and C10orf54 [VISTA])"; LAG3, CTLA-4 and PDCD1 rise regardless of response. | **concordant** | checkpoint/exhaustion markers higher in responders on therapy |
| Q7 | Non-responders up-regulate fewer immune genes on therapy; the checkpoint genes that rise regardless of response (PDCD1, CTLA-4, LAG3, CD274…) are not cytotoxic effectors. | **concordant** | no cytotoxic induction in non-responders |
| Q8 | Pre-therapy R vs NR: 189 DEGs at q<0.20, enriched only for high-level T-cell activation categories, "only marginally predictive"; PDCD1 and CD274 not differentially expressed. | **concordant** | weak baseline DE signal (58 genes at padj<0.05 vs 189 at q<0.20 in the paper; 0 immune-panel genes, consistent with PDCD1/CD274 not DE) |
| Q9 | "A pre-existing immunologically active or 'hot tumor' environment was observed in all Ipi-P patients with CR/PR"; "Variable immunological activity was observed in Ipi-N patients with CR/PR". | **partial** | more baseline DE genes in ipi_progressed than ipi_naive (n_sig per stratum = 33 / 50) points the same way as the paper's "hot" Ipi-P responders, but the rule's ≥2× ratio reads it as stratum_balanced |
| Q10 | CD274 (PD-L1) increased on therapy "regardless of response"; "several HLA class II alleles were differentially regulated" between molecular responders and non-responders. | **partial** | induction in responders matches the responder-selective HLA class II regulation; the paper also reports CD274 rising in non-responders, which the 2/2 rule at Δ≥0.5 does not see |
| Q11 | "An increase in number of CD8+ T cells and NK cells … associated with response to therapy"; cytolytic pathway genes associated with benefit — a responder-restricted cytotoxic induction. | **concordant** | responder-restricted induction holds under Wilcoxon (sensitivity: robust) |

## Limitations — the rules are calibrated on this cohort

- **Circularity.** The "expected" verdicts were computed from the same CSV the rules are judged on, and the thresholds (Δ ≥ 0.5 log2CPM, p < 0.05, k-of-n gene counts, n_sig ≥ 100, stratum ratio ≥ 2) were chosen after looking at that data. A rule matching its expectation therefore shows the pipeline is faithful, not that the criterion generalises.
- **Cohort-specific thresholds.** 27 patients and a 24-gene panel give little power; the same cutoffs on a larger cohort or whole-transcriptome DE would over- or under-call (Q3 shows it: the paper reports IFN-γ genes up in responders, the 5/8 rule reads "not induced").
- **Gene sets are the paper's.** RIAZ-INT-* encode Riaz 2017 biology, not a general immunotherapy criterion.
- **What generalises** is the protocol shape: a QC min-n guard, a k-of-n programme call over a paired delta, a two-group direction test, a stratum-ratio comparison, and a decision that consumes those labels. Thresholds belong in governed parameters (AnalysisPolicy), justified from prior data or literature, and the rules should be validated on an independent anti-PD-1 cohort (e.g. Gide 2019, Hugo 2016) before being called general. The paper column above is the only judgement here that does not depend on this CSV.

## Earlier attempts (not in the summary table) and platform gaps

Every question below needed more than one ask. The table above shows the attempt that answered the question; these are the ones that did not, and why.

- **Q5 attempt 1 — QC block.** Plan PL-03caa8ce, run GR-e515ee76, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/a27966f3-ad7b-4da1-8093-7fddcda8fa86). The planner pre-filtered the six cytotoxic genes, then split by prior_ipi; RIAZ-QC-PAIRED-01 needs ≥ 240 rows (5 paired patients × 24 genes × 2 timepoints) and saw 156 / 168 → block → downstream BLOCKED.
- **Q5 attempt 2 — kernel refusal.** Plan PL-e5dcda07, run GR-77df067e, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/edbdde16-3766-4ebe-9c8f-d8b163e07250). QC passed (624 / 672 rows) but the planner bound `roleBindings.groupColumn = gene` instead of `featureColumn`; stats.paired_ttest refused the 644 rows sharing a subject and level as ambiguous (failed runs fbc700c3, 38c74941).
- **Q6 attempt 1 — planner fallback.** Plan PL-99c70f52 (fallback), run GR-596449d7, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6c397f4e-6fc6-4c42-ba90-8269947cd419). The thinking model exhausted `max_tokens` and the deterministic fallback answered a different question (one compare_paired over the whole table).
- **Q9 attempts 1–3 — one stratum only.** Plans PL-ffbcd11b (run GR-53c7caf8), PL-88b14a6b (run GR-7cf9910a, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/73ec3d1c-fc1a-40e1-a675-cb88eb864464)), PL-933984e3 (run GR-b400d237). The profile is built from the first 1000 rows; the stratified table is sorted by stratum so those rows are all ipi_naive, and the planner declined the ipi_progressed branch under its verbatim-category constraint even when the question stated both strata exist. Fixed by profiling 500 rows per stratum (runner `profileSlices`).
- **Q9 attempt 4 — lineage defect.** Plan PL-504025ee, run GR-c000126b, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/539e3405-52bf-47ef-b1bc-0e66a1c5fcc1). Both stratum branches were planned, but `padj lt 0.05` under ipi_progressed was deduplicated onto the ipi_naive padj snapshot (same defect as Q10 attempt 2 below), so the second count would have described the wrong slice.
- **Q10 attempt 1 — kernel refusal.** Plan PL-2d97aba2, run GR-6640aea4, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2d770617-4054-40ce-ad4a-69614dec1bc1). Two-gene referent without `featureColumn`.
- **Q10 attempt 2 — lineage defect.** Plan PL-630ef81b, run GR-f3aed008, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/40661f20-2d1b-497b-aed6-4f7373d6b236). The nested filters `response eq R/NR` under `gene eq CD274` were deduplicated onto the HLA-DRA responder / non-responder snapshots: `findSnapshotMatchingFilters` (view-analyses.service.ts:1144) matches a filter node on its own conditions and ignores the parent snapshot. The CD274 compare nodes then fingerprinted identically to the HLA-DRA ones and were DEDUPED (470d2860 ← a6a75e97, 94785f8b ← d6e44c12). No CD274 responder result was ever computed, while the analysis lineage says it was. This is a backend defect (snapshot reuse must include the parent, or match on effective filters), not a planner error.
- **Q11 attempt 1 — QC block.** Plan PL-58ec35f3, run GR-68e42613, [analysis](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/de3da406-be7a-4962-9a88-25eb55d2e137). Gene pre-filter before the QC node (108 rows < 240).

**Platform gaps surfaced by this batch**

1. The guided-analysis UI submits without `organizationId`, so org-scoped QC rules fail to resolve from the UI (the runner adds it).
2. Planner `max_tokens` (8192) is too small for a thinking model; the silent fallback answers a different question with no visible warning beyond `plannerFallback: true` (hot-patched to 16384 for this batch).
3. The dataset profile samples the first 1000 rows only, and the planner treats the sampled categories as the only legal filter values.
4. QC rule `RIAZ-QC-PAIRED-01` couples its row minimum to the full panel size, so any gene pre-filter blocks it; the row-minimum should be expressed per pair.
5. A multi-gene referent needs `featureColumn` on compare_paired; the planner does not add it unless told.
6. Chained filter snapshots are deduplicated without their parent (Q10 attempt 2) — a lineage-corrupting defect.
7. Only QC rules execute; INTERPRET / DECISION / SUMMARY rules are authoring-only, so the verdicts in this report were computed offline.
8. Rule-derived snapshots show `resultBinding: no_match / no_candidate_rules` because the library rules declare no evidence selector (AXI-1491 binding).

## Q2 — Is PDCD1 (PD-1) transcript induced between the pre-treatment and on-treatment biopsy under nivolumab? Report the paired Pre→On change for PDCD1 across all patients, and separately in responders (response = R) and non-responders (response = NR).

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-QC-PAIRED-01](http://localhost:5173/rules/40f34ddf-66af-4bc1-8d25-6ff6620acca7), [RIAZ-INT-PD1-01](http://localhost:5173/rules/722a6795-5c0c-41a4-9068-513c28a7d439)


**Planner** anthropic, plan `PL-8d71bf07`, session `baefe6df-e961-4c80-b45a-259c6740b27d`. Restated: _Does PDCD1 (PD-1) transcript rise from pre-treatment to on-treatment biopsy overall, and does this pattern hold separately in responders (R) and non-responders (NR)?_

> PDCD1 is measured as a single gene per patient/timepoint, so a paired (within-subject) test is the correct design; the cohort dataset already contains matched Pre/On rows keyed by patient_id, making stats.paired_ttest (bound to RIAZ-INT-PD1-01, the PDCD1-specific induction rule) the natural operation, run once on the whole cohort and once within each response stratum.

| Node | Type | Params / operation |
|---|---|---|
| qc_paired_completeness | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| filter_pdcd1 | filter | `{"column":"gene","operator":"eq","value":"PDCD1"}` |
| cmp_pdcd1_all | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"RIAZ-INT-PD1-01"}` |
| filter_responders | filter | `{"column":"response","operator":"eq","value":"R"}` |
| cmp_pdcd1_r | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"RIAZ-INT-PD1-01"}` |
| filter_nonresponders | filter | `{"column":"response","operator":"eq","value":"NR"}` |
| cmp_pdcd1_nr | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"RIAZ-INT-PD1-01"}` |

**Governed run** `GR-b3e33786` → ok; nodes: qc_paired_completeness SUCCEEDED, filter_pdcd1 SUCCEEDED, interpretation SUCCEEDED, cmp_pdcd1_all SUCCEEDED, filter_nonresponders SUCCEEDED, filter_responders SUCCEEDED, cmp_pdcd1_nr SUCCEEDED, cmp_pdcd1_r SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| all | PDCD1 | 27 | 0.54 | 0.00..1.08 | 0.048 | stats.paired_ttest |
| response=NR | PDCD1 | 18 | 0.12 | -0.40..0.64 | 0.632 | stats.paired_ttest |
| response=R | PDCD1 | 9 | 1.38 | 0.17..2.59 | 0.030 | stats.paired_ttest |

QC: QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `4450c8e0-3714-4d87-9a14-c3de6ae90093`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-PD1-01 @ all | **pd1_induced** | Δ 0.54, p 0.048, n 27 | pd1_induced | ✓ |
| RIAZ-INT-PD1-01 @ response=R | **pd1_induced** | Δ 1.38, p 0.030, n 9 | pd1_induced | ✓ |
| RIAZ-INT-PD1-01 @ response=NR | **pd1_not_induced** | Δ 0.12, p 0.632, n 18 | pd1_not_induced | ✓ |

**Paper (Riaz 2017)** "Many immune checkpoint genes increased in expression, regardless of response to therapy, including PDCD1 (PD-1), CD274 (PD-L1), CTLA-4, CD80, ICOS, LAG3, and TNFRSF9." → **partial**: PDCD1 rises in the pooled cohort (paper: yes) but the rule reads non-responders as pd1_not_induced; the 24-gene panel with Δ≥0.5 log2CPM and p<0.05 is stricter than the paper's q<0.20 DEG list

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/decisions/60e7f485-c1d1-48f7-8fb0-d0832ec42398 (approved)
- published version: http://localhost:5173/published-views/33ae988d-20f6-4e8d-a41b-17f8d1e43efb
- evidence: [Q2 · Statistical result: stats.paired_ttest [gene eq PDCD1 & response eq R] · run GR-b3e33786](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/evidences/c56b23e3-263e-442a-bcc8-7ef8f1a25bd2)
- evidence: [Q2 · Statistical result: stats.paired_ttest [gene eq PDCD1 & response eq NR] · run GR-b3e33786](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/evidences/15a52c4f-faab-4044-9575-e11246f702be)
- evidence: [Q2 · Statistical result: stats.paired_ttest [gene eq PDCD1] · run GR-b3e33786](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/evidences/2a7f1c1a-c2d4-41d6-8711-972d6709b821)
- evidence: [Q2 · QC result: RIAZ-QC-PAIRED-01 v3 [whole dataset] · run GR-b3e33786](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/evidences/e67a5225-f994-45ec-90e7-f5dea3e34d19)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/065f7db7-e372-464a-9cf2-8f27acfa3707/provenance
- rule run ca253147 table: http://localhost:3000/api/v1/rule-runs/ca253147-955e-433f-82d0-e96fa70b7848/table?page=1&limit=50
- rule run bcb89347 table: http://localhost:3000/api/v1/rule-runs/bcb89347-69a9-4f67-ac2c-c031f807b4c1/table?page=1&limit=50
- rule run bf3bb6bc table: http://localhost:3000/api/v1/rule-runs/bf3bb6bc-184f-433a-821f-b80da620ed38/table?page=1&limit=50

## Q3 — In responders only (response = R), is the IFN-γ-related programme induced on treatment? Run one paired Pre→On test per gene (pivot on the gene column) for IFNG, CXCL9, CXCL10, CXCL11, IDO1, STAT1, IRF1 and HLA-DRA.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-QC-PAIRED-01](http://localhost:5173/rules/40f34ddf-66af-4bc1-8d25-6ff6620acca7), [RIAZ-FEAT-IFNG-SCORE-01](http://localhost:5173/rules/8125b522-be10-49d7-9c9b-6f158e268041), [RIAZ-INT-IFNG-01](http://localhost:5173/rules/2695d94d-8527-4e66-9dfd-c430e5b313f4)


**Planner** anthropic, plan `PL-3cf41723`, session `59567f5f-b4f0-49b8-a503-add76f28e186`. Restated: _In the response=R subset, does each of 8 IFN-γ-programme genes (IFNG, CXCL9, CXCL10, CXCL11, IDO1, STAT1, IRF1, HLA-DRA) show a paired Pre→On increase, tested gene-by-gene via pivot on the gene column?_

> The dataset is long-format (one row per patient×timepoint×gene), so each gene must be isolated by a filter before a per-patient paired test (stats.paired_ttest) can pair Pre/On values on log2_cpm; this mirrors the k-of-8 threshold logic in RIAZ-INT-IFNG-01 without invoking that interpretation rule directly, since planning nodes may only run statistical/QC operations, not composite interpretations.

| Node | Type | Params / operation |
|---|---|---|
| f_resp | filter | `{"column":"response","operator":"eq","value":"R"}` |
| qc_cohort | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-COHORT-MINN-01"}` |
| f_ifng | filter | `{"column":"gene","operator":"eq","value":"IFNG"}` |
| f_cxcl9 | filter | `{"column":"gene","operator":"eq","value":"CXCL9"}` |
| f_cxcl10 | filter | `{"column":"gene","operator":"eq","value":"CXCL10"}` |
| f_cxcl11 | filter | `{"column":"gene","operator":"eq","value":"CXCL11"}` |
| f_ido1 | filter | `{"column":"gene","operator":"eq","value":"IDO1"}` |
| f_stat1 | filter | `{"column":"gene","operator":"eq","value":"STAT1"}` |
| f_irf1 | filter | `{"column":"gene","operator":"eq","value":"IRF1"}` |
| f_hladra | filter | `{"column":"gene","operator":"eq","value":"HLA-DRA"}` |
| t_ifng | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_cxcl9 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_cxcl10 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_cxcl11 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_ido1 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_stat1 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_irf1 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| t_hladra | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |

**Governed run** `GR-2149c997` → ok; nodes: f_cxcl11 SUCCEEDED, f_resp SUCCEEDED, f_cxcl9 SUCCEEDED, f_ido1 SUCCEEDED, f_ifng SUCCEEDED, qc_cohort SUCCEEDED, t_hladra SUCCEEDED, t_stat1 SUCCEEDED, f_cxcl10 SUCCEEDED, f_hladra SUCCEEDED, f_irf1 SUCCEEDED, f_stat1 SUCCEEDED, t_cxcl10 SUCCEEDED, t_cxcl9 SUCCEEDED, t_ido1 SUCCEEDED, t_irf1 SUCCEEDED, t_cxcl11 SUCCEEDED, t_ifng SUCCEEDED, interpretation SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| response=R | CXCL10 | 9 | 0.01 | -1.79..1.81 | 0.989 | stats.paired_ttest |
| response=R | CXCL11 | 9 | -0.44 | -2.31..1.44 | 0.605 | stats.paired_ttest |
| response=R | CXCL9 | 9 | 0.49 | -1.32..2.30 | 0.551 | stats.paired_ttest |
| response=R | HLA-DRA | 9 | 0.91 | -0.32..2.14 | 0.127 | stats.paired_ttest |
| response=R | IDO1 | 9 | -0.01 | -1.61..1.59 | 0.992 | stats.paired_ttest |
| response=R | IFNG | 9 | 0.69 | -0.49..1.88 | 0.214 | stats.paired_ttest |
| response=R | IRF1 | 9 | 0.59 | -0.27..1.44 | 0.153 | stats.paired_ttest |
| response=R | STAT1 | 9 | 0.20 | -0.96..1.36 | 0.703 | stats.paired_ttest |

QC: QC result: RIAZ-QC-COHORT-MINN-01 v3 → SUCCEEDED (rule run `e65d047c-c21d-4851-b4d1-a5be8df6d614`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-IFNG-01 @ responders | **ifng_program_not_induced** | fired 3/8 (IFNG, IRF1, HLA-DRA); p<0.05: none | ifng_program_not_induced | ✓ |

**Paper (Riaz 2017)** "Significantly more immune-related genes were selectively upregulated in responders than in non-responders" (2670 DEGs pre vs on, R vs NR, q<0.20); baseline responders carry an IFN-γ-consistent signature. → **partial**: the paper reports broad immune up-regulation in responders at q<0.20; our rule needs 5/8 genes at Δ≥0.5 on a 27-patient panel, so the direction agrees while the threshold is not met

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/decisions/2026497c-38b6-4964-9e6d-ed55ead6cf38 (approved)
- published version: http://localhost:5173/published-views/7bee89e9-4e9c-497f-afb2-b2e86d6954e2
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq STAT1] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/0050ab92-4910-4d1c-924b-365dc99c2e7a)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq IRF1] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/60c03c19-9ab7-42be-a7a1-4914020be0a4)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq IFNG] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/15c7ef29-c3ad-4f81-83d7-15a9ac85e220)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq IDO1] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/971307a9-bb4e-4942-9d72-9e5becc38ad4)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq HLA-DRA] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/d98e2eb1-f8dd-42b2-b6e7-ecae0a22261d)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq CXCL9] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/e6e08416-eb77-47db-b44c-761aebf542b3)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq CXCL11] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/0e284b8f-bd59-4640-81e5-e92bb616c8bd)
- evidence: [Q3 · Statistical result: stats.paired_ttest [response eq R & gene eq CXCL10] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/2feda1c4-2d1e-4d20-a4e1-59973fb9da50)
- evidence: [Q3 · QC result: RIAZ-QC-COHORT-MINN-01 v3 [response eq R] · run GR-2149c997](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/evidences/d94638a2-13ae-4fa8-b1d1-27ce540aeff1)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/690b60e6-3391-4ff5-8a2c-3f0dd3bc4caa/provenance
- rule run ed674c8c table: http://localhost:3000/api/v1/rule-runs/ed674c8c-c0da-4696-a757-9b97278baf5c/table?page=1&limit=50
- rule run 0f3931de table: http://localhost:3000/api/v1/rule-runs/0f3931de-d562-4915-b2ef-669b581c4d0a/table?page=1&limit=50
- rule run 36c9b6f7 table: http://localhost:3000/api/v1/rule-runs/36c9b6f7-fdf1-4947-bac7-7702f83b3ed0/table?page=1&limit=50
- rule run 04050723 table: http://localhost:3000/api/v1/rule-runs/04050723-61d3-4555-af2c-66e629e46548/table?page=1&limit=50
- rule run 01fa5937 table: http://localhost:3000/api/v1/rule-runs/01fa5937-bb69-42f2-b5f7-e23b5ca6b859/table?page=1&limit=50
- rule run b606689e table: http://localhost:3000/api/v1/rule-runs/b606689e-b0bc-4c19-96f8-404610ad8513/table?page=1&limit=50
- rule run eaeab11e table: http://localhost:3000/api/v1/rule-runs/eaeab11e-b258-4116-9caf-72428475759a/table?page=1&limit=50
- rule run ea2df446 table: http://localhost:3000/api/v1/rule-runs/ea2df446-c5c8-4ed4-a0b0-c5c842eda5ec/table?page=1&limit=50

## Q4 — Before treatment (timepoint = Pre), do responders already show higher expression of the cytotoxic genes CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3 than non-responders? Compare response = R vs NR per gene (pivot on the gene column) with a Mann-Whitney U test.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-STRAT-RESP-01](http://localhost:5173/rules/fa65522b-35b6-42f7-9392-a8b25cad4a41), [RIAZ-INT-BASELINE-01](http://localhost:5173/rules/cfe9e8bb-a49e-4f80-b1dd-d8897d388af8), [RIAZ-DEC-BASELINE-01](http://localhost:5173/rules/fe42f467-83da-4ff8-a17b-feae8302d015)


**Planner** anthropic, plan `PL-883b1199`, session `7eed8508-faa1-44bf-a754-2bf55b972763`. Restated: _At the pre-treatment (Pre) biopsy, are the six cytotoxic/effector genes (CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3) already higher in eventual responders (R) than non-responders (NR), tested gene-by-gene with Mann-Whitney U?_

> This mirrors the RIAZ-INT-BASELINE-01 baseline-predictivity contract: each gene is isolated at Pre and compared R vs NR with the exact operation the question specifies (stats.mann_whitney_u), keeping the six tests independent and comparable.

| Node | Type | Params / operation |
|---|---|---|
| filter_pre | filter | `{"column":"timepoint","operator":"eq","value":"Pre"}` |
| filter_cd8a | filter | `{"column":"gene","operator":"eq","value":"CD8A"}` |
| cmp_cd8a | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| filter_prf1 | filter | `{"column":"gene","operator":"eq","value":"PRF1"}` |
| cmp_prf1 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| filter_gzmb | filter | `{"column":"gene","operator":"eq","value":"GZMB"}` |
| cmp_gzmb | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| filter_ifng | filter | `{"column":"gene","operator":"eq","value":"IFNG"}` |
| cmp_ifng | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| filter_pdcd1 | filter | `{"column":"gene","operator":"eq","value":"PDCD1"}` |
| cmp_pdcd1 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| filter_lag3 | filter | `{"column":"gene","operator":"eq","value":"LAG3"}` |
| cmp_lag3 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| qc_sample_size | qc_check | `{"operation":"qc.rule_gate","ruleCode":"IMM-QC-01"}` |

**Governed run** `GR-064bab44` → ok; nodes: filter_pre SUCCEEDED, cmp_cd8a SUCCEEDED, cmp_gzmb SUCCEEDED, cmp_ifng SUCCEEDED, cmp_lag3 SUCCEEDED, cmp_pdcd1 SUCCEEDED, cmp_prf1 SUCCEEDED, filter_cd8a SUCCEEDED, filter_gzmb SUCCEEDED, filter_ifng SUCCEEDED, filter_lag3 SUCCEEDED, filter_pdcd1 SUCCEEDED, filter_prf1 SUCCEEDED, qc_sample_size SUCCEEDED, interpretation SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| timepoint=Pre | CD8A | — | — | — | 0.076 | stats.mann_whitney_u |
| timepoint=Pre | GZMB | — | — | — | 0.247 | stats.mann_whitney_u |
| timepoint=Pre | IFNG | — | — | — | 0.171 | stats.mann_whitney_u |
| timepoint=Pre | LAG3 | — | — | — | 0.068 | stats.mann_whitney_u |
| timepoint=Pre | PDCD1 | — | — | — | 0.068 | stats.mann_whitney_u |
| timepoint=Pre | PRF1 | — | — | — | 0.105 | stats.mann_whitney_u |

QC: QC result: IMM-QC-01 v1 → SUCCEEDED (rule run `03040d91-b71b-4d74-89d7-60f1024c5543`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-BASELINE-01 @ Pre | **baseline_not_predictive** | R>NR with p<0.05: none (groupFrom=NR; 6 gene rows) | baseline_not_predictive | ✓ |
| RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted) | **on_treatment_not_baseline** | Q1: RIAZ-INT-RESP-01 = responder_restricted | on_treatment_not_baseline | ✓ |

**Paper (Riaz 2017)** Pre-therapy R vs NR: 189 DEGs (q<0.20), "only marginally predictive of response"; "neither PDCD1 (PD-1) nor CD274 (PD-L1) were differentially expressed" at baseline. → **concordant**: baseline cytotoxic expression does not separate R from NR, matching the paper's "marginally predictive" baseline

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/decisions/66266ddd-b12c-43e6-8397-78a71ac533db (approved)
- published version: http://localhost:5173/published-views/adc96757-2e99-4665-9180-874ac4e35f79
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq PRF1] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/1f169759-12af-46f9-a102-c3e0ba65456a)
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq PDCD1] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/f2a12bf0-e8d8-49a1-bea7-c578e3534d9c)
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq LAG3] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/1a04e4d4-ecf0-48fd-ac62-8e14ae56e3e0)
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq IFNG] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/ab66185c-4fe9-4fc0-8a67-e60b009d1a7a)
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq GZMB] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/883e30d6-4787-4d54-a4fd-820eeb5838b2)
- evidence: [Q4 · Statistical result: stats.mann_whitney_u [timepoint eq Pre & gene eq CD8A] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/18f2aec9-9f3c-4deb-a212-519e75e0646b)
- evidence: [Q4 · QC result: IMM-QC-01 v1 [timepoint eq Pre] · run GR-064bab44](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/evidences/3dda5bad-0828-4a0b-8f4a-db8f29e8421f)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/3ca605ba-16b8-431c-b818-1aab43e19137/provenance
- rule run 52b8f788 table: http://localhost:3000/api/v1/rule-runs/52b8f788-ce68-4d69-8df5-e8bec56fa493/table?page=1&limit=50
- rule run 5d78c37e table: http://localhost:3000/api/v1/rule-runs/5d78c37e-1421-494b-85c6-fa184e8a2a2a/table?page=1&limit=50
- rule run 8d38f9b2 table: http://localhost:3000/api/v1/rule-runs/8d38f9b2-872d-4430-997e-603db1603d30/table?page=1&limit=50
- rule run 1cde4ac9 table: http://localhost:3000/api/v1/rule-runs/1cde4ac9-eb75-47b8-a516-65f63681d329/table?page=1&limit=50
- rule run 5a47854d table: http://localhost:3000/api/v1/rule-runs/5a47854d-76f8-42fb-a5e0-09b48f2dc9ba/table?page=1&limit=50
- rule run 1af71d6c table: http://localhost:3000/api/v1/rule-runs/1af71d6c-f6e9-4ff7-9f88-f66a2011a386/table?page=1&limit=50

## Q5 — Does the on-treatment induction of the cytotoxic panel (CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3) depend on prior ipilimumab exposure? Run the paired Pre→On test per gene (pivot on the gene column) separately in prior_ipi = ipi_naive and prior_ipi = ipi_progressed. Do not filter the gene column: keep the whole 24-gene panel in each stratum (the paired QC rule needs the full panel's rows) and on each stratum's compare_paired set featureColumn = gene (the feature dimension that separates the rows sharing a patient and timepoint) with valueColumn = log2_cpm, so the result has one row per gene.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-INT-CYTO-01](http://localhost:5173/rules/e4b34821-9770-4c45-a91f-fc65cc73be86), [RIAZ-QC-COHORT-MINN-01](http://localhost:5173/rules/a0bfaceb-0e64-46d0-b8ac-6686f9986d5f), [RIAZ-STRAT-IPI-01](http://localhost:5173/rules/897fc5f7-a0a9-4a45-9f32-1ee82db8a32b), [RIAZ-INT-IPI-01](http://localhost:5173/rules/cdacaf92-b98d-4ac5-a1cc-f9a821a8ed75), [RIAZ-DEC-IPI-01](http://localhost:5173/rules/9c41d582-9e5d-4f5c-9ef7-b4359115b1cb)


**Planner** anthropic, plan `PL-e1bbb49c`, session `5525b562-3262-4d38-a8a5-6c7c0d7aea3d`. Restated: _Does the on-treatment (Pre→On) induction of the cytotoxic panel (CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3) depend on prior ipilimumab exposure, tested per-gene with a paired test separately in the ipi_naive and ipi_progressed strata while keeping the full 24-gene panel in each stratum?_

> The dataset is already long-format per patient×timepoint×gene, so the natural design is to split on the existing prior_ipi categorical column with plain filters (no operation needed), gate each stratum with the paired-completeness QC rule that this project defines for exactly this scenario, then run the governed paired t-test per gene (pivoting on `gene`) in each stratum so the downstream RIAZ-INT-IPI-01/RIAZ-INT-CYTO-01 interpretation logic has the per-gene deltas and p-values it needs.

| Node | Type | Params / operation |
|---|---|---|
| profile_dataset | profile | `{}` |
| filter_ipi_naive | filter | `{"column":"prior_ipi","operator":"eq","value":"ipi_naive"}` |
| filter_ipi_progressed | filter | `{"column":"prior_ipi","operator":"eq","value":"ipi_progressed"}` |
| qc_paired_completeness_naive | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| qc_paired_completeness_progressed | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| compare_paired_ipi_naive | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm","featureColumn":"gene"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAI` |
| compare_paired_ipi_progressed | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm","featureColumn":"gene"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAI` |

**Governed run** `GR-bc664315` → ok; nodes: profile_dataset REUSED, compare_paired_ipi_naive SUCCEEDED, filter_ipi_naive SUCCEEDED, filter_ipi_progressed SUCCEEDED, compare_paired_ipi_progressed SUCCEEDED, qc_paired_completeness_naive SUCCEEDED, qc_paired_completeness_progressed SUCCEEDED, interpretation SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| prior_ipi=ipi_naive | CD27 | 14 | 0.34 | -0.29..0.97 | 0.268 | stats.paired_ttest |
| prior_ipi=ipi_naive | CD274 | 14 | 0.84 | 0.14..1.54 | 0.022 | stats.paired_ttest |
| prior_ipi=ipi_naive | CD3E | 14 | 0.77 | -0.15..1.68 | 0.094 | stats.paired_ttest |
| prior_ipi=ipi_naive | CD8A | 14 | 0.82 | -0.08..1.72 | 0.071 | stats.paired_ttest |
| prior_ipi=ipi_naive | CTLA4 | 14 | 0.20 | -0.40..0.79 | 0.487 | stats.paired_ttest |
| prior_ipi=ipi_naive | CXCL10 | 14 | 0.75 | -0.19..1.68 | 0.109 | stats.paired_ttest |
| prior_ipi=ipi_naive | CXCL11 | 14 | 0.28 | -0.84..1.41 | 0.597 | stats.paired_ttest |
| prior_ipi=ipi_naive | CXCL9 | 14 | 1.09 | 0.26..1.91 | 0.014 | stats.paired_ttest |
| prior_ipi=ipi_naive | GZMA | 14 | 0.98 | -0.05..2.01 | 0.061 | stats.paired_ttest |
| prior_ipi=ipi_naive | GZMB | 14 | 0.72 | -0.10..1.55 | 0.080 | stats.paired_ttest |
| prior_ipi=ipi_naive | HAVCR2 | 14 | 0.69 | -0.04..1.43 | 0.061 | stats.paired_ttest |
| prior_ipi=ipi_naive | HLA-DRA | 14 | 0.77 | 0.01..1.53 | 0.046 | stats.paired_ttest |
| prior_ipi=ipi_naive | IDO1 | 14 | 0.62 | -0.18..1.42 | 0.118 | stats.paired_ttest |
| prior_ipi=ipi_naive | IFNG | 14 | 0.59 | -0.13..1.31 | 0.102 | stats.paired_ttest |
| prior_ipi=ipi_naive | IL2RA | 14 | 0.40 | -0.24..1.05 | 0.201 | stats.paired_ttest |
| prior_ipi=ipi_naive | IRF1 | 14 | 0.62 | 0.06..1.18 | 0.034 | stats.paired_ttest |
| prior_ipi=ipi_naive | LAG3 | 14 | 0.89 | -0.01..1.80 | 0.052 | stats.paired_ttest |
| prior_ipi=ipi_naive | LCK | 14 | 0.78 | -0.13..1.69 | 0.088 | stats.paired_ttest |
| prior_ipi=ipi_naive | NKG7 | 14 | 0.81 | -0.23..1.86 | 0.117 | stats.paired_ttest |
| prior_ipi=ipi_naive | PDCD1 | 14 | 0.95 | 0.10..1.81 | 0.031 | stats.paired_ttest |
| prior_ipi=ipi_naive | PRF1 | 14 | 1.05 | 0.09..2.01 | 0.034 | stats.paired_ttest |
| prior_ipi=ipi_naive | STAT1 | 14 | 0.51 | -0.10..1.12 | 0.092 | stats.paired_ttest |
| prior_ipi=ipi_naive | TIGIT | 14 | 0.70 | -0.04..1.43 | 0.061 | stats.paired_ttest |
| prior_ipi=ipi_naive | TOX | 14 | 0.34 | -0.22..0.90 | 0.214 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CD27 | 13 | -0.23 | -0.78..0.32 | 0.383 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CD274 | 13 | 0.13 | -0.43..0.69 | 0.617 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CD3E | 13 | -0.02 | -0.86..0.83 | 0.969 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CD8A | 13 | 0.07 | -0.91..1.05 | 0.875 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CTLA4 | 13 | -0.06 | -0.67..0.55 | 0.832 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CXCL10 | 13 | -0.15 | -1.22..0.92 | 0.764 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CXCL11 | 13 | -0.36 | -1.16..0.44 | 0.344 | stats.paired_ttest |
| prior_ipi=ipi_progressed | CXCL9 | 13 | 0.33 | -0.89..1.54 | 0.568 | stats.paired_ttest |
| prior_ipi=ipi_progressed | GZMA | 13 | 0.03 | -0.91..0.98 | 0.939 | stats.paired_ttest |
| prior_ipi=ipi_progressed | GZMB | 13 | -0.13 | -1.12..0.87 | 0.782 | stats.paired_ttest |
| prior_ipi=ipi_progressed | HAVCR2 | 13 | -0.13 | -0.92..0.66 | 0.727 | stats.paired_ttest |
| prior_ipi=ipi_progressed | HLA-DRA | 13 | -0.11 | -1.17..0.94 | 0.817 | stats.paired_ttest |
| prior_ipi=ipi_progressed | IDO1 | 13 | -0.11 | -1.25..1.03 | 0.836 | stats.paired_ttest |
| prior_ipi=ipi_progressed | IFNG | 13 | 0.07 | -0.48..0.62 | 0.778 | stats.paired_ttest |
| prior_ipi=ipi_progressed | IL2RA | 13 | -0.05 | -0.80..0.70 | 0.886 | stats.paired_ttest |
| prior_ipi=ipi_progressed | IRF1 | 13 | 0.10 | -0.69..0.89 | 0.787 | stats.paired_ttest |
| prior_ipi=ipi_progressed | LAG3 | 13 | 0.21 | -0.65..1.07 | 0.601 | stats.paired_ttest |
| prior_ipi=ipi_progressed | LCK | 13 | -0.05 | -0.90..0.80 | 0.903 | stats.paired_ttest |
| prior_ipi=ipi_progressed | NKG7 | 13 | 0.01 | -1.11..1.12 | 0.990 | stats.paired_ttest |
| prior_ipi=ipi_progressed | PDCD1 | 13 | 0.10 | -0.57..0.76 | 0.758 | stats.paired_ttest |
| prior_ipi=ipi_progressed | PRF1 | 13 | 0.21 | -0.71..1.13 | 0.631 | stats.paired_ttest |
| prior_ipi=ipi_progressed | STAT1 | 13 | -0.12 | -0.74..0.49 | 0.670 | stats.paired_ttest |
| prior_ipi=ipi_progressed | TIGIT | 13 | -0.07 | -0.93..0.78 | 0.857 | stats.paired_ttest |
| prior_ipi=ipi_progressed | TOX | 13 | 0.18 | -0.50..0.86 | 0.573 | stats.paired_ttest |

QC: QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `3301b1cd-22c3-42d9-aa60-99a08e88e4e8`); QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `1497ce6a-940c-4fcc-b322-2c5df6e2a6da`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-CYTO-01 @ ipi_naive | **cytotoxic_program_induced** | fired 6/6 (CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3); p<0.05: PRF1, PDCD1 | cytotoxic_program_induced | ✓ |
| RIAZ-INT-CYTO-01 @ ipi_progressed | **cytotoxic_program_not_induced** | fired 0/6 (none) | cytotoxic_program_not_induced | ✓ |
| RIAZ-INT-IPI-01 | **ipi_naive_only** | induction fires in one stratum only | ipi_naive_only | ✓ |
| RIAZ-DEC-IPI-01 | **stratify_in_follow_up** | not ipi-independent → carry prior_ipi as a stratification factor | stratify_in_follow_up | ✓ |

**Paper (Riaz 2017)** "Increased cytolytic pathway genes as measured by RNA-seq were associated with benefit to Nivo in both Ipi-P and Ipi-N cohorts (p = 0.043 and p = 0.005)"; "a pre-existing 'hot tumor' environment was observed in all Ipi-P patients with CR/PR", Ipi-N responders variable. → **partial**: the paper reports baseline cytolytic association in both strata but does not test on-treatment induction per stratum; our rule reads ipi_naive_only (ipi-progressed tumours are already "hot", leaving less room to induce)

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/decisions/582f3e6e-cfb6-48ac-aea5-393c5b45a675 (approved)
- published version: http://localhost:5173/published-views/6e8eb6cc-57b7-4ac3-8719-3917c246343b
- evidence: [Q5 · Statistical result: stats.paired_ttest [prior_ipi eq ipi_progressed] · run GR-bc664315](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/evidences/76b1ffc8-9ba4-47fb-9468-b03395a5fba2)
- evidence: [Q5 · Statistical result: stats.paired_ttest [prior_ipi eq ipi_naive] · run GR-bc664315](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/evidences/5bf62c71-c173-4cc2-8ba2-90135deced61)
- evidence: [Q5 · QC result: RIAZ-QC-PAIRED-01 v3 [prior_ipi eq ipi_progressed] · run GR-bc664315](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/evidences/1113efcf-9f25-464a-bc64-cf24be12e25e)
- evidence: [Q5 · QC result: RIAZ-QC-PAIRED-01 v3 [prior_ipi eq ipi_naive] · run GR-bc664315](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/evidences/3bd3d9c0-437b-48a1-8e65-26d3dbf6733d)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/ead2f7dd-a55c-4ea2-8f3d-4f5696ed947b/provenance
- rule run 2ca40de9 table: http://localhost:3000/api/v1/rule-runs/2ca40de9-0513-4b2d-92e7-77e8dfee34f0/table?page=1&limit=50
- rule run b5e3d841 table: http://localhost:3000/api/v1/rule-runs/b5e3d841-946d-4bc1-b37d-4880f028ace9/table?page=1&limit=50

## Q6 — At the on-treatment biopsy (timepoint = On), are the exhaustion / checkpoint markers LAG3, HAVCR2, TIGIT, CTLA4, TOX and PDCD1 higher in responders than in non-responders? Compare response = R vs NR per gene (pivot on the gene column) with a Mann-Whitney U test.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-FEAT-EXH-SCORE-01](http://localhost:5173/rules/f0d1a05f-06e4-4606-bef4-88648e4c1fc1), [RIAZ-STRAT-RESP-01](http://localhost:5173/rules/fa65522b-35b6-42f7-9392-a8b25cad4a41), [RIAZ-INT-EXH-01](http://localhost:5173/rules/f78a6253-f78b-463c-88fe-56efb41f8518)


**Planner** anthropic, plan `PL-c823fbab`, session `080d11fc-8e0a-426e-881d-f0a61aba5ee9`. Restated: _At the On-treatment biopsy, are LAG3, HAVCR2, TIGIT, CTLA4, TOX and PDCD1 expression levels higher in responders (R) than non-responders (NR), tested per gene with Mann-Whitney U?_

> This directly operationalizes RIAZ-INT-EXH-01: filter to the On timepoint, isolate each of the six exhaustion/checkpoint genes, and run an unpaired non-parametric group comparison (stats.mann_whitney_u) of R vs NR log2 CPM for each gene, treating the six tests as one multiple-comparison family.

| Node | Type | Params / operation |
|---|---|---|
| f_on | filter | `{"column":"timepoint","operator":"eq","value":"On"}` |
| qc_n | qc_check | `{"operation":"qc.rule_gate","ruleCode":"IMM-QC-01"}` |
| f_lag3 | filter | `{"column":"gene","operator":"eq","value":"LAG3"}` |
| cmp_lag3 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| f_havcr2 | filter | `{"column":"gene","operator":"eq","value":"HAVCR2"}` |
| cmp_havcr2 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| f_tigit | filter | `{"column":"gene","operator":"eq","value":"TIGIT"}` |
| cmp_tigit | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| f_ctla4 | filter | `{"column":"gene","operator":"eq","value":"CTLA4"}` |
| cmp_ctla4 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| f_tox | filter | `{"column":"gene","operator":"eq","value":"TOX"}` |
| cmp_tox | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |
| f_pdcd1 | filter | `{"column":"gene","operator":"eq","value":"PDCD1"}` |
| cmp_pdcd1 | compare_groups | `{"operationId":"stats.mann_whitney_u","operationParams":{"groupFrom":"NR","groupTo":"R"},"pivot":{"valueColumn":"log2_cpm"},"roleBindings":{"groupColumn":"respo` |

**Governed run** `GR-3f668bd1` → ok; nodes: cmp_ctla4 SUCCEEDED, cmp_havcr2 SUCCEEDED, cmp_lag3 SUCCEEDED, cmp_pdcd1 SUCCEEDED, f_ctla4 SUCCEEDED, f_havcr2 SUCCEEDED, f_lag3 SUCCEEDED, f_pdcd1 SUCCEEDED, f_tigit SUCCEEDED, f_tox SUCCEEDED, cmp_tigit SUCCEEDED, cmp_tox SUCCEEDED, interpretation SUCCEEDED, f_on SUCCEEDED, qc_n SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| timepoint=On | CTLA4 | — | — | — | 0.157 | stats.mann_whitney_u |
| timepoint=On | HAVCR2 | — | — | — | 0.048 | stats.mann_whitney_u |
| timepoint=On | LAG3 | — | — | — | 0.025 | stats.mann_whitney_u |
| timepoint=On | PDCD1 | — | — | — | 0.002 | stats.mann_whitney_u |
| timepoint=On | TIGIT | — | — | — | 0.009 | stats.mann_whitney_u |
| timepoint=On | TOX | — | — | — | 0.004 | stats.mann_whitney_u |

QC: QC result: IMM-QC-01 v1 → SUCCEEDED (rule run `6f803155-8fab-438a-bb96-ddb24813b113`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-EXH-01 @ On | **exhaustion_higher_in_responders** | R>NR with p<0.05: LAG3, HAVCR2, TIGIT, TOX, PDCD1 (5/6; groupFrom=NR) | exhaustion_higher_in_responders | ✓ |

**Paper (Riaz 2017)** On therapy, responders up-regulate "additional checkpoint-related genes (TNFRSF4 [OX40], TIGIT, HAVCR2 [TIM-3], and C10orf54 [VISTA])"; LAG3, CTLA-4 and PDCD1 rise regardless of response. → **concordant**: checkpoint/exhaustion markers higher in responders on therapy

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/decisions/903eeeb6-8922-4bca-842e-e64d2d39dcbc (approved)
- published version: http://localhost:5173/published-views/00c48b49-682e-4a32-8e59-f8c4f8b68886
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq TOX] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/c34594a9-78f6-4622-a6be-d90217485de4)
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq TIGIT] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/c1208c18-0176-4e39-8157-810454426704)
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq PDCD1] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/70c2ee4d-bada-46ed-86d2-d32b2ad467fe)
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq LAG3] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/cb5f9149-ce77-4c43-bdce-fa90009b5f4a)
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq HAVCR2] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/df6d60c4-32bd-481c-9ba7-41ad43252b4a)
- evidence: [Q6 · Statistical result: stats.mann_whitney_u [timepoint eq On & gene eq CTLA4] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/e18e1f97-883a-4166-84cf-767dc04ba986)
- evidence: [Q6 · QC result: IMM-QC-01 v1 [timepoint eq On] · run GR-3f668bd1](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/evidences/09a67f99-0fe8-48d4-bfc8-60ea4831bf8c)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/2db31f6e-de9d-4a04-9ab1-aa3b3bedc773/provenance
- rule run ee8a8d0b table: http://localhost:3000/api/v1/rule-runs/ee8a8d0b-8c86-4e88-b87b-1da689276492/table?page=1&limit=50
- rule run 359e7ace table: http://localhost:3000/api/v1/rule-runs/359e7ace-671c-49a2-b930-2911e9b479aa/table?page=1&limit=50
- rule run c58a6b9d table: http://localhost:3000/api/v1/rule-runs/c58a6b9d-f8d5-4b25-983b-42a1d8e929d0/table?page=1&limit=50
- rule run 995dfc03 table: http://localhost:3000/api/v1/rule-runs/995dfc03-835e-41b3-bb6f-4852ae588ead/table?page=1&limit=50
- rule run 3871788f table: http://localhost:3000/api/v1/rule-runs/3871788f-9b4b-43e2-b989-0625ba46b7b3/table?page=1&limit=50
- rule run 82551b77 table: http://localhost:3000/api/v1/rule-runs/82551b77-9464-4735-86b0-19d3bb872bfc/table?page=1&limit=50

## Q7 — Restricting to non-responders only (response = NR), is there any on-treatment induction of the cytotoxic panel CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3? Run the paired Pre→On test per gene (pivot on the gene column).

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-INT-CYTO-01](http://localhost:5173/rules/e4b34821-9770-4c45-a91f-fc65cc73be86), [RIAZ-QC-COHORT-MINN-01](http://localhost:5173/rules/a0bfaceb-0e64-46d0-b8ac-6686f9986d5f), [RIAZ-STRAT-RESP-01](http://localhost:5173/rules/fa65522b-35b6-42f7-9392-a8b25cad4a41)


**Planner** anthropic, plan `PL-5a794c25`, session `da113d61-8be6-4a5e-ba8c-1eb186932957`. Restated: _In patients who did NOT respond (response = NR), test whether each of the six cytotoxic/effector genes (CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3) shows a paired increase from Pre to On treatment._

> The dataset is long-format (one row per patient×timepoint×gene), so each gene must be isolated via a filter before a per-gene paired test can be run; stats.paired_ttest (bound to rule STAT-PAIRED-TTEST) is the correct DELTA/STATISTICAL operation for a Pre vs On comparison within the same patients, matching how RIAZ-INT-CYTO-01 evaluates per-gene induction.

| Node | Type | Params / operation |
|---|---|---|
| n1 | filter | `{"column":"response","operator":"eq","value":"NR"}` |
| n2 | filter | `{"column":"gene","operator":"eq","value":"CD8A"}` |
| n3 | filter | `{"column":"gene","operator":"eq","value":"PRF1"}` |
| n4 | filter | `{"column":"gene","operator":"eq","value":"GZMB"}` |
| n5 | filter | `{"column":"gene","operator":"eq","value":"IFNG"}` |
| n6 | filter | `{"column":"gene","operator":"eq","value":"PDCD1"}` |
| n7 | filter | `{"column":"gene","operator":"eq","value":"LAG3"}` |
| n8 | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-COHORT-MINN-01"}` |
| n9 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| n10 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| n11 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| n12 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| n13 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| n14 | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |

**Governed run** `GR-a959de8c` → ok; nodes: n12 SUCCEEDED, n4 SUCCEEDED, n5 SUCCEEDED, n6 SUCCEEDED, n13 SUCCEEDED, n1 SUCCEEDED, n2 SUCCEEDED, n3 SUCCEEDED, n7 SUCCEEDED, n8 SUCCEEDED, n10 SUCCEEDED, n11 SUCCEEDED, n9 SUCCEEDED, n14 SUCCEEDED, interpretation SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| response=NR | CD8A | 18 | 0.10 | -0.64..0.84 | 0.777 | stats.paired_ttest |
| response=NR | GZMB | 18 | 0.06 | -0.59..0.71 | 0.853 | stats.paired_ttest |
| response=NR | IFNG | 18 | 0.16 | -0.24..0.57 | 0.411 | stats.paired_ttest |
| response=NR | LAG3 | 18 | 0.32 | -0.32..0.96 | 0.303 | stats.paired_ttest |
| response=NR | PDCD1 | 18 | 0.12 | -0.40..0.64 | 0.632 | stats.paired_ttest |
| response=NR | PRF1 | 18 | 0.28 | -0.43..0.98 | 0.418 | stats.paired_ttest |

QC: QC result: RIAZ-QC-COHORT-MINN-01 v3 → SUCCEEDED (rule run `a077353e-d080-417c-a7e1-feb4a5d7b1b5`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-QC-COHORT-MINN-01 / RIAZ-QC-PAIRED-01 (executed) | **SUCCEEDED (QC result: RIAZ-QC-COHORT-MINN-01 v3)** | QC rule run a077353e-d080-417c-a7e1-feb4a5d7b1b5 | pass | ✓ |
| RIAZ-INT-CYTO-01 @ non-responders | **cytotoxic_program_not_induced** | fired 0/6 (none) | cytotoxic_program_not_induced | ✓ |

**Paper (Riaz 2017)** Non-responders up-regulate fewer immune genes on therapy; the checkpoint genes that rise regardless of response (PDCD1, CTLA-4, LAG3, CD274…) are not cytotoxic effectors. → **concordant**: no cytotoxic induction in non-responders

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/decisions/01328b17-f6c3-4d84-8465-e07b117bc2ec (approved)
- published version: http://localhost:5173/published-views/7aefe2e5-20fe-4fdd-ae2e-c07427eb90bc
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq CD8A] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/b7de6f2f-4075-49c7-8c1f-c617951be238)
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq LAG3] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/5cba488e-9a97-450d-b875-f5f364c59fbc)
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq PDCD1] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/bbf50103-89b3-4ef2-95f2-be482df3cf82)
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq IFNG] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/3cb1e951-80a0-4b99-a3b8-a720a288a217)
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq GZMB] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/d7014270-c43f-4e4c-90dd-8290d1600c44)
- evidence: [Q7 · Statistical result: stats.paired_ttest [response eq NR & gene eq PRF1] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/3c55bdbb-ae89-42b6-bff7-c2faea0cfd20)
- evidence: [Q7 · QC result: RIAZ-QC-COHORT-MINN-01 v3 [response eq NR] · run GR-a959de8c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/evidences/a8321dc2-4335-4c6e-aaca-99c3d9a4e84d)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/0f8952bd-04c2-463e-8d44-5545bd293825/provenance
- rule run 99262f7e table: http://localhost:3000/api/v1/rule-runs/99262f7e-78f9-472d-b288-e0e0374fbe83/table?page=1&limit=50
- rule run f28719f0 table: http://localhost:3000/api/v1/rule-runs/f28719f0-b11a-4ca8-b317-41723b2f6eaf/table?page=1&limit=50
- rule run 3be6fe30 table: http://localhost:3000/api/v1/rule-runs/3be6fe30-e6c6-4583-aa43-ccbfbb973862/table?page=1&limit=50
- rule run dbb38e5a table: http://localhost:3000/api/v1/rule-runs/dbb38e5a-a771-4bd2-994b-88531fcfd3ec/table?page=1&limit=50
- rule run 7b668914 table: http://localhost:3000/api/v1/rule-runs/7b668914-f075-42b6-92c4-157b8c2380f9/table?page=1&limit=50
- rule run 837fafdc table: http://localhost:3000/api/v1/rule-runs/837fafdc-2e25-4184-8d9d-0b8dd6dd30a5/table?page=1&limit=50

## Q8 — In this pooled pre-treatment responder-vs-non-responder differential-expression table, how many genes pass padj < 0.05, how many of those are up in responders (log2FoldChange > 0), and are any of the 24 immune panel genes (CD27, CD274, CD3E, CD8A, CTLA4, CXCL10, CXCL11, CXCL9, GZMA, GZMB, HAVCR2, HLA-DRA, IDO1, IFNG, IL2RA, IRF1, LAG3, LCK, NKG7, PDCD1, PRF1, STAT1, TIGIT, TOX) among them?

**Dataset** riaz2017_de_pre_R_vs_NR.csv (`792a147d-726b-4dc9-822b-e5d81d7c3f1d`) · **Rules cited by the question** [RIAZ-QC-DE-01](http://localhost:5173/rules/69a9badf-4405-4aa1-a707-2691433a3c63), [RIAZ-SUM-DE-01](http://localhost:5173/rules/fc4b72d0-5531-4870-b1ac-375e991a2845), [RIAZ-INT-DE-01](http://localhost:5173/rules/8cc7b0db-2f6d-449f-bc2b-7341e30f0445)


**Planner** anthropic, plan `PL-f006b7d2`, session `e4de8376-1cc1-46a0-ac7e-4b32ec4f21d7`. Restated: _In the pooled pre-treatment R-vs-NR DE table, quantify how many genes pass padj<0.05, how many of those are up in responders (log2FC>0), and how many of the 24 immune-panel genes are among the significant set._

> This is a structural counting/filtering task over a single pre-computed DE table (no patient-level data), so it is handled with a completeness QC gate followed by filter+describe steps rather than an inferential test; RIAZ-SUM-DE-01 (a SUMMARY_RULE) has no matching operationId in availableRules.operations so it cannot be bound to a node and is replaced by equivalent filter/describe steps.

| Node | Type | Params / operation |
|---|---|---|
| n1_profile | profile | `{}` |
| n2_qc_completeness | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-DE-01"}` |
| n3_filter_sig | filter | `{"column":"padj","operator":"lt","value":0.05}` |
| n4_describe_direction | describe | `{}` |
| n5_filter_panel | filter | `{"column":"gene","operator":"in","value":["CD27","CD274","CD3E","CD8A","CTLA4","CXCL10","CXCL11","CXCL9","GZMA","GZMB","HAVCR2","HLA-DRA","IDO1","IFNG","IL2RA",` |
| n6_describe_panel | describe | `{}` |

**Governed run** `GR-9fc19ba4` → ok; nodes: interpretation SUCCEEDED, n1_profile REUSED, n2_qc_completeness SUCCEEDED, n3_filter_sig SUCCEEDED, n4_describe_direction SUCCEEDED, n5_filter_panel SUCCEEDED, n6_describe_panel SUCCEEDED

**Results (kernel tables)**

_no statistical rule runs_

QC: QC result: RIAZ-QC-DE-01 v3 → SUCCEEDED (rule run `94f7c3d8-46c7-4642-b7e5-37c61dee88f5`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-SUM-DE-01 | **n_sig = 58, panel genes = 0** | filter snapshots: [padj lt 0.05 & gene in CD27,CD274,CD3E,CD8A,CTLA4,CXCL10,CXCL11,CXCL9,GZMA,GZMB,HAVCR2,HLA-DRA,IDO1,IFNG,IL2RA,IRF1,LAG3,LCK,NKG7,PDCD1,PRF1,STAT1,TIGIT,TOX] = 0 rows; [padj lt 0.05] = 58 rows; [] = ? rows; rule-run rows: 0 | n_sig = 58, 0 panel genes | ✓ |
| RIAZ-INT-DE-01 | **baseline_signal_absent** | n_sig 58 vs threshold 100 | baseline_signal_absent | ✓ |

**Paper (Riaz 2017)** Pre-therapy R vs NR: 189 DEGs at q<0.20, enriched only for high-level T-cell activation categories, "only marginally predictive"; PDCD1 and CD274 not differentially expressed. → **concordant**: weak baseline DE signal (58 genes at padj<0.05 vs 189 at q<0.20 in the paper; 0 immune-panel genes, consistent with PDCD1/CD274 not DE)

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85/decisions/cf7b307b-66cb-43e5-a811-5725b15253d0 (approved)
- published version: http://localhost:5173/published-views/910d5fce-29f2-407d-9cfc-4a0ce904238e
- evidence: [Q8 · QC result: RIAZ-QC-DE-01 v3 [whole dataset] · run GR-9fc19ba4](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85/evidences/e60990b2-1af3-4683-9c18-88288aa6ef21)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=792a147d-726b-4dc9-822b-e5d81d7c3f1d&name=riaz2017_de_pre_R_vs_NR.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/cbd0b383-c956-4a55-873b-abdade0c0f85/provenance

## Q9 — Comparing the ipi_naive and ipi_progressed strata in this stratified pre-treatment differential-expression table, how many genes pass padj < 0.05 in each stratum, and is the responder-vs-non-responder signal concentrated in one stratum? Build two filter branches and describe each so the two significant-gene counts can be compared. Each branch must be ONE filter node carrying both conditions in a single conditions array (stratum = ipi_naive and padj < 0.05; stratum = ipi_progressed and padj < 0.05), depending directly on the QC check — do not chain a padj filter under a stratum filter. The table holds both strata (22333 rows each, 44666 in total).

**Dataset** riaz2017_stratified_de_by_prior_ipi.csv (`ebe83cbf-130c-4146-8148-ea04c152364e`) · **Rules cited by the question** [RIAZ-QC-DE-01](http://localhost:5173/rules/69a9badf-4405-4aa1-a707-2691433a3c63), [RIAZ-SUM-STRATA-01](http://localhost:5173/rules/8e969526-f36b-4986-b980-564d8245e616), [RIAZ-STRAT-IPI-01](http://localhost:5173/rules/897fc5f7-a0a9-4a45-9f32-1ee82db8a32b), [RIAZ-INT-STRATA-01](http://localhost:5173/rules/32fffc08-064a-4ba7-af1b-f05be7b0fc54), [RIAZ-DEC-IPI-01](http://localhost:5173/rules/9c41d582-9e5d-4f5c-9ef7-b4359115b1cb)


**Planner** anthropic, plan `PL-6b3bc807`, session `02cbf8e6-d094-49c1-a396-969d5ae9f318`. Restated: _For the stratified pre-treatment DE table, count genes with padj<0.05 separately in the ipi_naive and ipi_progressed strata, then compare the two counts descriptively to see if the R-vs-NR signal concentrates in one stratum._

> A QC gate first confirms the DE table is complete enough (≥10,000 rows) to make a significant-gene count meaningful, then two independent single-step filter branches (stratum + padj threshold in one conditions array) isolate each stratum's significant genes for a plain descriptive count — no operation in availableRules.operations computes a 'gene significant' flag or a cross-stratum ratio directly on this table, so no statistical/compare node is used.

| Node | Type | Params / operation |
|---|---|---|
| n1_qc_completeness | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-DE-01"}` |
| n2_filter_naive_sig | filter | `{"conditions":[{"column":"stratum","operator":"eq","value":"ipi_naive"},{"column":"padj","operator":"lt","value":0.05}]}` |
| n3_filter_progressed_sig | filter | `{"conditions":[{"column":"stratum","operator":"eq","value":"ipi_progressed"},{"column":"padj","operator":"lt","value":0.05}]}` |
| n4_describe_naive_sig | describe | `{}` |
| n5_describe_progressed_sig | describe | `{}` |

**Governed run** `GR-8d722a38` → ok; nodes: interpretation SUCCEEDED, n1_qc_completeness SUCCEEDED, n2_filter_naive_sig SUCCEEDED, n3_filter_progressed_sig SUCCEEDED, n4_describe_naive_sig SUCCEEDED, n5_describe_progressed_sig SUCCEEDED

**Results (kernel tables)**

_no statistical rule runs_

QC: QC result: RIAZ-QC-DE-01 v3 → SUCCEEDED (rule run `7590ee5b-20ea-41cc-a5b5-7281d4e7c196`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-SUM-STRATA-01 | **n_sig per stratum = 33 / 50** | filter snapshots: [stratum eq ipi_progressed & padj lt 0.05] = 50 rows; [stratum eq ipi_naive & padj lt 0.05] = 33 rows; [] = ? rows; rule-run rows: 0 | 33 (naive) / 50 (progressed) | ✓ |
| RIAZ-INT-STRATA-01 | **stratum_balanced** | count ratio 1.52 vs threshold 2 | stratum_balanced | ✓ |

**Paper (Riaz 2017)** "A pre-existing immunologically active or 'hot tumor' environment was observed in all Ipi-P patients with CR/PR"; "Variable immunological activity was observed in Ipi-N patients with CR/PR". → **partial**: more baseline DE genes in ipi_progressed than ipi_naive (n_sig per stratum = 33 / 50) points the same way as the paper's "hot" Ipi-P responders, but the rule's ≥2× ratio reads it as stratum_balanced

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02/decisions/107b999f-6541-4a49-bb2a-7b00a766ff51 (approved)
- published version: http://localhost:5173/published-views/3dc78a41-1ea4-4438-a62e-fc5916a8e342
- evidence: [Q9 · QC result: RIAZ-QC-DE-01 v3 [whole dataset] · run GR-8d722a38](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02/evidences/099519b8-c04d-47d5-8eac-14624619485f)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=ebe83cbf-130c-4146-8148-ea04c152364e&name=riaz2017_stratified_de_by_prior_ipi.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/058a096f-e015-42bc-bbc7-89df3aa12c02/provenance

## Q10 — Are HLA-DRA and CD274 (PD-L1) induced between the pre-treatment and on-treatment biopsy, and is that induction confined to responders? Run the paired Pre→On test per gene for all patients, responders (response = R) and non-responders (response = NR): one compare_paired per cohort filter. Build each cohort as ONE filter node carrying both conditions (gene = X and response = R/NR in a single conditions array) that depends directly on the QC check — do not chain a response filter under a gene filter.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-QC-PAIRED-01](http://localhost:5173/rules/40f34ddf-66af-4bc1-8d25-6ff6620acca7), [RIAZ-FEAT-APM-SCORE-01](http://localhost:5173/rules/2be053bd-5e87-4f00-b46f-cd2b166b5ac1), [RIAZ-INT-APM-01](http://localhost:5173/rules/99ab7c6b-824b-4b1d-b98e-7a70c3027c3c)


**Planner** anthropic, plan `PL-141536f8`, session `1389beb3-cd5d-4849-9b5a-dd4d49240c39`. Restated: _For HLA-DRA and CD274, is expression induced Pre→On (paired, per patient), and is that induction confined to responders (R) versus not seen in non-responders (NR)?_

> A QC gate on paired-referent completeness runs first, then six filtered cohorts (2 genes × {all, R, NR}) each feed a paired t-test on log2_cpm Pre vs On, letting induction be compared within the full cohort and within each response stratum without pooling incomparable subgroups.

| Node | Type | Params / operation |
|---|---|---|
| qc_paired_gate | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| filter_hladra_all | filter | `{"column":"gene","operator":"eq","value":"HLA-DRA"}` |
| filter_hladra_r | filter | `{"conditions":[{"column":"gene","operator":"eq","value":"HLA-DRA"},{"column":"response","operator":"eq","value":"R"}]}` |
| filter_hladra_nr | filter | `{"conditions":[{"column":"gene","operator":"eq","value":"HLA-DRA"},{"column":"response","operator":"eq","value":"NR"}]}` |
| filter_cd274_all | filter | `{"column":"gene","operator":"eq","value":"CD274"}` |
| filter_cd274_r | filter | `{"conditions":[{"column":"gene","operator":"eq","value":"CD274"},{"column":"response","operator":"eq","value":"R"}]}` |
| filter_cd274_nr | filter | `{"conditions":[{"column":"gene","operator":"eq","value":"CD274"},{"column":"response","operator":"eq","value":"NR"}]}` |
| cp_hladra_all | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| cp_hladra_r | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| cp_hladra_nr | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| cp_cd274_all | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| cp_cd274_r | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |
| cp_cd274_nr | compare_paired | `{"operationId":"stats.paired_ttest","pivot":{"valueColumn":"log2_cpm"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"STAT-PAIRED-TTEST"}` |

**Governed run** `GR-2650873f` → ok; nodes: cp_cd274_all SUCCEEDED, filter_hladra_nr SUCCEEDED, cp_cd274_r SUCCEEDED, cp_hladra_nr SUCCEEDED, filter_cd274_nr SUCCEEDED, qc_paired_gate SUCCEEDED, filter_cd274_r SUCCEEDED, filter_hladra_all SUCCEEDED, filter_hladra_r SUCCEEDED, cp_cd274_nr SUCCEEDED, filter_cd274_all SUCCEEDED, cp_hladra_all SUCCEEDED, interpretation SUCCEEDED, cp_hladra_r SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| all | CD274 | 27 | 0.50 | 0.05..0.94 | 0.029 | stats.paired_ttest |
| all | HLA-DRA | 27 | 0.34 | -0.28..0.97 | 0.266 | stats.paired_ttest |
| response=NR | CD274 | 18 | 0.45 | -0.01..0.90 | 0.053 | stats.paired_ttest |
| response=NR | HLA-DRA | 18 | 0.06 | -0.70..0.82 | 0.863 | stats.paired_ttest |
| response=R | CD274 | 9 | 0.60 | -0.57..1.77 | 0.271 | stats.paired_ttest |
| response=R | HLA-DRA | 9 | 0.91 | -0.32..2.14 | 0.127 | stats.paired_ttest |

QC: QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `4450c8e0-3714-4d87-9a14-c3de6ae90093`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-APM-01 @ all | **apm_not_induced** | fired none; p<0.05: none | apm_not_induced | ✓ |
| RIAZ-INT-APM-01 @ response=R | **apm_induced** | fired HLA-DRA, CD274; p<0.05: none | apm_induced | ✓ |
| RIAZ-INT-APM-01 @ response=NR | **apm_not_induced** | fired none; p<0.05: none | apm_not_induced | ✓ |

**Paper (Riaz 2017)** CD274 (PD-L1) increased on therapy "regardless of response"; "several HLA class II alleles were differentially regulated" between molecular responders and non-responders. → **partial**: induction in responders matches the responder-selective HLA class II regulation; the paper also reports CD274 rising in non-responders, which the 2/2 rule at Δ≥0.5 does not see

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/decisions/c96eba2b-9816-42cd-a844-9d41a9776aa6 (approved)
- published version: http://localhost:5173/published-views/bee44ce9-02df-4165-a50b-ac8afcaf9f23
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq HLA-DRA & response eq R] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/d7103a62-38a4-41c7-a605-ba7979b4a2e8)
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq HLA-DRA & response eq NR] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/68317d76-f109-4508-90e1-b1bd497c2848)
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq HLA-DRA] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/f6d20ae6-83d2-4b3c-80c8-0d21484b423c)
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq CD274 & response eq R] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/9892bc35-f098-486c-8d15-d0a80d91afe3)
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq CD274 & response eq NR] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/a8873305-6c00-4d52-b97c-074a8824f196)
- evidence: [Q10 · Statistical result: stats.paired_ttest [gene eq CD274] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/1f384e01-3f86-4fa3-9e4a-87056078d16b)
- evidence: [Q10 · QC result: RIAZ-QC-PAIRED-01 v3 [whole dataset] · run GR-2650873f](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/evidences/975f4357-ab4f-4f64-98d6-02e4be069313)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/10ee7b9b-faaa-4ff1-ad10-6775c4f613eb/provenance
- rule run a6a75e97 table: http://localhost:3000/api/v1/rule-runs/a6a75e97-cbd6-429e-ba00-0289e032fdf0/table?page=1&limit=50
- rule run d6e44c12 table: http://localhost:3000/api/v1/rule-runs/d6e44c12-1239-4376-833e-3f3b8becbbd3/table?page=1&limit=50
- rule run 49d9a8cb table: http://localhost:3000/api/v1/rule-runs/49d9a8cb-cf43-438f-84db-83b95f906a83/table?page=1&limit=50
- rule run 4e4db959 table: http://localhost:3000/api/v1/rule-runs/4e4db959-04d1-4aed-affc-688ffe116ffd/table?page=1&limit=50
- rule run cd354c54 table: http://localhost:3000/api/v1/rule-runs/cd354c54-2cfa-4587-bc94-35394aee5901/table?page=1&limit=50
- rule run fa0e4061 table: http://localhost:3000/api/v1/rule-runs/fa0e4061-6ffa-4b29-9c5a-84e4044cdd62/table?page=1&limit=50

## Q11 — Does the responder-restricted on-treatment induction of CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3 hold when the paired t-test is replaced by the Wilcoxon signed-rank test? Run the Wilcoxon signed-rank test per gene Pre→On in responders (response = R) and in non-responders (response = NR): apply the paired QC check on the unfiltered responder and non-responder referents (the QC rule needs the whole 24-gene panel's rows), and set featureColumn = gene on each test (with valueColumn = log2_cpm) so the rows sharing a patient and timepoint are separated and the result has one row per gene; do not filter the gene column.

**Dataset** riaz2017_immune_paired_log2cpm_long.csv (`7703a6b4-db1e-4780-9936-778015eebf0a`) · **Rules cited by the question** [RIAZ-QC-PAIRED-01](http://localhost:5173/rules/40f34ddf-66af-4bc1-8d25-6ff6620acca7), [RIAZ-INT-CYTO-01](http://localhost:5173/rules/e4b34821-9770-4c45-a91f-fc65cc73be86), [RIAZ-INT-RESP-01](http://localhost:5173/rules/eb4a825e-7ef0-4a1f-9c35-13dc3c0a1e71), [RIAZ-INT-SENS-01](http://localhost:5173/rules/ebbcd5b1-09cb-40e9-8246-099c07d37037)


**Planner** anthropic, plan `PL-adfbfd2f`, session `d55e8bc2-ce5e-4ee5-b4dc-9dafdc1ba4c0`. Restated: _Does the previously established responder-restricted on-treatment induction of six cytotoxic/exhaustion genes survive replacing the paired t-test with the Wilcoxon signed-rank test, computed per gene Pre→On separately in responders and non-responders?_

> Filter to each response cohort, gate each unfiltered 24-gene referent on the paired-completeness QC rule, then run stats.wilcoxon_signed_rank per gene (featureColumn=gene) Pre→On in each cohort so results can be compared against the prior paired t-test outcome that fed RIAZ-INT-SENS-01.

| Node | Type | Params / operation |
|---|---|---|
| n1_filter_responders | filter | `{"column":"response","operator":"eq","value":"R"}` |
| n2_filter_non_responders | filter | `{"column":"response","operator":"eq","value":"NR"}` |
| n3_qc_paired_responders | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| n4_qc_paired_non_responders | qc_check | `{"operation":"qc.rule_gate","ruleCode":"RIAZ-QC-PAIRED-01"}` |
| n5_compare_paired_wilcoxon_R | compare_paired | `{"operationId":"stats.wilcoxon_signed_rank","pivot":{"valueColumn":"log2_cpm","featureColumn":"gene"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"` |
| n6_compare_paired_wilcoxon_NR | compare_paired | `{"operationId":"stats.wilcoxon_signed_rank","pivot":{"valueColumn":"log2_cpm","featureColumn":"gene"},"ordering":{"levelFrom":"Pre","levelTo":"On"},"ruleCode":"` |

**Governed run** `GR-95c2062c` → ok; nodes: n3_qc_paired_responders SUCCEEDED, n1_filter_responders SUCCEEDED, n2_filter_non_responders SUCCEEDED, n4_qc_paired_non_responders SUCCEEDED, n5_compare_paired_wilcoxon_R SUCCEEDED, n6_compare_paired_wilcoxon_NR SUCCEEDED, interpretation SUCCEEDED

**Results (kernel tables)**

| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |
|---|---|---|---|---|---|---|
| response=NR | CD27 | 18 | -0.21 | — | 0.284 | stats.wilcoxon_signed_rank |
| response=NR | CD274 | 18 | 0.47 | — | 0.054 | stats.wilcoxon_signed_rank |
| response=NR | CD3E | 18 | 0.11 | — | 0.832 | stats.wilcoxon_signed_rank |
| response=NR | CD8A | 18 | -0.03 | — | 1.000 | stats.wilcoxon_signed_rank |
| response=NR | CTLA4 | 18 | 0.03 | — | 0.508 | stats.wilcoxon_signed_rank |
| response=NR | CXCL10 | 18 | 0.66 | — | 0.048 | stats.wilcoxon_signed_rank |
| response=NR | CXCL11 | 18 | 0.18 | — | 0.212 | stats.wilcoxon_signed_rank |
| response=NR | CXCL9 | 18 | 0.94 | — | 0.009 | stats.wilcoxon_signed_rank |
| response=NR | GZMA | 18 | 0.04 | — | 0.495 | stats.wilcoxon_signed_rank |
| response=NR | GZMB | 18 | 0.12 | — | 0.580 | stats.wilcoxon_signed_rank |
| response=NR | HAVCR2 | 18 | 0.02 | — | 0.580 | stats.wilcoxon_signed_rank |
| response=NR | HLA-DRA | 18 | -0.02 | — | 0.899 | stats.wilcoxon_signed_rank |
| response=NR | IDO1 | 18 | 0.42 | — | 0.099 | stats.wilcoxon_signed_rank |
| response=NR | IFNG | 18 | 0.13 | — | 0.366 | stats.wilcoxon_signed_rank |
| response=NR | IL2RA | 18 | 0.25 | — | 0.154 | stats.wilcoxon_signed_rank |
| response=NR | IRF1 | 18 | 0.26 | — | 0.154 | stats.wilcoxon_signed_rank |
| response=NR | LAG3 | 18 | 0.23 | — | 0.212 | stats.wilcoxon_signed_rank |
| response=NR | LCK | 18 | 0.14 | — | 0.551 | stats.wilcoxon_signed_rank |
| response=NR | NKG7 | 18 | -0.02 | — | 1.000 | stats.wilcoxon_signed_rank |
| response=NR | PDCD1 | 18 | 0.23 | — | 0.304 | stats.wilcoxon_signed_rank |
| response=NR | PRF1 | 18 | 0.19 | — | 0.347 | stats.wilcoxon_signed_rank |
| response=NR | STAT1 | 18 | 0.11 | — | 0.304 | stats.wilcoxon_signed_rank |
| response=NR | TIGIT | 18 | 0.16 | — | 0.640 | stats.wilcoxon_signed_rank |
| response=NR | TOX | 18 | -0.05 | — | 0.899 | stats.wilcoxon_signed_rank |
| response=R | CD27 | 9 | 0.53 | — | 0.098 | stats.wilcoxon_signed_rank |
| response=R | CD274 | 9 | 0.33 | — | 0.496 | stats.wilcoxon_signed_rank |
| response=R | CD3E | 9 | 0.38 | — | 0.129 | stats.wilcoxon_signed_rank |
| response=R | CD8A | 9 | 0.36 | — | 0.039 | stats.wilcoxon_signed_rank |
| response=R | CTLA4 | 9 | 0.29 | — | 0.910 | stats.wilcoxon_signed_rank |
| response=R | CXCL10 | 9 | -0.35 | — | 1.000 | stats.wilcoxon_signed_rank |
| response=R | CXCL11 | 9 | -0.04 | — | 0.734 | stats.wilcoxon_signed_rank |
| response=R | CXCL9 | 9 | 0.62 | — | 0.652 | stats.wilcoxon_signed_rank |
| response=R | GZMA | 9 | 0.63 | — | 0.074 | stats.wilcoxon_signed_rank |
| response=R | GZMB | 9 | 0.70 | — | 0.426 | stats.wilcoxon_signed_rank |
| response=R | HAVCR2 | 9 | 0.68 | — | 0.250 | stats.wilcoxon_signed_rank |
| response=R | HLA-DRA | 9 | 0.77 | — | 0.129 | stats.wilcoxon_signed_rank |
| response=R | IDO1 | 9 | 0.42 | — | 0.910 | stats.wilcoxon_signed_rank |
| response=R | IFNG | 9 | 0.85 | — | 0.359 | stats.wilcoxon_signed_rank |
| response=R | IL2RA | 9 | -0.33 | — | 0.910 | stats.wilcoxon_signed_rank |
| response=R | IRF1 | 9 | 0.41 | — | 0.203 | stats.wilcoxon_signed_rank |
| response=R | LAG3 | 9 | 1.21 | — | 0.129 | stats.wilcoxon_signed_rank |
| response=R | LCK | 9 | 0.46 | — | 0.164 | stats.wilcoxon_signed_rank |
| response=R | NKG7 | 9 | 0.70 | — | 0.164 | stats.wilcoxon_signed_rank |
| response=R | PDCD1 | 9 | 1.25 | — | 0.020 | stats.wilcoxon_signed_rank |
| response=R | PRF1 | 9 | 0.66 | — | 0.055 | stats.wilcoxon_signed_rank |
| response=R | STAT1 | 9 | 0.31 | — | 0.734 | stats.wilcoxon_signed_rank |
| response=R | TIGIT | 9 | 0.28 | — | 0.250 | stats.wilcoxon_signed_rank |
| response=R | TOX | 9 | 0.50 | — | 0.164 | stats.wilcoxon_signed_rank |

QC: QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `7fe0e17d-ba92-4e20-92b6-ee356622847e`); QC result: RIAZ-QC-PAIRED-01 v3 → SUCCEEDED (rule run `22f3c748-b653-4368-a32f-3c437eced9c7`)

**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**

| Rule | Verdict | Detail | Expected | Match |
|---|---|---|---|---|
| RIAZ-INT-CYTO-01 @ responders (stats.wilcoxon_signed_rank) | **cytotoxic_program_induced** | fired PRF1, GZMB, IFNG, PDCD1, LAG3; p<0.05: PDCD1; test is Wilcoxon | cytotoxic_program_induced | ✓ |
| RIAZ-INT-CYTO-01 @ non-responders | **cytotoxic_program_not_induced** | fired none | cytotoxic_program_not_induced | ✓ |
| RIAZ-INT-RESP-01 | **responder_restricted** | confidence 0.55 | responder_restricted | ✓ |
| RIAZ-INT-SENS-01 (vs Q1 paired t-test) | **robust** | Q1 t-test: responder_restricted; Wilcoxon: responder_restricted | robust | ✓ |

**Paper (Riaz 2017)** "An increase in number of CD8+ T cells and NK cells … associated with response to therapy"; cytolytic pathway genes associated with benefit — a responder-restricted cytotoxic induction. → **concordant**: responder-restricted induction holds under Wilcoxon (sensitivity: robust)

**Published evidence**

- decision: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/decisions/853fc590-0db7-485a-ba4d-c149185fe1fb (approved)
- published version: http://localhost:5173/published-views/1179af90-0647-4881-ae04-cc79da6d6d4b
- evidence: [Q11 · Statistical result: stats.wilcoxon_signed_rank [response eq NR] · run GR-95c2062c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/evidences/e3ed694d-4c80-40c3-89ae-d1ad71e07595)
- evidence: [Q11 · Statistical result: stats.wilcoxon_signed_rank [response eq R] · run GR-95c2062c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/evidences/c0d13ac5-c523-4256-8816-99b08f40d23e)
- evidence: [Q11 · QC result: RIAZ-QC-PAIRED-01 v3 [response eq NR] · run GR-95c2062c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/evidences/62824627-cf86-4708-a254-b83fcd3b2fad)
- evidence: [Q11 · QC result: RIAZ-QC-PAIRED-01 v3 [response eq R] · run GR-95c2062c](http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/evidences/031a0f6d-7560-4629-ac2c-f43cee78bf63)

**Deep links**

- guidedPage: http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=7703a6b4-db1e-4780-9936-778015eebf0a&name=riaz2017_immune_paired_log2cpm_long.csv
- guidedHistory: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/guided-analyses
- analysis: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373
- provenance: http://localhost:5173/projects/ba5d1363-a7d3-485f-8907-6e046dfce514/view-analyses/6ed7deb2-4923-47c1-a92a-2ea6ab8f7373/provenance
- rule run d6f97e00 table: http://localhost:3000/api/v1/rule-runs/d6f97e00-bdf2-4bf5-b5a7-fdcda34f389d/table?page=1&limit=50
- rule run 3fe88bdb table: http://localhost:3000/api/v1/rule-runs/3fe88bdb-b8e5-49cb-b0ca-01bd9d43567d/table?page=1&limit=50
