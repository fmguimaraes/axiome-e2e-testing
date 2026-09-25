import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset, buildEnvelope, planQuestion, submitPlan, drainRun, ranWithoutError, loadGradosBank } from './harness/governed';

/**
 * AXI-1473 — Grados-corpus governed-path E2E (@SI-047), covers AC6(a) of feature
 * IN-PROGRESS-Guided-Analysis-Industrialization (FR21).
 *
 * AC6(a): E2E is green across the FULL Grados question bank on the governed path.
 * The bank is the 46-question corpus for the Grados 2017 IgG4-RD demo, defined in
 * tests/AXI-1458/fixtures/grados-questions.json (the durable question-bank
 * fixture — reused here, never re-invented). Each question is driven through the
 * industrialized governed path: guided plan -> governed run -> settled state.
 *
 * A run is GREEN when the planner returns a plan, the engine accepts it, and every
 * node settles without a hard FAILED (SUCCEEDED / REUSED / AWAITING_APPROVAL /
 * degrade are all acceptable governed outcomes — the human halt is the designed
 * terminus of a plan carrying an interpretive node, NFR3). Requires a seeded
 * Grados dataset in the tenant AND GOVERNED_EXECUTION_RECONCILER=on; absent the
 * corpus data the corpus tests skip (honest — full-corpus data is the W5
 * acceptance environment's to provide).
 *
 * The bank is large and each question drives a live LLM plan + governed run; set
 * GRADOS_CORPUS_LIMIT=<n> to cap the slice for a fast smoke run (default: full).
 */
test.describe.configure({ mode: 'serial', timeout: 900_000 });

let api: Api;
let workspaceId: string;
let projectId: string;
let anchor: Awaited<ReturnType<typeof anchorDataset>>;

const GRADOS_QUESTIONS = loadGradosBank();
const LIMIT = Number(process.env.GRADOS_CORPUS_LIMIT ?? GRADOS_QUESTIONS.length);
const CORPUS = GRADOS_QUESTIONS.slice(0, Math.max(1, LIMIT));

test.beforeAll(async () => {
  api = await adminApi();
  const t = await ensureTenant(api);
  workspaceId = t.workspaceId;
  projectId = t.projectId;
  anchor = await anchorDataset(api, workspaceId, projectId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

for (const q of CORPUS) {
  test(`AC6 — governed path runs Grados Q${q.id} (${q.category})`, { tag: ['@SI-047'] }, async () => {
    test.skip(!anchor, 'no Grados dataset seeded in the tenant — full-corpus run is deferred to the W5 acceptance environment');
    const envelope = buildEnvelope(projectId, q.question, [anchor!]);

    const plan = await planQuestion(api, workspaceId, projectId, envelope);
    expect(plan, `planner returned a plan for Q${q.id}`).toBeTruthy();
    expect(Array.isArray(plan.nodes) && plan.nodes.length > 0, `plan for Q${q.id} has nodes`).toBe(true);

    const runId = await submitPlan(api, workspaceId, projectId, plan, anchor!.datasetId);
    expect(runId, `governed engine accepted the plan for Q${q.id}`).toBeTruthy();

    const run = await drainRun(api, workspaceId, projectId, runId!);
    expect(ranWithoutError(run), `Q${q.id} governed run settled without a hard failure: ${JSON.stringify(run?.nodes)}`).toBe(true);
  });
}
