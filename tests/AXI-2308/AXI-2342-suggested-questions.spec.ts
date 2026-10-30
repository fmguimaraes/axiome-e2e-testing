import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { callLogRows, debugHolder, type DebugHolder } from './harness/automatic-mode';
import { drainGoverned, ingestCsvFixture, suggestTemplates } from './harness/opening-templates';

/**
 * AXI-2342 (epic AXI-2308 — FR28, AC22, STRETCH): "questions this data can answer" — ~5 ranked,
 * DETERMINISTIC suggestions generated from every opening template (T1-T4, AXI-2339) whose
 * binding guards the dataset's semantic profile already fills, with no LLM call anywhere.
 * Clicking a suggestion runs it through the SAME path the wizard's own Run button uses
 * (`POST /guided-analysis/wizard-runs`, AXI-2349) — again with no LLM call.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2342.3-.5.
 * API-level (no browser), matching this epic's sibling opening-templates/wizard-runs specs
 * (AXI-2339, AXI-2349): the browser screen (`/investigator/uploads`) is a thin reader of these
 * two routes and is covered at the unit level (`suggestedQuestions.test.ts`, UT-INVESTIGATOR-6710..6715).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339's; synthetic, 24
 * rows, the investigator's header shape; no patient value) — every one of T1-T4's guards is met.
 *
 * No LLM provider is reachable (`GUIDED_ANALYSIS_LLM_TRANSPORT=recorded`, no provider key): the
 * call-log table (AXI-2341/2352) is read directly and asserted to gain zero rows across the whole
 * spec, which is itself the proof that neither `suggest` nor the launched run calls one (AC22).
 *
 * STATUS: spec authored against the pushed AXI-2342 branches, NOT YET RUN — this story's isolated
 * E2E stack (`wt-up.sh`) could not be provisioned from this agent: the "[Modify Shared Resources]"
 * permission wall blocks isolated-stack provisioning for a story-developer subagent, matching the
 * limitation already on file for a sibling story of this epic. Unit suites and typecheck for both
 * repos are green (see the handback report); e2e-pass is NOT claimed here.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2342 branches> npx playwright test tests/AXI-2308/AXI-2342-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const TEMPLATE_IDS = ['T1', 'T2', 'T3', 'T4'];
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

let api: Api;
let t: Tenant;
let datasetId: string;
let dataset: AnchoredDataset;
let holder: DebugHolder;

const now = () => new Date().toISOString();

/** The slot answers a suggestion's own picked parameters carry, in a stable order, as `profile` provenance. */
function slotsOf(parameters: Record<string, unknown>) {
  const at = now();
  const order = ['outcome', 'groupingColumn', 'groups', 'x', 'y', 'adjustFor'];
  return order
    .filter((slot) => parameters[slot] !== undefined)
    .map((slot) => ({ slot, value: parameters[slot], provenance: 'profile', answeredAt: at }));
}

const TEMPLATE_INTENTS: Record<string, string> = { T1: 'compare_groups', T2: 'compare_groups', T3: 'explore_dataset', T4: 'explore_dataset' };

/** The exact wizard-runs launch body the front end's `launchRequestForSuggestion` builds. */
function launchBodyFor(suggestion: any) {
  return {
    projectId: t.projectId,
    dataset,
    question: suggestion.question,
    intent: TEMPLATE_INTENTS[suggestion.templateId],
    intentSource: 'chosen',
    suggestionCallId: null,
    templateId: suggestion.templateId,
    slots: slotsOf(suggestion.parameters),
  };
}

async function newCallLogCount(): Promise<number> {
  return (await callLogRows(holder, t)).length;
}

test.describe.serial('AXI-2342 suggested questions from the semantic profile @SI-045 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    holder = await debugHolder(api, t);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2342.3 AC22 — ~5 ranked, deterministic suggestions, never two naming the same template, no LLM call', async () => {
    const before = await newCallLogCount();

    const first = await suggestTemplates(api, t, dataset);
    const second = await suggestTemplates(api, t, dataset);

    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(5);
    expect(new Set(first.map((s: any) => s.templateId)).size).toBe(first.length);
    expect(first.map((s: any) => s.rank)).toEqual(first.map((_: any, i: number) => i + 1));
    for (const id of first.map((s: any) => s.templateId)) expect(TEMPLATE_IDS).toContain(id);

    // deterministic: calling it again, nothing changed, yields byte-identical output
    expect(second).toEqual(first);

    // no LLM call was made to generate the suggestions
    expect(await newCallLogCount()).toBe(before);
  });

  test('AXI-2342.4 AC22 — clicking a suggestion runs it exactly like the wizard\'s own Run, no LLM call', async () => {
    const before = await newCallLogCount();
    const [suggestion] = await suggestTemplates(api, t, dataset);

    const launch = await api.post(`${WIZARD_RUNS}`, launchBodyFor(suggestion), t.headers);

    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(launch.body.ok, JSON.stringify(launch.body)).toBe(true);
    const { record, runId } = launch.body;
    expect(record).toMatchObject({
      projectId: t.projectId,
      datasetId,
      runId,
      question: suggestion.question,
      templateId: suggestion.templateId,
      intentSource: 'chosen',
      suggestionCallId: null,
      suggestionModel: null,
    });
    expect(record.slots.every((s: any) => s.provenance === 'profile')).toBe(true);

    const status = await drainGoverned(api, t, runId);
    for (const node of status.nodes) expect(node.status, JSON.stringify(node)).toMatch(/^(SUCCEEDED|REUSED|AWAITING_APPROVAL)$/);
    expect(status.nodes.some((n: any) => /^(SUCCEEDED|REUSED)$/.test(n.status)), JSON.stringify(status.nodes)).toBe(true);

    // launching the run called no LLM either
    expect(await newCallLogCount()).toBe(before);
  });

  test('AXI-2342.5 AC22 — a narrower dataset (one 2-level grouping + one continuous column) suggests only T1', async () => {
    const narrow = { ...dataset, columns: dataset.columns.filter((c: any) => ['sexe', 'igg4_g_l'].includes(c.name)) };

    const suggestions = await suggestTemplates(api, t, narrow);

    expect(suggestions.map((s: any) => s.templateId)).toEqual(['T1']);
    const launch = await api.post(`${WIZARD_RUNS}`, launchBodyFor({ ...suggestions[0] }), t.headers);
    expect(launch.status, JSON.stringify(launch.body)).toBe(200);
    expect(launch.body.ok, JSON.stringify(launch.body)).toBe(true);
    await drainGoverned(api, t, launch.body.runId);
  });
});
