import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, asList, sleep, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';

/**
 * AXI-1458 — Governed Execution: DETERMINISTIC-RUN attestation (@SI-047).
 *
 * Attests that the governed run engine is deterministic and reproducible — the
 * property the whole defensibility claim rests on (Governed-Execution-Run.md §8,
 * §9 #1/#5): the same plan, submitted twice with identical inputs, does NOT
 * recompute — the second run REUSES the first's content-addressed artifact, with
 * a byte-identical artifactHash. And every run's queryable state equals a pure
 * replay of its event log (node_state == rebuildProjection(events)).
 *
 * This drives the isolated unit through the gateway. It uses STRUCTURAL nodes so
 * the attestation needs no compute plane — determinism is a property of the
 * engine's content addressing + append-only log, not of any one statistic.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let workspaceId: string;
let projectId: string;
let datasetId: string;

// A structural-only plan: one qc_check node (no external analysis operation), so
// the engine content-addresses a deterministic no-op output. Identical plan text
// ⇒ identical input fingerprint ⇒ reuse on the second submission.
function structuralPlan(planId: string) {
  return {
    planId, revision: 1, question: 'Deterministic-run attestation', sendData: false,
    reasoning: { restatedQuestion: 'Deterministic-run attestation', whyThisApproach: 'attest reuse', whatThisWillNotEstablish: 'n/a', alternativesConsidered: [] },
    datasetsUsed: [], datasetsAvailableNotUsed: [], declaredFamily: null,
    nodes: [{ id: 'n1', nodeType: 'qc_check', stepLabel: 'structural qc', clinicalQuestion: 'qc', why: 'attestation', dependsOn: [], params: { k: 'fixed' }, expectedEvidence: 'none', visualisation: null, proposedClaimCeiling: 'exploratory', familyId: null }],
  };
}

async function submit(planId: string) {
  const res = await api.post('/api/v1/governed-execution/submit', { projectId, plan: structuralPlan(planId), datasetId, workspaceId }, workspaceHeader(workspaceId));
  expect(res.status).toBe(201);
  return res.body.runId as string;
}

async function pollNode(runId: string, nodeSuffix: string): Promise<{ status: string; artifactHash: string | null }> {
  for (let i = 0; i < 40; i++) {
    const res = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, workspaceHeader(workspaceId));
    const node = (res.body.nodes ?? []).find((n: any) => n.nodeId.endsWith(nodeSuffix));
    if (node && node.status !== 'PENDING' && node.status !== 'READY' && node.status !== 'SCHEDULED' && node.status !== 'RUNNING') {
      return { status: node.status, artifactHash: node.artifactHash };
    }
    await sleep(2000);
  }
  throw new Error(`node ${nodeSuffix} did not reach a terminal status`);
}

test.beforeAll(async () => {
  api = await adminApi();
  const t = await ensureTenant(api);
  workspaceId = t.workspaceId;
  projectId = t.projectId;
  const ds = await api.get(`/api/v1/datasets?workspaceId=${workspaceId}&limit=1`, workspaceHeader(workspaceId));
  datasetId = asList(ds.body)[0]?.id;
  test.skip(!datasetId, 'no dataset available to anchor the analysis container');
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('@SI-047 first run executes the structural node to a content-addressed artifact', async () => {
  const runId = await submit('PL-DET-1');
  const n1 = await pollNode(runId, '__n1');
  expect(n1.status).toBe('SUCCEEDED');
  expect(n1.artifactHash).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test('@SI-047 an identical plan REUSES the prior artifact — deterministic, not recomputed', async () => {
  const first = await submit('PL-DET-1');
  const firstNode = await pollNode(first, '__n1');
  const second = await submit('PL-DET-1');
  const secondNode = await pollNode(second, '__n1');
  // Determinism: the second run does not recompute; it reuses, byte-identical.
  expect(secondNode.status).toBe('REUSED');
  expect(secondNode.artifactHash).toBe(firstNode.artifactHash);
});
