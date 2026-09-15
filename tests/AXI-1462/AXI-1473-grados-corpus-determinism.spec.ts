import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, asList, type Api } from '../AXI-1435/harness/api';
import { ensureTenant, ingestFixture } from '../AXI-1435/harness/seed';
import { drainRun, type RunStatus } from './harness/governed';

/**
 * AXI-1473 — Grados-corpus determinism attestation (@SI-047), covers AC6(b) of
 * feature IN-PROGRESS-Guided-Analysis-Industrialization (FR21).
 *
 * AC6 crux: on the governed path, identical inputs REUSE byte-identically — the
 * same plan submitted twice does NOT recompute; the second run content-address
 * REUSES the first run's artifact (`StepReused` → node status `REUSED`), with a
 * byte-identical `artifactHash`. This is the property the whole Class-C
 * defensibility of SI-047 rests on (NFR4 — no silent recompute).
 *
 * A STRUCTURAL plan (a `qc_check` no-op) is used so the attestation needs no
 * compute plane and no LLM: determinism is a property of the engine's content
 * addressing + append-only log, not of any one statistic. Requires
 * GOVERNED_EXECUTION_RECONCILER=on on the backend (else nothing advances).
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let workspaceId: string;
let projectId: string;
let datasetId: string;

// A fixed, content-addressable structural plan. Identical plan text ⇒ identical
// input fingerprint ⇒ the engine reuses on the second submission (NFR4).
function structuralPlan(planId: string) {
  return {
    planId,
    revision: 1,
    question: 'Grados corpus determinism attestation (AXI-1473)',
    sendData: false,
    reasoning: { restatedQuestion: 'reuse attestation', whyThisApproach: 'attest byte-identical reuse', whatThisWillNotEstablish: 'n/a', alternativesConsidered: [] },
    datasetsUsed: [],
    datasetsAvailableNotUsed: [],
    declaredFamily: null,
    nodes: [{ id: 'n1', nodeType: 'qc_check', stepLabel: 'structural qc', clinicalQuestion: 'qc', why: 'attestation', dependsOn: [], params: { k: 'fixed' }, expectedEvidence: 'none', visualisation: null, proposedClaimCeiling: 'exploratory', familyId: null }],
  };
}

async function submit(planId: string): Promise<string> {
  const res = await api.post('/api/v1/governed-execution/submit', { projectId, plan: structuralPlan(planId), datasetId, workspaceId }, workspaceHeader(workspaceId));
  expect(res.status, `submit ${planId}`).toBe(201);
  return res.body.runId as string;
}

function nodeOf(run: RunStatus, suffix: string) {
  const node = (run.nodes ?? []).find((n) => n.nodeId.endsWith(suffix));
  if (!node) throw new Error(`node ${suffix} absent from run ${run.runId}`);
  return node;
}

test.beforeAll(async () => {
  api = await adminApi();
  const t = await ensureTenant(api);
  workspaceId = t.workspaceId;
  projectId = t.projectId;
  // The structural plan is a content-addressed no-op — it needs only a datasetId
  // to anchor the run container, not the dataset's contents. Reuse any dataset
  // already in the tenant, else ingest a tiny fixture so the attestation is
  // self-sufficient (idempotent — safe on a shared/demo DB).
  const ds = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?limit=1`, workspaceHeader(workspaceId));
  datasetId = asList(ds.body)[0]?.id ?? (await ingestFixture(api, t, 'statistical-trigger.csv').catch(() => undefined as unknown as string));
  test.skip(!datasetId, 'could not anchor a governed run (no dataset, and ingestion is not permitted in this environment) — deferred to the W5 acceptance environment');
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('AC6 — first governed run executes the structural node to a content-addressed artifact', { tag: ['@SI-047'] }, async () => {
  const runId = await submit('AXI-1473-DET-1');
  const run = await drainRun(api, workspaceId, projectId, runId);
  const n1 = nodeOf(run, 'n1');
  expect(n1.status).toBe('SUCCEEDED');
  expect(n1.artifactHash).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test('AC6 — identical inputs REUSE byte-identically; the second run does not recompute (NFR4)', { tag: ['@SI-047'] }, async () => {
  const firstRun = await drainRun(api, workspaceId, projectId, await submit('AXI-1473-DET-1'));
  const secondRun = await drainRun(api, workspaceId, projectId, await submit('AXI-1473-DET-1'));

  const firstNode = nodeOf(firstRun, 'n1');
  const secondNode = nodeOf(secondRun, 'n1');
  // Determinism: the second run content-address REUSES, byte-identical — the
  // reused executor is never invoked (no silent recompute).
  expect(secondNode.status).toBe('REUSED');
  expect(secondNode.artifactHash).toBe(firstNode.artifactHash);
});
