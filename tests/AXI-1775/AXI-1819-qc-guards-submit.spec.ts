import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, stepUrl, planUrl, waitForNode, SCREEN_OP, SETTLED, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1819 - the `qc_guards` step is submittable: the three discovery QC guards (d2-d4) run
 * from the workbench and their verdicts reach the plan read (epic AXI-1775; AXI-1507 FR2,
 * AXI-1792 FR33/AC10/EC10). Owner ruling 2026-09-29: add a qc_guards step submit surface.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 15.
 * Tags: @SI-045 (guided-analysis: step resolver / plan read), @SI-017 (governed QC thresholds).
 *
 * REAL BACKEND, LLM-FREE, API level. The step is submitted on the EXISTING route
 * (`POST .../steps/qc_guards/submit`, operation `qc.rule_gate`) and becomes ONE governed run of
 * the guards' own template nodes into the same container; each guard evaluates its cited
 * IMM-QC rule against the workspace's governed thresholds, on the container's baseline.
 *
 * What is NOT driven here, and why (both are unit-covered, UT-GUIDED-1819-1310/1321/1335):
 *   - an induced `block` verdict: the shared tenant's `AnalysisPolicy` is replaced WHOLESALE by
 *     `ensureApprovedDiscoveryConfig`, so raising a guard threshold here would change every
 *     sibling spec's verdicts (section 16.6, manual);
 *   - a failed-then-retried guard: no API makes a served QC rule fail on demand (16.8, manual).
 * The invariant this spec DOES hold is the one both of those rest on: the screen step's
 * disabled reason names a QC block exactly when a recorded verdict is `block` (16.5).
 */
test.describe('AXI-1819 - qc_guards step submit (FR2, FR33, AC10, EC10)', { tag: ['@SI-045', '@SI-017'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  const QC_OP = 'qc.rule_gate';
  const GUARDS = ['d2', 'd3', 'd4'];
  let s: Seeded;
  let va: string;
  let qcRunId: string;
  const body = (extra: Record<string, unknown> = {}) => ({ operationId: QC_OP, datasetId: s.datasetId, ...extra });
  const submitBody = (extra: Record<string, unknown> = {}) => body({ projectId: s.projectId, datasetVersionHash: s.hash, ...extra });
  const planNodes = async (): Promise<Array<{ nodeId: string; stepId: string | null; status: string | null; runId: string | null; verdict?: { outcome: string; reason: string | null } | null }>> => {
    const res = await s.api.get(planUrl(va), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.nodes;
  };

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1819-${tag}`, `AXI-1819 QC guards ${tag}`);
    va = s.viewAnalysisId;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('16.1 AC10 FR2 - resolve names the three declared guards, their citations tagged upstream:plan, and writes nothing', async () => {
    const res = await s.api.post(stepUrl(va, 'qc_guards', 'resolve'), body(), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body, JSON.stringify(res.body)).toMatchObject({ stepId: 'qc_guards', operationId: QC_OP, nodeIds: GUARDS, unresolved: [] });
    expect(res.body.bindings.map((b: { name: string; source: string }) => [b.name, b.source])).toEqual(GUARDS.map((id) => [`${id}.ruleCode`, 'upstream:plan']));
    expect(res.body.bindings.map((b: { value: string }) => b.value)).toEqual(['IMM-QC-01', 'IMM-QC-02', 'IMM-QC-05']);
    // Stated, so an unserved guard rule (AXI-1815) fails HERE with its sentence rather than deep in a run.
    expect(res.body.disabledReason, 'the step is runnable on a fresh, approved container').toBeNull();
    expect(res.body.fullyBound).toBe(true);
    for (const n of (await planNodes()).filter((x) => GUARDS.includes(x.nodeId))) {
      expect(n, `resolve ran nothing: ${n.nodeId}`).toMatchObject({ status: null, runId: null });
    }
  });

  test('16.7 EC10 NFR4 - refusals are outputs that launch nothing: a named branch, a pick, another dataset; the wrong operation is 400, a foreign analysis 404', async () => {
    const branch = await s.api.post(stepUrl(va, 'qc_guards', 'submit'), submitBody({ branchId: randomUUID() }), s.t.headers);
    expect(branch.status, JSON.stringify(branch.body)).toBe(201);
    expect(branch.body.submitted).toBe(false);
    expect(branch.body.reasons.join(' | ')).toMatch(/judge the base population every branch of this analysis shares/);

    const pick = await s.api.post(stepUrl(va, 'qc_guards', 'resolve'), body({ picks: { min_sample_size: 3 } }), s.t.headers);
    expect(pick.status, JSON.stringify(pick.body)).toBe(200);
    expect(pick.body.disabledReason).toMatch(/no slot to pick: min_sample_size/);

    const otherDataset = await s.api.post(stepUrl(va, 'qc_guards', 'resolve'), body({ datasetId: randomUUID() }), s.t.headers);
    expect(otherDataset.status, JSON.stringify(otherDataset.body)).toBe(200);
    expect(otherDataset.body.disabledReason).toMatch(new RegExp(`declared its QC guards over dataset ${s.datasetId}, not `));

    const wrongOp = await s.api.post(stepUrl(va, 'qc_guards', 'resolve'), body({ operationId: SCREEN_OP }), s.t.headers);
    expect(wrongOp.status, JSON.stringify(wrongOp.body)).toBe(400);
    expect(JSON.stringify(wrongOp.body)).toMatch(/step qc_guards does not run stats\.screen_shortlist/);

    const missing = await s.api.post(stepUrl(randomUUID(), 'qc_guards', 'resolve'), body(), s.t.headers);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);

    for (const n of (await planNodes()).filter((x) => GUARDS.includes(x.nodeId))) {
      expect(n, `no refusal launched ${n.nodeId}`).toMatchObject({ status: null, runId: null });
    }
  });

  test('16.2 FR2 AC10 - submit runs d2..d4 as ONE governed run into this container and every guard settles to a recorded verdict', async () => {
    const res = await s.api.post(stepUrl(va, 'qc_guards', 'submit'), submitBody(), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
    expect(res.body).toMatchObject({ viewAnalysisId: va, nodeId: 'd2', nodeIds: GUARDS });
    qcRunId = res.body.runId;
    for (const id of GUARDS) {
      const { node } = await waitForNode(s, qcRunId, id);
      // A refusal to RUN the cited rule FAILS the node (never a verdict); a verdict — pass,
      // degrade or block — is a SUCCEEDED node. REUSED = the content-addressed reuse of an
      // identical earlier guard run on the same data.
      expect(node.status, `${id}: ${JSON.stringify(node)}`).toMatch(/SUCCEEDED|REUSED/);
    }
  });

  test('16.3 FR2 - the plan read carries each guard\'s own attempt: status, the run, and the recorded verdict verbatim; d1 stays unattempted', async () => {
    const nodes = await planNodes();
    for (const id of GUARDS) {
      const n = nodes.find((x) => x.nodeId === id);
      expect(n, `${id} on the plan read`).toBeTruthy();
      expect(n, JSON.stringify(n)).toMatchObject({ stepId: 'qc_guards', runId: qcRunId });
      expect(SETTLED.has(n!.status ?? ''), `${id} settled: ${n!.status}`).toBe(true);
      // A SUCCEEDED guard carries the verdict the QC executor recorded; a REUSED one has no
      // readable output of its own (AXI-1792 follow-up b) and reads null — never a made-up verdict.
      const expected = n!.status === 'SUCCEEDED' ? { outcome: expect.stringMatching(/^(pass|degrade|block)$/) } : null;
      expect(n!.verdict ?? null, `${id} verdict: ${JSON.stringify(n)}`).toEqual(expected === null ? null : expect.objectContaining(expected));
    }
    expect(nodes.find((x) => x.nodeId === 'd1'), 'the profile was not run by the QC step').toMatchObject({ status: null, runId: null });
  });

  test('16.4 FR2 NFR8 - a second submit once every guard recorded is refused with each guard\'s status, and launches nothing', async () => {
    const res = await s.api.post(stepUrl(va, 'qc_guards', 'submit'), submitBody(), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.submitted).toBe(false);
    expect(res.body.reasons.join(' | ')).toMatch(/every QC guard of this analysis already has a recorded or running attempt \(d2 IMM-QC-01 \w+, d3 IMM-QC-02 \w+, d4 IMM-QC-05 \w+\)/);
    for (const n of (await planNodes()).filter((x) => GUARDS.includes(x.nodeId))) expect(n.runId, `${n.nodeId} kept its one attempt`).toBe(qcRunId);
  });

  test('16.5 AC10 EC10 FR33 - the screen step names a QC block exactly when a recorded guard verdict is block (the gate reads the SAME records)', async () => {
    const blocked = (await planNodes()).filter((n) => GUARDS.includes(n.nodeId) && n.verdict?.outcome === 'block').map((n) => n.nodeId);
    const res = await s.api.post(stepUrl(va, 'screen', 'resolve'), { operationId: SCREEN_OP, datasetId: s.datasetId }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const names = (res.body.disabledReason ?? '').match(/\((d[234])\) blocked/g)?.map((m: string) => m.slice(1, 3)) ?? [];
    expect(names.sort(), `blocked guards on the plan read ${JSON.stringify(blocked)} vs screen's reason: ${res.body.disabledReason}`).toEqual(blocked.sort());
  });
});
