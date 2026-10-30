import { okBody, type ApiClient } from './api-client';
import { sha256Hex, type ProbeFilter } from './paul-reference';
import type { ResolvedFixture } from './fixtures';

/**
 * AXI-2319 — the test workspace's WORKBENCH the pass-rule runs execute in: one
 * project linking both fixtures, one SAP (AXI-2310 refuses an unbound run), and
 * one analysis + referent snapshot per (fixture, filters) scope.
 *
 * IDEMPOTENT BY NAME, on purpose. The daily run reuses yesterday's objects
 * instead of minting a new project every day (the prod test workspace would
 * grow without bound), and — load-bearing — a re-submitted run DEDUPs onto the
 * run of the same fingerprint, whose result snapshot lives in the analysis of
 * the day it first ran; reusing the analysis keeps that snapshot findable.
 * Every listing is paged to the end and every match is re-checked client-side
 * (a listing filter is not proof the filter was applied — memory:
 * reference_view_analyses_ignores_filters).
 */

export const WORKBENCH_PROJECT_NAME = 'E2E AXI-2319 prod pass rule';
export const WORKBENCH_SAP_TITLE = 'E2E AXI-2319 prod pass rule SAP';
const MAX_PAGES = 50;

export interface Scope {
  analysisId: string;
  snapshotId: string;
  datasetId: string;
  filters: ProbeFilter[];
}

export interface Workbench {
  projectId: string;
  sapVersionId: string;
  scope(fixtureKey: string, filters: ProbeFilter[]): Promise<Scope>;
}

const list = (body: any): any[] => (Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []);

async function pageAll(client: ApiClient, pathFor: (page: number) => string, what: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = okBody(await client.get(pathFor(page)), what);
    const data = list(body);
    rows.push(...data);
    if (!body?.meta?.hasNextPage || data.length === 0) return rows;
  }
  throw new Error(`${what}: listing did not terminate in ${MAX_PAGES} pages`);
}

const oldestFirst = (a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));

/** Filters in a canonical, key-order-independent form (filter ORDER is significant). */
export function canonicalFilters(filters: unknown): string {
  const arr = Array.isArray(filters) ? filters : [];
  return JSON.stringify(arr.map((f: any) => ({ column: f?.column, operator: f?.operator, value: f?.value })));
}

export function scopeName(fixtureKey: string, filters: ProbeFilter[]): string {
  return `E2E AXI-2319 ${fixtureKey} ${sha256Hex(canonicalFilters(filters)).slice(0, 12)}`;
}

async function ensureProject(client: ApiClient, workspaceId: string): Promise<string> {
  const q = encodeURIComponent(WORKBENCH_PROJECT_NAME);
  const rows = await pageAll(client, (p) => `/api/v1/projects?workspaceId=${workspaceId}&search=${q}&page=${p}&limit=100`, 'list projects');
  const hit = rows.filter((r) => r?.name === WORKBENCH_PROJECT_NAME && r?.workspaceId === workspaceId && !r?.deletedAt).sort(oldestFirst)[0];
  if (hit) return String(hit.id);
  const created = okBody(await client.post('/api/v1/projects', {
    name: WORKBENCH_PROJECT_NAME, workspaceId,
    description: 'AXI-2319 prod E2E pass rule — runs of every active system rule on the prod-suite fixtures',
  }), 'create project');
  return String(created.id);
}

async function ensureLinks(client: ApiClient, projectId: string, fixtures: ResolvedFixture[]): Promise<void> {
  const linked = new Set(list(okBody(await client.get(`/api/v1/projects/${projectId}/datasets`), 'list project datasets')).map((l: any) => l?.datasetId));
  for (const f of fixtures) {
    if (!linked.has(f.datasetId)) okBody(await client.post(`/api/v1/projects/${projectId}/datasets`, { datasetId: f.datasetId }), `link ${f.key}`);
  }
}

async function ensureSap(client: ApiClient, projectId: string, operationIds: string[]): Promise<string> {
  const rows = await pageAll(client, (p) => `/api/v1/projects/${projectId}/saps?page=${p}&limit=100`, 'list SAPs');
  const hit = rows.filter((r) => r?.title === WORKBENCH_SAP_TITLE && r?.projectId === projectId && typeof r?.sapVersionId === 'string').sort(oldestFirst)[0];
  if (hit) return hit.sapVersionId;
  const created = okBody(await client.post(`/api/v1/projects/${projectId}/saps`, {
    title: WORKBENCH_SAP_TITLE,
    questionText: 'Does every active system rule run on the prod-suite fixtures, with Paul\'s methods reproducing their expected values?',
    planText: 'FR31 pass rule (AXI-2319): Paul\'s methods against the Microbiote reproduction targets and R; every other active rule run SUCCEEDED with its default chart rendered.',
    linkedMethods: operationIds.map((operationId) => ({ operationId })),
  }), 'create SAP');
  if (typeof created?.sapVersionId !== 'string') throw new Error('create SAP: reply carries no sapVersionId');
  return created.sapVersionId;
}

async function ensureAnalysis(client: ApiClient, projectId: string, datasetId: string, name: string): Promise<string> {
  const q = encodeURIComponent(name);
  const rows = await pageAll(client, (p) => `/api/v1/view-analyses?projectId=${projectId}&search=${q}&page=${p}&limit=100`, 'list analyses');
  const hit = rows.filter((r) => r?.name === name && r?.projectId === projectId && r?.datasetId === datasetId).sort(oldestFirst)[0];
  if (hit) return String(hit.id);
  const created = okBody(await client.post('/api/v1/view-analyses', { projectId, datasetId, name }), 'create analysis');
  return String(created.id);
}

async function ensureSnapshot(client: ApiClient, analysisId: string, filters: ProbeFilter[]): Promise<string> {
  const want = canonicalFilters(filters);
  const rows = await pageAll(client, (p) => `/api/v1/view-analyses/${analysisId}/snapshots?page=${p}&limit=100`, 'list snapshots');
  const hit = rows
    .filter((s) => s?.origin === 'filter' && s?.viewAnalysisId === analysisId && !s?.ruleRunId && canonicalFilters(s?.filters) === want)
    .sort(oldestFirst)[0];
  if (hit) return String(hit.id);
  const created = okBody(await client.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters }), 'create snapshot');
  return String(created.id);
}

/** Build (or find) the workbench; scopes are created lazily and memoized for the run. */
export async function ensureWorkbench(
  client: ApiClient, workspaceId: string, fixtures: ResolvedFixture[], operationIds: string[],
): Promise<Workbench> {
  const projectId = await ensureProject(client, workspaceId);
  await ensureLinks(client, projectId, fixtures);
  const sapVersionId = await ensureSap(client, projectId, operationIds);
  const scopes = new Map<string, Promise<Scope>>();
  const scope = (fixtureKey: string, filters: ProbeFilter[]): Promise<Scope> => {
    const key = scopeName(fixtureKey, filters);
    if (!scopes.has(key)) {
      const fixture = fixtures.find((f) => f.key === fixtureKey);
      if (!fixture) return Promise.reject(new Error(`no resolved fixture "${fixtureKey}"`));
      const made = (async () => {
        const analysisId = await ensureAnalysis(client, projectId, fixture.datasetId, key);
        const snapshotId = await ensureSnapshot(client, analysisId, filters);
        return { analysisId, snapshotId, datasetId: fixture.datasetId, filters };
      })();
      made.catch(() => scopes.delete(key));
      scopes.set(key, made);
    }
    return scopes.get(key)!;
  };
  return { projectId, sapVersionId, scope };
}
