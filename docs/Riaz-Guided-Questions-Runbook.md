# Riaz 2017 guided questions — programmatic runbook

How to ask a batch of scientific questions through the real guided-analysis
planner, execute them as governed runs, publish the results as evidence and
produce the verdict report — end to end from the shell, no UI. Written so
another session can repeat it in minutes. Companion docs:
`Headless-Riaz-Staging.md` (demo pack), `Riaz-Guided-Rule-Workflow.md` (Q1 and
the rule library), `Riaz-Guided-Questions.md` (Q2–Q11 and expected verdicts),
`Riaz-Guided-Questions-Report.md` (generated output).

## 0. Preconditions

| Need | How |
|---|---|
| Demo stack up | `make demo-up` in `axiome-infra` (front :5173, gateway :3000, container `axiome-demo-backend`). |
| Demo pack staged | `npm run stage:riaz` then `npm run stage:riaz-guided` (creates the workspace/project/datasets, publishes the four Q1 rules, runs Q1). |
| Rule library published | `npm run stage:rules` (24 rules, every protocol; `--check`/`--dry-run` first if unsure). |
| Identities | `admin@axiome.local`/`admin` (platform admin), presenter `cast-biologist` (Marc Ottavi) and the service identity are created by `ensureIdentities` on every step — nothing to do by hand. |
| Planner budget | The demo backend's `anthropic-planner.adapter.ts` must carry `max_tokens: 16384` (the committed 8192 makes a thinking model hit `stop_reason=max_tokens` and fall back). See §5. |

All commands run from the `axiome-e2e-testing` checkout (worktree
`_worktrees/axiome-e2e-testing-riaz-headless-staging`, branch
`riaz-headless-staging`). Env overrides: `STAGING_BASE_URL`, `STAGING_FRONT_URL`,
`STAGING_ADMIN_EMAIL/PASSWORD`, `STAGING_RIAZ_QUESTIONS_TRACE`,
`STAGING_RIAZ_QUESTIONS_REPORT`.

## 1. Ask the questions (`stage:riaz-questions`)

```bash
npm run -s stage:riaz-questions                       # every question not yet in the trace
npm run -s stage:riaz-questions -- --only Q5,Q6       # re-ask specific ones (overwrites their trace entry)
npm run -s stage:riaz-questions -- --plan-only        # plan, do not submit
```

Per question (`staging/steps/runRiazQuestions.ts`, `QUESTIONS` array):

1. Build the envelope exactly as `GuidedAnalysisPanel.send()` does: project,
   semantic contract, `/rule-runs/operations`, published rules, a 1000-row
   dataset query → `/guided-analysis/profile`, `sendData:false`.
2. `POST /guided-analysis/plan` as the presenter → `planId`, `planner`,
   `plannerFallback`.
3. `POST /governed-execution/submit` **with `organizationId`** (the UI omits it
   and org-scoped QC rules then fail to resolve).
4. Poll `GET /governed-execution/status`; approve any `AWAITING_APPROVAL`
   node via `POST /governed-execution/resolve` as the **service** identity
   (`governed_execution:approve`).
5. Collect: run status per node, the analysis's snapshots, every rule-derived
   snapshot's rule run (`GET /rule-runs/:id` + `/table`).
6. Append to `docs/riaz-questions-trace.json` (written after every question,
   so a crash loses nothing).

Runs ~2–4 min per question (planner 60–150 s, execution 20–60 s).

## 2. Publish the evidence (`stage:riaz-publish`)

```bash
npm run -s stage:riaz-publish -- --dry-run            # show what would be created
npm run -s stage:riaz-publish                          # all traced questions with a run
npm run -s stage:riaz-publish -- --only Q4
```

Per question with rule-derived snapshots (`staging/steps/publishRiazEvidence.ts`):

1. One **Evidence** per rule-derived result table:
   `POST /view-analyses/evidences` with `citationContext.kind = 'table'`
   (`evidence_id` = rule run id, `snapshot_id` = the rule-derived snapshot,
   `dataset_id` = that snapshot's `datasetId` — the server checks all three).
   Title = `Qn · <snapshot name> [<source scope>] · run GR-…`, idempotent by title.
2. One **Decision** per question (`POST /workspaces/:ws/decisions`,
   `evidenceLinks` → the same snapshots) authored by the presenter, transitioned
   `reviewed → approved` by the service identity (`recordDecision` from
   `stageRiazGuided.ts`).
3. **Publish** the analysis once: `POST /view-analyses/publish`
   `{viewAnalysisId, evidenceVersionIds, decisionIds}`; an existing published
   version is reused, never duplicated.
4. Write `published {evidences[], decisionId, publishedVersionId, links}` back
   into the trace entry.

Deep links produced: `/projects/:p/view-analyses/:a/evidences/:e`,
`/projects/:p/view-analyses/:a/decisions/:d`, `/published-views/:v`.

## 3. Build the report (`stage:riaz-report`)

```bash
npm run -s stage:riaz-report        # → docs/Riaz-Guided-Questions-Report.md
```

`staging/steps/reportRiazQuestions.ts` re-fetches each analysis's snapshots for
`effectiveFilters` (the only place the cohort a rule run was computed on is
recorded), normalises result rows into per-gene stats, evaluates the cited
INTERPRET / DECISION rules offline (`EVALUATORS`), compares with the expected
verdicts in `Riaz-Guided-Questions.md`, adds the published links and the
comparison with the paper (`PAPER`), and writes the summary + per-question
sections. Filter-snapshot row counts come from the dataset query
(`POST …/datasets/:id/query {limit:1, filters}` → `totalCount`), because the
snapshot listing has no row count and there is no snapshot detail route.

## 4. Full sequence for a new session

```bash
cd /home/felipe/dev/axiome/_worktrees/axiome-e2e-testing-riaz-headless-staging
npm run -s stage:rules -- --check                      # library still valid
npm run -s stage:riaz-questions > /tmp/questions.log 2>&1 &   # background; watch "plan PL-|trace written|ERROR"
#   re-ask whatever fell back: grep '"plannerFallback": true' docs/riaz-questions-trace.json
npm run -s stage:riaz-publish
npm run -s stage:riaz-report
```

Adding a question = one entry in `QUESTIONS` (id, dataset role, text), one
`EVALUATORS[id]` (which rule verdicts to compute and what is expected), one
`PAPER[id]` (the paper's claim and how to judge concordance), and its rules in
`riazRuleLibrary.ts` (`questions: ['Qn']`).

## 5. Gotchas (all hit while doing this)

- **Planner fallback answers a different question.** `plannerFallback: true`
  = a single `compare_paired` over the whole dataset. Cause: thinking blocks
  exhaust `max_tokens` (8192 in the committed adapter) within the 150 s
  deadline. Raise to 16384 in
  `apps/organization-service/src/guided-analysis/plan/anthropic-planner.adapter.ts`
  (demo backend bind-mounts the primary checkout). Even at 16384 a long
  multi-gene question can still fall back once; just `--only` it again.
- **`nest --watch` can orphan the old service.** After editing that file check
  `docker exec axiome-demo-backend ps -o pid,ppid,args | grep organization-service/main`;
  a `ppid 1` process is the OLD build still bound to the port. `kill` it, touch
  the file, wait for `[3] … Nest application successfully started`.
- **Say "per gene (pivot on the gene column)"** or the planner filters to one
  gene and the table has a single `__all__` row.
- **Don't let the planner pre-filter the gene column when a QC rule is cited.**
  `RIAZ-QC-PAIRED-01` needs ≥240 rows (5 patients × 24 genes × 2 timepoints);
  a 6-gene, one-stratum referent has 156 rows → `block` → downstream BLOCKED
  (Q5's first run, GR-e515ee76). Phrase the question to keep the whole panel.
- **The planner only sees the first 1000 rows.** The envelope profiles a
  `{limit: 1000}` dataset query (what the UI does). On the stratified DE table,
  sorted by stratum, those rows are all `ipi_naive`, so the planner asserted
  `ipi_progressed` "is entirely absent" and planned one branch (Q9, three
  times — stating the levels in the question does NOT help, the planner treats
  the profile's observed categories as the only legal filter values, its
  "verbatim-category constraint"). Workaround: `profileSlices` on the question
  (`[[stratum eq ipi_naive], [stratum eq ipi_progressed]]`) profiles
  `1000 / n` rows per slice. Platform gap: the profile should sample categories
  from the whole dataset.
- **Chained filters collide (lineage defect).** A filter node under another
  filter (`response eq R` under `gene eq CD274`) is materialised through
  `ViewAnalysesService.materializeSnapshot`, whose reuse lookup
  (`findSnapshotMatchingFilters`, `view-analyses.service.ts:1144`) matches on
  `viewAnalysisId` + the node's OWN conditions and ignores the parent
  (`openSnapshotId`). The second gene's `response eq R` therefore reuses the
  FIRST gene's responder snapshot; the downstream compare node then
  fingerprints identically and is `DEDUPED` onto the first gene's rule run
  (Q10 attempt 2: n13/n14 → 470d2860/94785f8b deduped from a6a75e97/d6e44c12,
  no CD274 R/NR result exists, lineage claims one). **Fixed in axiome-back
  `37f9b50` (2026-09-23):** the materialize path now reuses a candidate only
  when its chain composes to the same effective scope (UT-VA-MAT-007/008). The
  Q9/Q10 question texts still ask for ONE filter node carrying both conditions
  per cohort; that phrasing is no longer required on a backend at or after that
  commit, but it is harmless and keeps the plans flat.
- **A multi-gene referent needs `featureColumn = gene`** on `compare_paired`
  (`params.featureColumn` → `pivot.featureColumn`), else bio-compute refuses:
  "referent has N row(s) sharing a subject and level … choose a feature
  dimension column" (Q5 attempt 2, Q10 attempt 1). Per-single-gene filter
  nodes are the other valid shape (Q3, Q7).
- **Mann-Whitney rows have no medians.** Direction = sign of `effectSize`
  (pingouin rank-biserial with `groupTo` passed first: `> 0` ⇔ to > from) read
  with the plan node's `operationParams.groupFrom/groupTo`.
- **Paired rows**: `meanDifference` is On − Pre; `feature` is `__all__` when the
  referent was filtered to one gene — the gene then comes from the referent
  snapshot's `effectiveFilters`.
- **Row counts**: no snapshot detail/table route (404); use the dataset query
  with the snapshot's filters.
- **Tokens expire**: the scratchpad `admin.token` is only for ad-hoc curls; the
  scripts log in themselves.
- **Only QC rules execute.** INTERPRET / DECISION / SUMMARY / FEATURE / STRATIFY
  are authoring-only; the report evaluates them offline. Rule-derived snapshots
  show `resultBinding: no_match / no_candidate_rules` because the library rules
  declare no evidence selector (AXI-1491 binding) — a follow-up.
- **Rule thresholds are calibrated on this cohort** (see the report's
  Limitations); treat verdict matches as pipeline fidelity, not generality.
