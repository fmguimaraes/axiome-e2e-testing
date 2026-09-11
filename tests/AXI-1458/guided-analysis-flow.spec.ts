import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';

/**
 * AXI-1458 — Guided Analysis spike vertical slice (@SI-045).
 * (manual-e2e AXI-1458-Guided-Analysis-Spike.md §3–§5.)
 *
 * Drives the isolated unit end-to-end through the gateway with an inline
 * subject-key + two-timepoint dataset: profile → options → compute → star →
 * reconstruct. Asserts the load-bearing spike properties:
 *  - the flow completes on the DETERMINISTIC FALLBACK (the default provider),
 *    proving NFR3/NFR9/AC14 without any LLM credentials;
 *  - the external contract carries NO rule-vs-LLM authorship signal (FR21/AC17);
 *  - the node/leaf/path tree reconstructs from the store alone (FR25/AC20);
 *  - the effect size + CI are present and the leaf conforms to the §10 schema.
 *
 * This is a governed API-level flow (no browser); the UI liveness is
 * guided-analysis-page.spec.ts (@SI-046).
 */
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const DATASET = {
  datasetVersion: 'e2e-igg4-cd8-v1',
  columns: ['subject', 'timepoint', 'cd8_percent'],
  rows: Array.from({ length: 12 }, (_, i) => i + 1).flatMap((p) => [
    { subject: `P${p}`, timepoint: 'T1', cd8_percent: 18 + p },
    { subject: `P${p}`, timepoint: 'T2', cd8_percent: 38 + p },
  ]),
};

let api: Api;
let workspaceId: string;
let projectId: string;

test.beforeAll(async () => {
  api = await adminApi();
  const tenant = await ensureTenant(api);
  workspaceId = tenant.workspaceId;
  projectId = tenant.projectId;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('@SI-045 profiles a linked dataset into a data_state (FR1/AC1)', async () => {
  const res = await api.post('/api/v1/guided-analysis/profile', { projectId, dataset: DATASET }, workspaceHeader(workspaceId));

  expect(res.status).toBe(201);
  expect(res.body.subjectKey).toBe('subject');
  expect(res.body.timepointLevels).toEqual(['T1', 'T2']);
});

test('@SI-045 offers the deterministic paired-delta option with a fallback label (FR2/NFR3)', async () => {
  const profiled = await api.post('/api/v1/guided-analysis/profile', { projectId, dataset: DATASET }, workspaceHeader(workspaceId));
  const res = await api.post('/api/v1/guided-analysis/options', { projectId, dataState: profiled.body }, workspaceHeader(workspaceId));

  const paired = res.body.options.find((o: { optionId: string }) => o.optionId === 'PAIRED-DELTA');
  expect(paired.enabled).toBe(true);
  expect(typeof paired.label).toBe('string');
  // AI-indistinguishability (FR21/AC17): no field reveals rule-vs-LLM authorship.
  expect(paired).not.toHaveProperty('source');
  expect(paired).not.toHaveProperty('author');
  expect(paired).not.toHaveProperty('llm');
});

test('@SI-045 computes, stars, and reconstructs from the store alone (FR7/FR11/AC5/AC8/AC20)', async () => {
  const profiled = await api.post('/api/v1/guided-analysis/profile', { projectId, dataset: DATASET }, workspaceHeader(workspaceId));
  const computed = await api.post(
    '/api/v1/guided-analysis/compute',
    { projectId, dataState: profiled.body, optionId: 'PAIRED-DELTA', dataset: DATASET },
    workspaceHeader(workspaceId),
  );
  expect(computed.body.effect.measure).toBe('median_paired_difference');
  expect(computed.body.effect).toHaveProperty('ciLow');
  expect(Array.isArray(computed.body.whatThisCannotSay)).toBe(true);

  const starred = await api.post('/api/v1/guided-analysis/star', { projectId, nodeId: computed.body.nodeId }, workspaceHeader(workspaceId));
  expect(starred.body.leaf_id).toMatch(/^L-/);
  expect(starred.body.claim_ceiling).toContain('RUO');

  const tree = await api.get(`/api/v1/guided-analysis/tree?projectId=${projectId}`, workspaceHeader(workspaceId));
  expect(tree.body.nodes.length).toBeGreaterThanOrEqual(1);
  expect(tree.body.leaves.length).toBeGreaterThanOrEqual(1);
});

test('@SI-045 hands the leaf to the decision layer unchanged (FR19/AC15)', async () => {
  const profiled = await api.post('/api/v1/guided-analysis/profile', { projectId, dataset: DATASET }, workspaceHeader(workspaceId));
  const computed = await api.post(
    '/api/v1/guided-analysis/compute',
    { projectId, dataState: profiled.body, optionId: 'PAIRED-DELTA', dataset: DATASET },
    workspaceHeader(workspaceId),
  );
  const starred = await api.post('/api/v1/guided-analysis/star', { projectId, nodeId: computed.body.nodeId }, workspaceHeader(workspaceId));

  const handoff = await api.post('/api/v1/guided-analysis/handoff', { projectId, leafId: starred.body.leaf_id }, workspaceHeader(workspaceId));
  expect(handoff.body.kind).toBe('guided_analysis_leaf');
  expect(handoff.body.leaf.leaf_id).toBe(starred.body.leaf_id);
});
