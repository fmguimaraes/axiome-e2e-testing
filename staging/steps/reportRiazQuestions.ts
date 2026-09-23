import { readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { asList, must } from '../rules/ensureRule';
import { rulesForQuestion } from '../rules/riazRuleLibrary';
import { assertionScore, describeAssertionTable, describeSection } from './riazDescribeReport';
import { isDescribeQuestion } from './riazDescribeExpectations';
import { EVALUATORS, fmt, fmtP, q1Context, statsOf, type Snap, type Stat, type Verdict } from './riazQuestionVerdicts';
import { ADMIN_HANDLE, SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import type { QuestionTrace } from './runRiazQuestions';
import type { PublishedRecord } from './publishRiazEvidence';

/**
 * `npm run stage:riaz-report` — turns ../axiome-docs/demo/riaz-2017/riaz-questions-trace.json (what the
 * LLM planner did and what the kernel produced for Q2..Q11) into
 * ../axiome-docs/demo/riaz-2017/Riaz-Guided-Questions-Report.md: per question the plan the planner
 * chose, the result tables, the offline verdict of every INTERPRET / DECISION
 * rule the question cites (the platform has no executor for those protocols),
 * whether that verdict matches the expectation computed from the source CSV,
 * and the deep links. Re-fetches each analysis's snapshots for their
 * `effectiveFilters`, which is how a rule run is tied back to its cohort.
 */
const TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || '../axiome-docs/demo/riaz-2017/riaz-questions-trace.json';
const REPORT_PATH = process.env.STAGING_RIAZ_QUESTIONS_REPORT?.trim() || '../axiome-docs/demo/riaz-2017/Riaz-Guided-Questions-Report.md';
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
/** The sponsor-facing page of a published version (`axiome-front` `App.tsx`: `/sponsor-review/views/:publishedVersionId/export-preview`); older trace entries stored the `/published-views/:id` link. */
const publishedRoute = (publishedVersionId: string): string => `${FRONT_URL}/sponsor-review/views/${publishedVersionId}/export-preview`;

// ── comparison with the published paper ─────────────────────────────────────
// Riaz et al., Cell 171:934–949 (2017), PMC5685550. Claims are quoted from the
// paper; a judgement compares OUR rule verdicts with the paper's direction.

const PAPER_URL = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5685550/';
type Concordance = 'concordant' | 'partial' | 'discordant' | 'not addressed' | 'not evaluable';
interface PaperEntry { claim: string; judge: (v: Verdict[]) => { concordance: Concordance; note: string } }

const verdictOf = (v: Verdict[], prefix: string): string | null => v.find((x) => x.rule.startsWith(prefix))?.verdict ?? null;
const evaluable = (x: string | null) => x !== null && x !== 'not_evaluable';

const PAPER: Record<string, PaperEntry> = {
  Q2: {
    claim: '"Many immune checkpoint genes increased in expression, regardless of response to therapy, including PDCD1 (PD-1), CD274 (PD-L1), CTLA-4, CD80, ICOS, LAG3, and TNFRSF9."',
    judge: (v) => {
      const all = verdictOf(v, 'RIAZ-INT-PD1-01 @ all'), nr = verdictOf(v, 'RIAZ-INT-PD1-01 @ response=NR');
      if (!evaluable(all)) return { concordance: 'not evaluable', note: 'no PDCD1 row' };
      if (all === 'pd1_induced' && nr === 'pd1_induced') return { concordance: 'concordant', note: 'PDCD1 rises in all patients and in non-responders, as the paper states' };
      if (all === 'pd1_induced') return { concordance: 'partial', note: `PDCD1 rises in the pooled cohort (paper: yes) but the rule reads non-responders as ${nr}; the 24-gene panel with Δ≥0.5 log2CPM and p<0.05 is stricter than the paper's q<0.20 DEG list` };
      return { concordance: 'discordant', note: `pooled verdict ${all}; the paper reports PDCD1 up on therapy` };
    },
  },
  Q3: {
    claim: '"Significantly more immune-related genes were selectively upregulated in responders than in non-responders" (2670 DEGs pre vs on, R vs NR, q<0.20); baseline responders carry an IFN-γ-consistent signature.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-IFNG-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no responder per-gene rows' };
      return x === 'ifng_program_induced'
        ? { concordance: 'concordant', note: 'IFN-γ programme induced in responders' }
        : { concordance: 'partial', note: 'the paper reports broad immune up-regulation in responders at q<0.20; our rule needs 5/8 genes at Δ≥0.5 on a 27-patient panel, so the direction agrees while the threshold is not met' };
    },
  },
  Q4: {
    claim: 'Pre-therapy R vs NR: 189 DEGs (q<0.20), "only marginally predictive of response"; "neither PDCD1 (PD-1) nor CD274 (PD-L1) were differentially expressed" at baseline.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-BASELINE-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no Pre R-vs-NR rows' };
      return x === 'baseline_not_predictive'
        ? { concordance: 'concordant', note: 'baseline cytotoxic expression does not separate R from NR, matching the paper\'s "marginally predictive" baseline' }
        : { concordance: 'discordant', note: 'rule finds a baseline separation the paper calls marginal' };
    },
  },
  Q5: {
    claim: '"Increased cytolytic pathway genes as measured by RNA-seq were associated with benefit to Nivo in both Ipi-P and Ipi-N cohorts (p = 0.043 and p = 0.005)"; "a pre-existing \'hot tumor\' environment was observed in all Ipi-P patients with CR/PR", Ipi-N responders variable.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-IPI-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no per-stratum rows' };
      if (x === 'ipi_independent') return { concordance: 'concordant', note: 'induction in both strata, as the paper finds cytolytic benefit in both' };
      return { concordance: 'partial', note: `the paper reports baseline cytolytic association in both strata but does not test on-treatment induction per stratum; our rule reads ${x} (ipi-progressed tumours are already "hot", leaving less room to induce)` };
    },
  },
  Q6: {
    claim: 'On therapy, responders up-regulate "additional checkpoint-related genes (TNFRSF4 [OX40], TIGIT, HAVCR2 [TIM-3], and C10orf54 [VISTA])"; LAG3, CTLA-4 and PDCD1 rise regardless of response.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-EXH-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no On R-vs-NR rows' };
      return x === 'exhaustion_higher_in_responders'
        ? { concordance: 'concordant', note: 'checkpoint/exhaustion markers higher in responders on therapy' }
        : { concordance: 'partial', note: 'the paper\'s responder-specific set is TIGIT/HAVCR2 (plus OX40/VISTA, not in the panel); LAG3/CTLA4/PDCD1 rise in both groups, so a 3/6 R>NR threshold can miss' };
    },
  },
  Q7: {
    claim: 'Non-responders up-regulate fewer immune genes on therapy; the checkpoint genes that rise regardless of response (PDCD1, CTLA-4, LAG3, CD274…) are not cytotoxic effectors.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-CYTO-01 @ non-responders');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no NR rows' };
      return x === 'cytotoxic_program_not_induced'
        ? { concordance: 'concordant', note: 'no cytotoxic induction in non-responders' }
        : { concordance: 'discordant', note: 'cytotoxic induction in NR would contradict the responder-selective up-regulation the paper reports' };
    },
  },
  Q8: {
    claim: 'Pre-therapy R vs NR: 189 DEGs at q<0.20, enriched only for high-level T-cell activation categories, "only marginally predictive"; PDCD1 and CD274 not differentially expressed.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-DE-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no filter-snapshot count' };
      return x === 'baseline_signal_absent'
        ? { concordance: 'concordant', note: 'weak baseline DE signal (58 genes at padj<0.05 vs 189 at q<0.20 in the paper; 0 immune-panel genes, consistent with PDCD1/CD274 not DE)' }
        : { concordance: 'partial', note: 'a baseline signal ≥100 genes exceeds the paper\'s marginal baseline picture at our stricter cutoff' };
    },
  },
  Q9: {
    claim: '"A pre-existing immunologically active or \'hot tumor\' environment was observed in all Ipi-P patients with CR/PR"; "Variable immunological activity was observed in Ipi-N patients with CR/PR".',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-STRATA-01'), s = verdictOf(v, 'RIAZ-SUM-STRATA-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no per-stratum counts' };
      return { concordance: 'partial', note: `more baseline DE genes in ipi_progressed than ipi_naive (${s}) points the same way as the paper's "hot" Ipi-P responders, but the rule's ≥2× ratio reads it as ${x}` };
    },
  },
  Q10: {
    claim: 'CD274 (PD-L1) increased on therapy "regardless of response"; "several HLA class II alleles were differentially regulated" between molecular responders and non-responders.',
    judge: (v) => {
      const r = verdictOf(v, 'RIAZ-INT-APM-01 @ response=R'), nr = verdictOf(v, 'RIAZ-INT-APM-01 @ response=NR');
      if (!evaluable(r)) return { concordance: 'not evaluable', note: 'no responder rows' };
      if (r === 'apm_induced' && nr === 'apm_induced') return { concordance: 'concordant', note: 'both genes rise in both groups (paper: CD274 regardless of response)' };
      if (r === 'apm_induced') return { concordance: 'partial', note: 'induction in responders matches the responder-selective HLA class II regulation; the paper also reports CD274 rising in non-responders, which the 2/2 rule at Δ≥0.5 does not see' };
      return { concordance: 'discordant', note: `responders read ${r}` };
    },
  },
  Q11: {
    claim: '"An increase in number of CD8+ T cells and NK cells … associated with response to therapy"; cytolytic pathway genes associated with benefit — a responder-restricted cytotoxic induction.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-RESP-01'), sens = verdictOf(v, 'RIAZ-INT-SENS-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'need R and NR Wilcoxon rows' };
      return x === 'responder_restricted'
        ? { concordance: 'concordant', note: `responder-restricted induction holds under Wilcoxon (sensitivity: ${sens})` }
        : { concordance: 'discordant', note: `Wilcoxon reads ${x}` };
    },
  },
};

function paperSection(rows: Array<{ id: string; concordance: Concordance; note: string }>): string[] {
  return [
    '## Comparison with the published paper',
    '',
    `Riaz N. et al., *Tumor and Microenvironment Evolution during Immunotherapy with Nivolumab*, Cell 171:934–949 (2017) — ${PAPER_URL}. The paper's RNA-seq cohort (n=45 baseline, 26 paired) and thresholds (q<0.20 DEG lists) differ from this demo's 27-patient, 24-gene log2CPM panel with Δ≥0.5 / p<0.05 rules, so "concordant" means the rule verdict points the same way as the paper's claim, not that the numbers match.`,
    '',
    '| Q | Paper claim | Our rule verdict vs paper | Note |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${PAPER[r.id]?.claim ?? '—'} | **${r.concordance}** | ${r.note} |`),
    '',
  ];
}

// ── report ──────────────────────────────────────────────────────────────────

function resultTable(stats: Stat[]): string {
  if (!stats.length) return '_no statistical rule runs_\n';
  const unpaired = stats.some((s) => s.from !== null);
  const head = unpaired ? '| Cohort | Gene | n | median from | median to | p | test |' : '| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |';
  const sep = unpaired ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|';
  const rows = stats
    .sort((a, b) => a.cohort.localeCompare(b.cohort) || a.gene.localeCompare(b.gene))
    .map((s) => (unpaired ? `| ${s.cohort} | ${s.gene} | ${s.n ?? '—'} | ${fmt(s.from)} | ${fmt(s.to)} | ${fmtP(s.p)} | ${s.operationId ?? ''} |` : `| ${s.cohort} | ${s.gene} | ${s.n ?? '—'} | ${fmt(s.delta)} | ${s.ciLow === null ? '—' : `${fmt(s.ciLow)}..${fmt(s.ciHigh)}`} | ${fmtP(s.p)} | ${s.operationId ?? ''} |`));
  return [head, sep, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as { projectId: string; workspaceId: string; questions: QuestionTrace[] };
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const client = new RestClient({ baseUrl, onCall: () => undefined });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const H = projectHeaders(trace.workspaceId);
  const ruleIds = new Map<string, string>();
  for (const r of asList<{ id: string; code: string; status: string }>(must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/rules?workspaceId=${trace.workspaceId}&status=published&limit=500`), 'rules'))) ruleIds.set(r.code, r.id);
  const q1 = q1Context();
  const earlier = new Map<string, Verdict[]>();
  const summary: string[] = [];
  const sections: string[] = [];
  const paperRows: Array<{ id: string; concordance: Concordance; note: string }> = [];
  for (const q of trace.questions) {
    const snaps = new Map<string, Snap>();
    if (q.viewAnalysisId) {
      for (const s of asList<Snap>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${q.viewAnalysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'))) snaps.set(s.id, s);
      // rowCount is not on the listing; a filter snapshot's size is the dataset
      // query under its effective filters (the same call the explorer makes).
      for (const s of q.snapshots) {
        if (s.origin !== 'filter') continue;
        const full = snaps.get(s.id);
        const filters = full?.effectiveFilters ?? full?.filters ?? [];
        if (!filters.length) continue;
        const t = await client.as<{ totalCount?: number }>(ADMIN_HANDLE, 'POST', `/api/v1/workspaces/${trace.workspaceId}/datasets/${q.datasetId}/query`, { limit: 1, filters }, H);
        if (t.ok && t.body?.totalCount !== undefined) s.rowCount = Number(t.body.totalCount);
        (s as { filters?: string }).filters = filters.map((f) => `${f.column} ${f.operator} ${String(f.value)}`).join(' & ');
      }
    }
    const stats = statsOf(q, snaps);
    const pub = (q as QuestionTrace & { published?: PublishedRecord }).published;
    const verdicts = q.error ? [] : (EVALUATORS[q.id] ?? (() => []))(q, stats, { q1, earlier });
    earlier.set(q.id, verdicts);
    const score = isDescribeQuestion(q.id) ? assertionScore(q) : { passed: verdicts.filter((v) => v.match === true).length, total: verdicts.filter((v) => v.match !== null).length };
    const matched = score.passed, total = score.total;
    const status = q.error ? `ERROR: ${q.error.slice(0, 80)}` : `${q.runStatus} (${q.nodes.filter((n) => n.status === 'SUCCEEDED' || n.status === 'REUSED').length}/${q.nodes.length} nodes)`;
    const overall = q.error ? '✗' : total === 0 ? '?' : matched === total ? '✓' : '✗';
    const paper = q.error ? { concordance: 'not evaluable' as Concordance, note: 'run errored' } : (PAPER[q.id]?.judge(verdicts) ?? { concordance: 'not addressed' as Concordance, note: '' });
    paperRows.push({ id: q.id, ...paper });
    const publishedLink = pub?.publishedVersionId ? publishedRoute(pub.publishedVersionId) : pub?.publishedLink ?? null;
    const links = [q.viewAnalysisId ? `[analysis](${q.deepLinks.analysis})` : null, publishedLink ? `[published](${publishedLink})` : null, pub?.decisionLink ? `[decision](${pub.decisionLink})` : null].filter(Boolean).join(' · ') || '—';
    summary.push(`| ${q.id} | ${q.planId ?? '—'} (${q.planner ?? '—'}${q.plannerFallback ? ', fallback' : ''}) | ${q.runId ?? '—'} | ${status} | ${matched}/${total} | ${overall} | ${paper.concordance} | ${links} |`);
    const ruleLinks = q.rulesCited.map((c) => (ruleIds.has(c) ? `[${c}](${FRONT_URL}/rules/${ruleIds.get(c)})` : c)).join(', ');
    const plan = q.plan as { reasoning?: { restatedQuestion?: string; whyThisApproach?: string; whatThisWillNotEstablish?: string } } | null;
    sections.push(
      [
        `## ${q.id} — ${q.question}`,
        '',
        `**Dataset** ${q.datasetName} (\`${q.datasetId}\`) · **Rules cited by the question** ${ruleLinks}`,
        '',
        q.error ? `**ERROR** ${q.error}\n` : '',
        `**Planner** ${q.planner ?? '—'}${q.plannerFallback ? ' (deterministic fallback)' : ''}, plan \`${q.planId ?? '—'}\`, session \`${q.sessionId ?? '—'}\`. ${plan?.reasoning?.restatedQuestion ? `Restated: _${plan.reasoning.restatedQuestion}_` : ''}`,
        '',
        plan?.reasoning?.whyThisApproach ? `> ${plan.reasoning.whyThisApproach}\n` : '',
        '| Node | Type | Params / operation |', '|---|---|---|',
        ...q.planNodes.map((n) => `| ${n.id} | ${n.nodeType} | \`${JSON.stringify(n.operation ?? n.params ?? {}).slice(0, 160)}\` |`),
        '',
        `**Governed run** \`${q.runId ?? '—'}\` → ${q.runStatus ?? '—'}; nodes: ${q.nodes.map((n) => `${n.nodeId} ${n.status}${n.error ? ` (${n.error})` : ''}`).join(', ') || '—'}`,
        '',
        '**Results (kernel tables)**', '',
        resultTable(stats),
        q.ruleRuns.some((r) => r.kind === 'QC') ? `QC: ${q.ruleRuns.filter((r) => r.kind === 'QC').map((r) => `${r.snapshotName ?? ''} → ${r.status} (rule run \`${r.id}\`)`).join('; ')}\n` : 'QC: _no qc_check node in the plan_\n',
        '**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**', '',
        '| Rule | Verdict | Detail | Expected | Match |', '|---|---|---|---|---|',
        ...verdicts.map((v) => `| ${v.rule} | **${v.verdict}** | ${v.detail} | ${v.expected} | ${v.match === null ? '?' : v.match ? '✓' : '✗'} |`),
        '',
        ...describeAssertionTable(q),
        `**Paper (Riaz 2017)** ${PAPER[q.id]?.claim ?? '—'} → **${paper.concordance}**${paper.note ? `: ${paper.note}` : ''}`,
        '',
        '**Published evidence**', '',
        ...(pub
          ? [
              `- decision: ${pub.decisionLink ?? '—'} (${pub.decisionStatus ?? '—'})${pub.decisionLabel ? ` — ${pub.decisionLabel}` : ''}`,
              `- published version: ${publishedLink ?? '—'}${pub.previewApi ? ` (preview API: ${pub.previewApi})` : ''}`,
              ...pub.evidences.map((e) => `- evidence: [${e.title}](${e.link})${e.charts?.length ? ` — charts: ${e.charts.map((c) => c.title).join('; ')}` : ''}`),
            ]
          : ['- _not published (run stage:riaz-publish)_']),
        '',
        '**Deep links**', '',
        ...Object.entries(q.deepLinks).map(([k, v]) => `- ${k}: ${v}`),
        ...q.ruleRuns.filter((r) => r.kind !== 'QC').map((r) => `- rule run ${r.id.slice(0, 8)} table: ${baseUrl}/api/v1/rule-runs/${r.id}/table?page=1&limit=50`),
        '',
      ].join('\n'),
    );
  }
  const md = [
    '# Riaz 2017 — ten guided questions, run through the LLM planner (report)',
    '',
    `Generated ${new Date().toISOString()} from \`${TRACE_PATH}\` by \`npm run stage:riaz-report\`. Each question was asked as Marc Ottavi through the guided-analysis planner (\`POST /guided-analysis/plan\`, anthropic), the returned plan was submitted unchanged as a governed run (with \`organizationId\`, which the UI omits), the interpretation node approved as the service identity, and the cited INTERPRET / DECISION rules evaluated offline over the kernel's result tables (no executor exists for those protocols). "Expected" is the verdict computed from the source CSV in ../axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md.`,
    '',
    '| Q | Plan (planner) | Run | Run status | Rule verdicts matching expectation | Overall | vs paper | Analysis |',
    '|---|---|---|---|---|---|---|---|',
    ...summary,
    '',
    `Project: ${FRONT_URL}/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview · Guided history (all planner sessions): ${FRONT_URL}/projects/${trace.projectId}/guided-analyses · Rules: ${FRONT_URL}/rules`,
    '',
    ...describeSection(trace.questions),
    ...paperSection(paperRows),
    '## Limitations — the rules are calibrated on this cohort',
    '',
    '- **Circularity.** The "expected" verdicts were computed from the same CSV the rules are judged on, and the thresholds (Δ ≥ 0.5 log2CPM, p < 0.05, k-of-n gene counts, n_sig ≥ 100, stratum ratio ≥ 2) were chosen after looking at that data. A rule matching its expectation therefore shows the pipeline is faithful, not that the criterion generalises.',
    '- **Cohort-specific thresholds.** 27 patients and a 24-gene panel give little power; the same cutoffs on a larger cohort or whole-transcriptome DE would over- or under-call (Q3 shows it: the paper reports IFN-γ genes up in responders, the 5/8 rule reads "not induced").',
    '- **Gene sets are the paper\'s.** RIAZ-INT-* encode Riaz 2017 biology, not a general immunotherapy criterion.',
    '- **What generalises** is the protocol shape: a QC min-n guard, a k-of-n programme call over a paired delta, a two-group direction test, a stratum-ratio comparison, and a decision that consumes those labels. Thresholds belong in governed parameters (AnalysisPolicy), justified from prior data or literature, and the rules should be validated on an independent anti-PD-1 cohort (e.g. Gide 2019, Hugo 2016) before being called general. The paper column above is the only judgement here that does not depend on this CSV.',
    '',
    ...attemptsAndGapsSection(trace.projectId),
    ...sections,
  ].join('\n');
  writeFileSync(REPORT_PATH, md);
  console.log(`report written to ${REPORT_PATH}`);
  console.log(summary.join('\n'));
}

// The trace keeps only the LATEST attempt per question; the earlier attempts
// (what the planner did wrong, or what the platform did wrong) are recorded here
// by hand so the report tells the whole story, not just the run that worked.
function attemptsAndGapsSection(projectId: string): string[] {
  const va = (id: string) => `${FRONT_URL}/projects/${projectId}/view-analyses/${id}`;
  return [
    '## Earlier attempts (not in the summary table) and platform gaps',
    '',
    'Every question below needed more than one ask. The table above shows the attempt that answered the question; these are the ones that did not, and why.',
    '',
    `- **Q5 attempt 1 — QC block.** Plan PL-03caa8ce, run GR-e515ee76, [analysis](${va('a27966f3-ad7b-4da1-8093-7fddcda8fa86')}). The planner pre-filtered the six cytotoxic genes, then split by prior_ipi; RIAZ-QC-PAIRED-01 needs ≥ 240 rows (5 paired patients × 24 genes × 2 timepoints) and saw 156 / 168 → block → downstream BLOCKED.`,
    `- **Q5 attempt 2 — kernel refusal.** Plan PL-e5dcda07, run GR-77df067e, [analysis](${va('edbdde16-3766-4ebe-9c8f-d8b163e07250')}). QC passed (624 / 672 rows) but the planner bound \`roleBindings.groupColumn = gene\` instead of \`featureColumn\`; stats.paired_ttest refused the 644 rows sharing a subject and level as ambiguous (failed runs fbc700c3, 38c74941).`,
    `- **Q6 attempt 1 — planner fallback.** Plan PL-99c70f52 (fallback), run GR-596449d7, [analysis](${va('6c397f4e-6fc6-4c42-ba90-8269947cd419')}). The thinking model exhausted \`max_tokens\` and the deterministic fallback answered a different question (one compare_paired over the whole table).`,
    `- **Q9 attempts 1–3 — one stratum only.** Plans PL-ffbcd11b (run GR-53c7caf8), PL-88b14a6b (run GR-7cf9910a, [analysis](${va('73ec3d1c-fc1a-40e1-a675-cb88eb864464')})), PL-933984e3 (run GR-b400d237). The profile is built from the first 1000 rows; the stratified table is sorted by stratum so those rows are all ipi_naive, and the planner declined the ipi_progressed branch under its verbatim-category constraint even when the question stated both strata exist. Fixed by profiling 500 rows per stratum (runner \`profileSlices\`).`,
    `- **Q9 attempt 4 — lineage defect.** Plan PL-504025ee, run GR-c000126b, [analysis](${va('539e3405-52bf-47ef-b1bc-0e66a1c5fcc1')}). Both stratum branches were planned, but \`padj lt 0.05\` under ipi_progressed was deduplicated onto the ipi_naive padj snapshot (same defect as Q10 attempt 2 below), so the second count would have described the wrong slice.`,
    `- **Q10 attempt 1 — kernel refusal.** Plan PL-2d97aba2, run GR-6640aea4, [analysis](${va('2d770617-4054-40ce-ad4a-69614dec1bc1')}). Two-gene referent without \`featureColumn\`.`,
    `- **Q10 attempt 2 — lineage defect.** Plan PL-630ef81b, run GR-f3aed008, [analysis](${va('40661f20-2d1b-497b-aed6-4f7373d6b236')}). The nested filters \`response eq R/NR\` under \`gene eq CD274\` were deduplicated onto the HLA-DRA responder / non-responder snapshots: \`findSnapshotMatchingFilters\` (view-analyses.service.ts:1144) matches a filter node on its own conditions and ignores the parent snapshot. The CD274 compare nodes then fingerprinted identically to the HLA-DRA ones and were DEDUPED (470d2860 ← a6a75e97, 94785f8b ← d6e44c12). No CD274 responder result was ever computed, while the analysis lineage says it was. This is a backend defect (snapshot reuse must include the parent, or match on effective filters), not a planner error.`,
    `- **Q11 attempt 1 — QC block.** Plan PL-58ec35f3, run GR-68e42613, [analysis](${va('de3da406-be7a-4962-9a88-25eb55d2e137')}). Gene pre-filter before the QC node (108 rows < 240).`,
    '',
    '**Platform gaps surfaced by this batch**',
    '',
    '1. The guided-analysis UI submits without `organizationId`, so org-scoped QC rules fail to resolve from the UI (the runner adds it).',
    '2. Planner `max_tokens` (8192) is too small for a thinking model; the silent fallback answers a different question with no visible warning beyond `plannerFallback: true` (hot-patched to 16384 for this batch).',
    '3. The dataset profile samples the first 1000 rows only, and the planner treats the sampled categories as the only legal filter values.',
    '4. QC rule `RIAZ-QC-PAIRED-01` couples its row minimum to the full panel size, so any gene pre-filter blocks it; the row-minimum should be expressed per pair.',
    '5. A multi-gene referent needs `featureColumn` on compare_paired; the planner does not add it unless told.',
    '6. Chained filter snapshots are deduplicated without their parent (Q10 attempt 2) — a lineage-corrupting defect.',
    '7. Only QC rules execute; INTERPRET / DECISION / SUMMARY rules are authoring-only, so the verdicts in this report were computed offline.',
    '8. Rule-derived snapshots show `resultBinding: no_match / no_candidate_rules` because the library rules declare no evidence selector (AXI-1491 binding).',
    '',
  ];
}

if (process.argv[1] && process.argv[1].endsWith('reportRiazQuestions.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
