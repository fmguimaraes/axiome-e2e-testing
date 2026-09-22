/**
 * stage:riaz-publish — make the ten questions' results citable evidence and
 * publish them.
 *
 * For every traced question (docs/riaz-questions-trace.json) whose governed
 * run produced rule-derived snapshots this step, idempotently:
 *   1. records one Evidence per rule-derived result table in the run's
 *      analysis (`POST /view-analyses/evidences`, citation kind `table` —
 *      AXI-1161: the whole rule-run table is the citation, pinned to the
 *      rule-derived snapshot and its dataset);
 *   2. records one Decision per question (workspace decisions, evidenceLinks →
 *      the same snapshots — the "Decision" provenance node) authored by the
 *      presenter and approved by the service identity, as Q1 did;
 *   3. publishes the analysis once (`POST /view-analyses/publish`, the evidence
 *      versions + the decision) — a published version is never re-published.
 * The ids and deep links are written back into the trace (`published`) so
 * `stage:riaz-report` can link them.
 *
 * Flags: `--only Q4,Q6`, `--dry-run`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { asList, must } from '../rules/ensureRule';
import { ADMIN_HANDLE, SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import { recordDecision } from './stageRiazGuided';
import type { QuestionTrace } from './runRiazQuestions';

const TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || 'docs/riaz-questions-trace.json';
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');

export interface PublishedRecord {
  at: string;
  evidences: Array<{ id: string; versionId: string; title: string; snapshotId: string; ruleRunId: string; link: string }>;
  decisionId: string | null;
  decisionStatus: string | null;
  decisionLink: string | null;
  publishedVersionId: string | null;
  publishedLink: string | null;
}
type PublishedTrace = QuestionTrace & { published?: PublishedRecord };
interface Trace { projectId: string; workspaceId: string; organizationId: string | null; questions: PublishedTrace[] }
interface Snap { id: string; name: string | null; origin: string | null; ruleRunId: string | null; datasetId: string; derivedColumns?: string[] | null; sourceScope?: { filters?: Array<{ column: string; operator: string; value: unknown }> } | null }

const scopeOf = (s: Snap): string => (s.sourceScope?.filters ?? []).map((f) => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`).join(' & ') || 'whole dataset';
interface EvidenceRow { id: string; currentVersion?: { id: string; title: string | null } }

function log(msg: string): void {
  console.log(`[stage:riaz-publish] ${msg}`);
}

function summarizeRows(q: QuestionTrace, ruleRunId: string): string {
  const rr = q.ruleRuns.find((r) => r.id === ruleRunId);
  if (!rr) return '';
  const rows = rr.rows.slice(0, 8).map((r) => {
    const keys = ['feature', 'meanDifference', 'effectSize', 'pValue', 'nPairs', 'nGroupFrom', 'nGroupTo'].filter((k) => r[k] !== undefined);
    return keys.map((k) => `${k}=${typeof r[k] === 'number' ? (r[k] as number).toFixed(3) : String(r[k])}`).join(', ');
  });
  return `${rr.operationId ?? rr.kind}: ${rows.join(' | ')}${rr.rows.length > 8 ? ` … (${rr.rows.length} rows)` : ''}`;
}

async function listSnapshots(client: RestClient, H: Record<string, string>, analysisId: string): Promise<Snap[]> {
  return asList<Snap>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'));
}

async function listEvidence(client: RestClient, H: Record<string, string>, analysisId: string): Promise<EvidenceRow[]> {
  const res = must(await client.as<{ data: EvidenceRow[] }>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=50`, undefined, H), 'evidence listing');
  return res.data ?? [];
}

async function ensureOneEvidence(client: RestClient, H: Record<string, string>, t: Trace, q: QuestionTrace, s: Snap, existing: EvidenceRow[], dryRun: boolean): Promise<PublishedRecord['evidences'][number] | null> {
  const title = `${q.id} · ${s.name ?? 'result'} [${scopeOf(s)}] · run ${q.runId}`;
  const link = (id: string) => `${FRONT_URL}/projects/${t.projectId}/view-analyses/${q.viewAnalysisId}/evidences/${id}`;
  const found = existing.find((e) => e.currentVersion?.title === title);
  if (found?.currentVersion) return { id: found.id, versionId: found.currentVersion.id, title, snapshotId: s.id, ruleRunId: s.ruleRunId as string, link: link(found.id) };
  if (dryRun) { log(`would create evidence "${title}"`); return null; }
  const rr = q.ruleRuns.find((r) => r.id === s.ruleRunId);
  const body = {
    viewAnalysisId: q.viewAnalysisId,
    chartEntries: [],
    title,
    text: `${q.question}\n\nGoverned run ${q.runId} (plan ${q.planId}, ${q.planner}${q.plannerFallback ? ', fallback' : ''}). ${summarizeRows(q, s.ruleRunId as string)}`,
    citationContext: {
      kind: 'table',
      evidence_id: s.ruleRunId,
      snapshot_id: s.id,
      dataset_id: s.datasetId,
      row_count: rr?.rows.length || undefined,
      column_names: rr?.columns,
      derived_columns: s.derivedColumns ?? null,
      view_state: { filters: [] },
      captured_at: new Date().toISOString(),
      captured_by: 'stage:riaz-publish',
    },
  };
  const created = must(await client.as<EvidenceRow>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/evidences', body, H), `creating evidence "${title}"`);
  if (!created.currentVersion) throw new Error(`evidence "${title}" created without a current version`);
  log(`created evidence ${created.id} "${title}"`);
  return { id: created.id, versionId: created.currentVersion.id, title, snapshotId: s.id, ruleRunId: s.ruleRunId as string, link: link(created.id) };
}

async function ensurePublished(client: RestClient, H: Record<string, string>, analysisId: string, evidenceVersionIds: string[], decisionIds: string[], dryRun: boolean): Promise<string | null> {
  const existing = must(await client.as<{ data: Array<{ id: string }> }>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/published-versions`, undefined, H), 'published versions');
  if (existing.data?.length) return existing.data[0].id;
  if (dryRun) { log(`would publish analysis ${analysisId} with ${evidenceVersionIds.length} evidence version(s)`); return null; }
  const res = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/publish', { viewAnalysisId: analysisId, evidenceVersionIds, decisionIds }, H), 'publishing analysis');
  log(`published analysis ${analysisId} → version ${res.id}`);
  return res.id;
}

async function publishOne(client: RestClient, serviceUserId: string, t: Trace, q: PublishedTrace, dryRun: boolean): Promise<void> {
  const H = projectHeaders(t.workspaceId);
  if (!q.viewAnalysisId || !q.runId) { log(`${q.id}: no run — skipped`); return; }
  const snaps = (await listSnapshots(client, H, q.viewAnalysisId)).filter((s) => s.origin === 'rule_derived' && s.ruleRunId);
  if (!snaps.length) { log(`${q.id}: no rule-derived snapshots — skipped`); return; }
  const existing = await listEvidence(client, H, q.viewAnalysisId);
  const evidences: PublishedRecord['evidences'] = [];
  for (const s of snaps) {
    const e = await ensureOneEvidence(client, H, t, q, s, existing, dryRun);
    if (e) evidences.push(e);
  }
  const label = `${q.id} — ${q.question.slice(0, 110)}${q.question.length > 110 ? '…' : ''} (run ${q.runId})`;
  const decision = dryRun ? null : await recordDecision(client, serviceUserId, t.workspaceId, q.viewAnalysisId, label, 'medium', snaps.map((s) => s.id));
  const publishedVersionId = evidences.length ? await ensurePublished(client, H, q.viewAnalysisId, evidences.map((e) => e.versionId), decision ? [decision.id] : [], dryRun) : null;
  q.published = {
    at: new Date().toISOString(),
    evidences,
    decisionId: decision?.id ?? null,
    decisionStatus: decision?.status ?? null,
    decisionLink: decision ? `${FRONT_URL}/projects/${t.projectId}/view-analyses/${q.viewAnalysisId}/decisions/${decision.id}` : null,
    publishedVersionId,
    publishedLink: publishedVersionId ? `${FRONT_URL}/published-views/${publishedVersionId}` : null,
  };
  log(`${q.id}: ${evidences.length} evidence(s), decision ${decision?.id ?? '—'} (${decision?.status ?? '—'}), published ${publishedVersionId ?? '—'}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyArg = argv.indexOf('--only');
  const only = onlyArg >= 0 ? new Set(argv[onlyArg + 1].split(',').map((s) => s.trim())) : null;
  const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as Trace;
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const client = new RestClient({ baseUrl, onCall: () => undefined });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const serviceUserId = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me'), 'resolving service user').id;
  void ADMIN_HANDLE;
  for (const q of trace.questions) {
    if (only && !only.has(q.id)) continue;
    await publishOne(client, serviceUserId, trace, q, dryRun);
    if (!dryRun) writeFileSync(TRACE_PATH, JSON.stringify(trace, null, 2));
  }
  log(dryRun ? 'dry run — nothing written' : `trace updated: ${TRACE_PATH}`);
}

if (process.argv[1] && process.argv[1].endsWith('publishRiazEvidence.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
