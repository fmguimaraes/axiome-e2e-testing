# Riaz 2017 — ten more guided questions, with their rule library

Ten follow-up questions to ask through the real guided-analysis UI (LLM
planner) on the staged Riaz project, after the first one
([Riaz-Guided-Rule-Workflow.md](Riaz-Guided-Rule-Workflow.md), Q1) succeeded
end-to-end on 2026-09-22 (planner plan `PL-dc8414d3`, governed run
`GR-7f7f965b`, analysis `0dc1183c-452f-4e0f-b65b-3511336a7f14`).

Every rule the questions cite is in one library, published by one command:

```bash
cd axiome-global/axiome-e2e-testing
npm run stage:rules                 # all 24 rules, every protocol, idempotent
npm run stage:rules -- --list       # what is in the library (no HTTP)
npm run stage:rules -- --check      # offline protocol validation only
npm run stage:rules -- --question Q4
npm run stage:rules -- --codes RIAZ-INT-PD1-01,RIAZ-QC-DE-01
npm run stage:rules -- --protocol FEATURE_RULE --dry-run
```

| File | Role |
|---|---|
| [`staging/rules/protocolBuilders.ts`](../staging/rules/protocolBuilders.ts) | `qcRule` / `featureRule` / `summaryRule` / `stratifyRule` / `interpretRule` / `decisionRule` builders — fill the registry's required `outputFields`, guard and signal-prefix contract; `checkProtocol()` mirrors the publish validator offline |
| [`staging/rules/ensureRule.ts`](../staging/rules/ensureRule.ts) | find-or-create → author → publish for one code; reused by `stage:riaz-guided` |
| [`staging/rules/riazRuleLibrary.ts`](../staging/rules/riazRuleLibrary.ts) | the 24 rules + which question cites which |
| [`staging/steps/ensureRules.ts`](../staging/steps/ensureRules.ts) | the `stage:rules` CLI |

Published on the demo stack 2026-09-22 (all `v3`, scope `workspace` stamped
with organization `cea57e48-…`): 4 reused from Q1, 20 created. Rules page:
`http://localhost:5173/rules` (search `RIAZ-`).

## What executes and what does not

Only **QC rules execute** on the platform today: a plan's `qc_check` node cites
one by `params.ruleCode`, the kernel runs it, and its verdict gates downstream
nodes. FEATURE / SUMMARY / STRATIFY / INTERPRET / DECISION rules are
**authoring-only** (AXI-1491 dependency R1): the planner sees them in its
catalogue and reasons about them in prose, the DecisionDraft cites them, and a
human (or `stage:riaz-guided`'s offline evaluator) applies their predicates to
the result tables. The "expected verdict" column below is that offline reading,
computed from the source CSV with the same thresholds the rules declare.

## How to ask a question

1. Log in as Marc Ottavi (`staging-cast-biologist@axiome.local`).
2. Open the guided page **with `workspaceId`** — without it the page falls back
   to the spike sample dataset and the planner sees no data:

   ```
   http://localhost:5173/guided-analysis?projectId=ba5d1363-a7d3-485f-8907-6e046dfce514&workspaceId=81bc7740-7dd0-45d6-9b8e-b7fdef861078&datasetId=<DATASET>&name=<NAME>
   ```
   Add `&scope=project` to offer every linked dataset instead of one.
3. Paste the question, Send. The planner needs 1–2 attempts (~30–90 s); the
   first often hits `max_tokens` and is repaired.
4. Review the plan, then **Run**. If the run's QC node fails with "cited rule
   not resolvable", it is the UI gap below — resubmit the same plan with
   `organizationId` via curl (snippet at the end) or ask as the platform admin.
5. Approve the interpretation node as the service identity if the run pauses
   at `AWAITING_APPROVAL` (`governed_execution:approve` is not on the
   presenter's role).

Datasets (project `ba5d1363-…`, workspace `81bc7740-…`):

| Handle | datasetId | Columns |
|---|---|---|
| **PAIRED** `riaz2017_immune_paired_log2cpm_long.csv` | `7703a6b4-db1e-4780-9936-778015eebf0a` | patient_id, timepoint (Pre/On), response (R/NR), prior_ipi (ipi_naive/ipi_progressed), gene (24), log2_cpm — 27 patients |
| **DE** `riaz2017_de_pre_R_vs_NR.csv` | `792a147d-726b-4dc9-822b-e5d81d7c3f1d` | gene, baseMean, log2FoldChange, lfcSE, pvalue, padj — 22,333 genes |
| **DE-STRATA** `riaz2017_stratified_de_by_prior_ipi.csv` | `ebe83cbf-130c-4146-8148-ea04c152364e` | same + stratum (ipi_naive / ipi_progressed) — 44,666 rows |
| WIDE `riaz2017_expression_by_response_timepoint.csv` | `e814f75c-fb52-4d42-97d6-81cda5c6ab7f` | gene, patient_id, response, pre_expression, on_expression |
| SUBJECT `riaz2017_subject_paired_timepoints.csv` | `5cc64377-1459-4bde-a7e2-65af8c29ef49` | subjectId, gene, T1, T2 |

Cohort facts the expectations rely on: 9 R / 18 NR; 14 ipi-naive / 13
ipi-progressed; induction threshold 0.5 log2 CPM paired mean Pre→On; p < 0.05.

## The questions

### Q2 — Is PD-1 itself induced?

> Is PDCD1 (PD-1) transcript induced between the pre-treatment and on-treatment biopsy under nivolumab, across all patients and separately in responders and non-responders?

- Dataset: PAIRED. Rules: `RIAZ-QC-PAIRED-01` (qc_check), `RIAZ-INT-PD1-01`.
- Expected plan: `qc_check` → `compare_paired` (paired t-test, Pre→On) on all
  patients, plus two `filter response eq R|NR` → `compare_paired`.
- Expected verdict: all patients Δ +0.54, p 0.048 → **pd1_induced**;
  responders Δ +1.38, p 0.030 → pd1_induced; non-responders Δ +0.12 →
  pd1_not_induced.
- Talking point: the drug's own target rises on treatment — a T-cell
  infiltration read-out, not receptor occupancy.

### Q3 — Is the IFN-γ programme induced in responders?

> In responders, is the IFN-γ-related programme (IFNG, CXCL9, CXCL10, CXCL11, IDO1, STAT1, IRF1, HLA-DRA) induced on treatment?

- Dataset: PAIRED. Rules: `RIAZ-QC-PAIRED-01`, `RIAZ-FEAT-IFNG-SCORE-01`
  (feature the planner can describe), `RIAZ-INT-IFNG-01` (5-of-8).
- Expected plan: `qc_check` → `filter response eq R` → `compare_paired`.
- Expected verdict: only IFNG (+0.69), IRF1 (+0.59), HLA-DRA (+0.91) cross the
  threshold → 3/8 → **ifng_program_not_induced** in responders. The chemokine
  axis moves in non-responders instead (CXCL9 +0.84, p 0.022).
- Talking point: a hand-picked "cytotoxic" panel fires (Q1) while the broader
  IFN-γ programme does not — the rule makes that distinction explicit.

### Q4 — Does baseline already separate responders?

> Before treatment, do responders already show higher cytotoxic gene expression (CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3) than non-responders?

- Dataset: PAIRED. Rules: `RIAZ-STRAT-RESP-01` (grouping), `RIAZ-INT-BASELINE-01`
  (3-of-6, Mann-Whitney at Pre), `RIAZ-DEC-BASELINE-01`.
- Expected plan: `filter timepoint eq Pre` → `compare_groups`
  (`stats.mann_whitney_u`, group column `response`).
- Expected verdict: no gene reaches p < 0.05 at Pre (closest CD8A 0.076,
  PDCD1 / LAG3 0.068) → **baseline_not_predictive**; with Q1's
  responder_restricted, `RIAZ-DEC-BASELINE-01` → **on_treatment_not_baseline**.
- Talking point: the paper's central claim, reproduced as a rule verdict.

### Q5 — Does prior ipilimumab change the induction?

> Does the on-treatment cytotoxic induction depend on prior ipilimumab exposure — does it fire in both ipilimumab-naive and ipilimumab-progressed patients?

- Dataset: PAIRED. Rules: `RIAZ-QC-COHORT-MINN-01` (qc_check, ≥ 8 patients per
  stratum), `RIAZ-STRAT-IPI-01`, `RIAZ-INT-CYTO-01`, `RIAZ-INT-IPI-01`,
  `RIAZ-DEC-IPI-01`.
- Expected plan: two `filter prior_ipi eq …` → `qc_check` → `compare_paired`.
- Expected verdict: ipi-naive fires 6/6 (PRF1 +1.05 p 0.034, PDCD1 +0.95
  p 0.031 …); ipi-progressed fires 0/6 → **ipi_naive_only** →
  `RIAZ-DEC-IPI-01` = **stratify_in_follow_up**.
- Talking point: the induction is carried by the ipi-naive cohort; the
  decision rule turns that into a follow-up design constraint.

### Q6 — Exhaustion markers on treatment, R vs NR

> At the on-treatment biopsy, are exhaustion / checkpoint markers (LAG3, HAVCR2, TIGIT, CTLA4, TOX, PDCD1) higher in responders than in non-responders?

- Dataset: PAIRED. Rules: `RIAZ-STRAT-RESP-01`, `RIAZ-FEAT-EXH-SCORE-01`,
  `RIAZ-INT-EXH-01` (3-of-6, Mann-Whitney at On).
- Expected plan: `filter timepoint eq On` → `compare_groups` (Mann-Whitney).
- Expected verdict: 5/6 significant (PDCD1 0.002, TOX 0.004, TIGIT 0.009,
  LAG3 0.025, HAVCR2 0.048; CTLA4 0.157) → **exhaustion_higher_in_responders**.
- Talking point: "exhausted" transcripts mark the hot, responding tumour.

### Q7 — Negative control: non-responders alone

> Restricting to non-responders only, is there any on-treatment induction of the cytotoxic panel?

- Dataset: PAIRED. Rules: `RIAZ-QC-COHORT-MINN-01` (18 patients → pass),
  `RIAZ-STRAT-RESP-01`, `RIAZ-INT-CYTO-01`.
- Expected plan: `filter response eq NR` → `qc_check` → `compare_paired`.
- Expected verdict: 0/6 genes cross 0.5 (max LAG3 +0.32) →
  **cytotoxic_program_not_induced**.
- Talking point: the same rule that fired on responders stays silent here.

### Q8 — How much pre-treatment DE signal is there?

> In the pooled pre-treatment responder-vs-non-responder differential-expression table, how many genes pass padj < 0.05, and are any of the 24 immune panel genes among them?

- Dataset: DE. Rules: `RIAZ-QC-DE-01` (qc_check, ≥ 10,000 rows),
  `RIAZ-SUM-DE-01`, `RIAZ-INT-DE-01`.
- Expected plan: `qc_check` → `filter padj lt 0.05` → `describe`.
- Expected verdict: 58 genes (25 up in R), **0 panel genes** →
  **baseline_signal_absent**.
- Talking point: the volcano from Beat 1 has almost nothing below the line;
  the summary rule says so in numbers.

### Q9 — Is the baseline DE stratum-dependent?

> Comparing the ipilimumab-naive and ipilimumab-progressed strata, is the pre-treatment responder-vs-non-responder differential expression concentrated in one stratum?

- Dataset: DE-STRATA. Rules: `RIAZ-QC-DE-01`, `RIAZ-STRAT-IPI-01`,
  `RIAZ-SUM-STRATA-01`, `RIAZ-INT-STRATA-01`, `RIAZ-DEC-IPI-01`.
- Expected plan: `qc_check` → two `filter stratum eq …` → `filter padj lt 0.05`
  → `describe`.
- Expected verdict: 33 (naive) vs 50 (progressed) significant genes, ratio 1.5
  → **stratum_balanced**; `RIAZ-DEC-IPI-01` still says stratify_in_follow_up
  because of Q5.
- Talking point: two rules feeding one decision from two datasets.

### Q10 — Antigen presentation / PD-L1 induction

> Are HLA-DRA and CD274 (PD-L1) induced on treatment, and is that induction confined to responders?

- Dataset: PAIRED. Rules: `RIAZ-QC-PAIRED-01`, `RIAZ-FEAT-APM-SCORE-01`,
  `RIAZ-INT-APM-01` (2-of-2).
- Expected plan: as Q1 (all / R / NR `compare_paired`).
- Expected verdict: responders HLA-DRA +0.91, CD274 +0.60 → **apm_induced**;
  non-responders HLA-DRA +0.06, CD274 +0.45 → not induced (CD274 alone trends,
  p 0.053).
- Talking point: PD-L1 transcript rises in both cohorts; MHC-II only in
  responders — the 2-of-2 rule separates them.

### Q11 — Sensitivity: Wilcoxon instead of the paired t-test

> Does the responder-restricted induction from Q1 hold when the paired t-test is replaced by the Wilcoxon signed-rank test?

- Dataset: PAIRED. Rules: `RIAZ-QC-PAIRED-01`, `RIAZ-INT-CYTO-01`,
  `RIAZ-INT-RESP-01`, `RIAZ-INT-SENS-01`.
- Expected plan: Q1's tree with `stats.wilcoxon_signed_rank` on the three
  `compare_paired` nodes (say so in the question if the planner keeps the
  t-test).
- Expected verdict: fired genes are threshold-based, so identical (6/6 R,
  0/6 NR); significant genes in responders go from 1 (PDCD1) to 2 (PDCD1,
  CD8A 0.039); `RIAZ-INT-RESP-01` stays responder_restricted at 0.55 under
  both → **robust**.
- Talking point: robustness as a rule verdict, not a footnote.

Q1 (for reference): cytotoxic induction, responder-restricted —
`RIAZ-QC-PAIRED-01`, `RIAZ-INT-CYTO-01`, `RIAZ-INT-RESP-01`, `RIAZ-DEC-01`;
responders 6/6 fired, non-responders 0/6 → consistent_with_riaz_2017.

## Adding a rule of any protocol

```ts
import { qcRule, featureRule, summaryRule, stratifyRule, interpretRule, decisionRule } from '../rules/protocolBuilders';

const myQc = () => qcRule({
  code: 'MY-QC-01', title: '…', question: '…', category: 'qc_guard',
  signals: ['meta:sample_size'],                       // QC accepts meta: marker: score: rule_score:
  logicSummary: '…', risksNotes: '…',
  evaluations: [{ attributeKey: 'sample_size', operator: '>=', value: 100 }],
  guardOutput: { confidenceCap: 0.5, requireHumanReview: true },   // required for QC
});
```

Then add `entry('QC_RULE', myQc, ['Q12'])` to `RIAZ_RULE_LIBRARY` and run
`npm run stage:rules -- --check` before publishing. The builders emit the
required output fields per protocol (QC `include_mask`/`qc_fail_reasons`;
FEATURE `feature_name`/`value`; SUMMARY `group_id`/`n_total`/`n_included`/
`aggregation_level`/`aggregation_functions`; STRATIFY `stratify_mode`/
`group_id`/`n_included`; INTERPRET `output_type`/`confidence`/`evidence_refs`/
`scoring_schema`; DECISION `decision_type`/`verdict`/`confidence`/
`evidence_refs`/`disclaimer_flags`). Signal prefixes per protocol are in
`PROTOCOL_CONTRACT`; SUMMARY must cite a `feature:`/`qc_mask` input, INTERPRET
a `summary_metric:`/`feature:`/`rule_score:` input. A published rule is never
re-versioned by the script — change the code (`-02`) to change the logic.

## Known gaps (observed 2026-09-22)

- **UI Run omits `organizationId`** (`GuidedAnalysisPanel.tsx` submit →
  `POST /governed-execution/submit`), and the message controller uses
  `data.organizationId` only, so an org-scoped QC rule is "not resolvable" from
  the UI while the identical plan succeeds via curl. One-line backend fix:
  `organizationId: data.organizationId ?? data.caller.organizationId`.
- **`workspaceId` must be in the guided URL**; the project page's link omits
  it and the planner then gets `datasets: []`.
- **Direct governed runs are not on `/projects/:id/guided-analyses`** (that
  page lists planner sessions); `stage:riaz-guided`'s run is reached through
  the analysis link only.
- Resubmit snippet (same plan, with organizationId), as the platform admin:

  ```bash
  TOKEN=$(curl -s localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
    -d '{"email":"admin@axiome.local","password":"admin"}' | jq -r .accessToken)
  curl -s localhost:3000/api/v1/governed-execution/submit -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -H 'X-Workspace-Id: 81bc7740-7dd0-45d6-9b8e-b7fdef861078' \
    -d @submit-body.json   # {projectId, planId, plan, datasetId, workspaceId, organizationId}
  ```
