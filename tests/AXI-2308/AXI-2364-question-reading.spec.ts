import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminApi, asList, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestCsvFixture } from './harness/opening-templates';

/**
 * AXI-2364 (epic AXI-2308 — Canon §4.1 step 1; FR48, FR49, FR54, NFR5, NFR11): the Canon
 * question reading, `POST /api/v1/guided-analysis/question-reading/read` (call site
 * `question-reading`, prompt `reading/1`, RECORDED transport). The model types the question and
 * extracts a per-dataset Analysis payload; the engine validator keeps only vocabulary values
 * with verbatim spans.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2364.
 * API-level (no browser): the wizard Read step that consumes this is AXI-2365.
 *
 * Automated here: §.4 (a recording miss is loud) and §.5 (tenancy). Neither needs a recording.
 * §.2 (an answered reading) and §.3 (clinical decision → NOP) are DEFERRED: they need the
 * AXI-2366 MAG4 bank recordings (`llm-debug/recordings/question-reading/`), which are not
 * authored yet. Unit coverage meanwhile: UT-READING-001…015 (validator), 020–026 (service).
 *
 * Unlike intent-prefill, every submitted dataset must live in the project's owning workspace
 * (NFR5), so the datasets below are REAL ingested ones (the AXI-2339 synthetic fixture), never a
 * fresh UUID: a fresh UUID reads as `Dataset not found` before the transport is reached.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2364 branch> npx playwright test tests/AXI-2308/AXI-2364-* --no-deps`.
 */

const READ_PATH = '/api/v1/guided-analysis/question-reading/read';
const FIXTURE = 'opening-templates-paul-header.csv';
const OTHER_WORKSPACE = 'E2E AXI-2364 other tenant';
const OTHER_PROJECT = 'E2E AXI-2364 other project';
const NO_READING = { type: null, readings: [], clarifyingQuestion: null, callId: null };

/** The fixture's header as a planner schema — names, types, levels; never a row value. */
function fixtureSchema(datasetId: string) {
  const numeric = (name: string) => ({ name, type: 'numeric' });
  return {
    datasetId,
    displayName: FIXTURE,
    versionHash: `sha256:${'c3'.repeat(32)}`,
    columns: [
      { name: 'patient_id', type: 'identifier' },
      ...['microbiote_igg4_cer_228', 'microbiote_igg4_mag4_27', 'microbiote_igg4_mag4_22', 'microbiote_igg4_mag4_13', 'igg4_g_l', 'age'].map(numeric),
      { name: 'sexe', type: 'categorical', categories: ['F', 'M'] },
      { name: 'cluster_selon_acr_eular_2019', type: 'categorical', categories: ['C1', 'C2', 'C3', 'C4'] },
      { name: 'atteinte_pancreatique', type: 'categorical', categories: ['0', '1'] },
    ],
  };
}

let api: Api;
let t: Tenant;
let ownDatasetId: string;

/** Tenant B: a second workspace (find-or-create by name) with its own project and dataset. */
async function otherTenant(): Promise<Tenant> {
  const listed = asList((await api.get('/api/v1/workspaces?limit=100')).body).find((w: any) => w.name === OTHER_WORKSPACE);
  const workspaceId = listed?.id ?? (await api.post('/api/v1/workspaces', { name: OTHER_WORKSPACE, type: 'internal', ownerOrganizationId: t.orgId })).body.id;
  const headers = workspaceHeader(workspaceId);
  const projects = asList((await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers)).body);
  const projectId = projects.find((p: any) => p.name === OTHER_PROJECT)?.id ?? (await api.post('/api/v1/projects', { name: OTHER_PROJECT, workspaceId }, headers)).body.id;
  return { orgId: t.orgId, workspaceId, projectId, headers };
}

function read(question: string, datasets: unknown[], extra: Record<string, unknown> = {}) {
  return api.post(READ_PATH, { projectId: t.projectId, question, datasets, ...extra }, t.headers);
}

test.describe('AXI-2364 question reading @SI-068 @SI-010', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    test.setTimeout(180_000); // hooks are not governed by describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    ownDatasetId = await ingestCsvFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2364.4 (FR54) a recording miss is loud — recording_missing with an empty reading, never a fallback @SI-068 @SI-010', async () => {
    const started = Date.now();

    const res = await read(`An unrecorded question ${randomUUID()} about igg4_g_l?`, [fixtureSchema(ownDatasetId)]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ status: 'recording_missing', ...NO_READING });
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  test('AXI-2364.5 (NFR5) another tenant\'s dataset reads as not found, and a body `caller` is refused @SI-068 @SI-010', async () => {
    const b = await otherTenant();
    const foreignDatasetId = await ingestCsvFixture(api, b, FIXTURE);
    expect(foreignDatasetId).not.toBe(ownDatasetId);

    const foreign = await read('Does igg4_g_l differ by sexe?', [fixtureSchema(ownDatasetId), fixtureSchema(foreignDatasetId)]);
    const asserted = await read('Does igg4_g_l differ by sexe?', [fixtureSchema(ownDatasetId)], {
      caller: { userId: 'someone-else', workspaceId: b.workspaceId },
    });

    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(JSON.stringify(foreign.body)).toContain('Dataset not found');
    expect(foreign.body?.status).toBeUndefined();
    expect(asserted.status, JSON.stringify(asserted.body)).toBe(400);
    expect(asserted.body?.status).toBeUndefined();
  });
});
