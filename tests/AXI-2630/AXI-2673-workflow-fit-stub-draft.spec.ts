import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2673 (epic AXI-2630 — fix commit `c8b0d873`; SI-042) — regression guard for the live
 * defect found during the AXI-2659 real-browser walk: `SpecSchemaDeclarationsResolver.resolve()`
 * read a LIVE SAP draft through the FINAL-only `parseSapPlanV2` parser (every question fully
 * shaped, no stub). A live "Plan Before Data" draft almost always carries at least one
 * unplanned/stub question (text + role only — the ordinary in-progress state), so the parser
 * refused it and the resolver reported `NotFoundException('SAP not found')`, which the front
 * end's `usePlanQuestionForm.ts` surfaced as "Could not check which workflows fit your
 * variables" — permanently disabling every T1-T5 workflow card.
 *
 * API-ONLY, against w5val (API_BASE_URL points at the live stack; no browser `page`). Builds a
 * draft with ONE fully-shaped/planned question (Q1) and ONE true stub (Q2 — text/role only,
 * never planned), then calls the exact route the planning page calls for Q2's own workflow
 * step: `POST /api/v1/guided-analysis/opening-templates/match` with
 * `dataset.datasetId = "spec:<sapId>:draft"` (the live-draft virtual schema id
 * `usePlanQuestionForm.ts` builds for ANY question on an open draft, planned or not — the id
 * names the DRAFT, not the individual question). Asserts the server answers `200` with the
 * four-template catalogue (never the pre-fix `404 "SAP not found"`), and that at least one
 * template is `eligible: true` given the declared variables — the actual "cards enabled"
 * behaviour, not just "not technically a 404".
 *
 * Same two-identity shape as AXI-2647 (`AXI-2647-adr002-acceptance.spec.ts`): `admin` provisions
 * the project, `investigator` drives every SAP-surface step.
 *
 * Scenario: `axiome-docs/manual-e2e/AXI-2630-AXI-2673-Workflow-Fit-Stub-Draft.md`.
 */

const WS = process.env.HANDOVER_WORKSPACE_ID ?? '';
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'admin@cro-one.com';
const ADMIN_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'admin';
const INV_EMAIL = process.env.E2E_INVESTIGATOR_EMAIL ?? '';
const INV_PASSWORD = process.env.E2E_INVESTIGATOR_PASSWORD ?? '';
const PROFILE_ID = 'immune_mediated_microbiota';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

interface Session {
  api: APIRequestContext;
}

async function login(anon: APIRequestContext, email: string, password: string): Promise<Session> {
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${await res.text()}`).toBeTruthy();
  const { accessToken } = await res.json();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  return { api };
}

let admin: Session;
let investigator: Session;

test.beforeAll(async () => {
  test.skip(!WS || !INV_EMAIL || !INV_PASSWORD, 'HANDOVER_WORKSPACE_ID / E2E_INVESTIGATOR_EMAIL / _PASSWORD not configured');
  const anon = await apiRequest.newContext();
  admin = await login(anon, ADMIN_EMAIL, ADMIN_PASSWORD);
  investigator = await login(anon, INV_EMAIL, INV_PASSWORD);
  await anon.dispose();
});

test.afterAll(async () => {
  await admin?.api.dispose();
  await investigator?.api.dispose();
});

async function createProject(): Promise<string> {
  const res = await admin.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2673 workflow-fit ${Date.now()}`, workspaceId: WS, semanticProfileId: PROFILE_ID },
    headers: { 'X-Workspace-Id': WS },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

test.describe('AXI-2673 opening-templates/match tolerates a draft stub question @SI-042', () => {
  test('AXI-2673.1 a draft with one planned question and one true stub still matches workflows (200, not 404 SAP not found)', async () => {
    const projectId = await createProject();

    const protocol = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/study/protocol`), {
      data: { title: 'AXI-2673 workflow-fit guard', objective: 'Regression guard for the stub-draft 404', studyPopulation: 'synthetic cohort', text: 'rehearsal' },
    });
    expect(protocol.status(), await protocol.text()).toBe(200);

    const contract = await (await investigator.api.get(apiUrl(`/api/v1/projects/${projectId}/semantic-contract`))).json();
    const configVersion = contract.profile.configVersion as string;
    expect(configVersion).toMatch(/\+sha256:/);

    const draft0 = await (await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/draft`), { data: { planSchemaVersion: 2 } })).json();
    const sapId = draft0.sapId;

    // One declared variable per question slot the plan will bind (group + outcome) — enough for
    // Q1's T2 shape and for `match()` to find at least one eligible template over the schema.
    const specRes = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft`), {
      data: {
        basedOnRevision: draft0.revision,
        title: 'AXI-2673 workflow-fit plan',
        studyPopulation: 'synthetic cohort',
        dataSpecification: {
          fields: [
            { name: 'group', label: 'Group', semanticRole: 'grouping_three_plus_levels', levels: ['HD', 'IgG4-RD', 'SD'], required: false, canonicalField: 'disease_group', profilePin: configVersion },
            { name: 'pct', label: 'Pct', semanticRole: 'continuous', required: false, canonicalField: 'coating_pct', profilePin: configVersion },
          ],
        },
      },
    });
    expect(specRes.status(), await specRes.text()).toBe(200);
    const spec = await specRes.json();
    const byName = new Map<string, string>(spec.plan.dataSpecification.fields.map((f: any) => [f.name, f.fieldId]));
    const groupFieldId = byName.get('group')!;
    const pctFieldId = byName.get('pct')!;

    // Q1: added as a stub, then PLANNED in place (template, bindings, estimand, parameters) —
    // an ordinary fully-shaped question.
    const stub1 = await (await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/question-stubs`), {
      data: { basedOnRevision: spec.revision, question: { text: 'Does the coating pct differ between groups?', role: 'primary' } },
    })).json();
    const q1Id = stub1.addedQuestionId;

    const planned1 = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/questions/${q1Id}`), {
      data: {
        basedOnRevision: stub1.revision,
        analysisDatasetId: null,
        question: {
          text: 'Does the coating pct differ between groups?',
          role: 'primary',
          estimand: { population: 'synthetic cohort', variable: 'coating pct', intercurrentEvents: 'none', populationSummary: 'KW+Dunn', treatmentComparison: 'HD vs IgG4-RD vs SD' },
          template: { templateId: 'T2', templateVersion: '0.3' },
          bindings: [{ slot: 'groupingColumn', field: groupFieldId }, { slot: 'outcome', field: pctFieldId }],
          parameters: { alpha: 0.05, sidedness: 'two_sided', groups: ['HD', 'IgG4-RD', 'SD'] },
          decisionCriterion: { kind: 'p_at_or_below_alpha' },
          sensitivityAnalyses: [],
        },
      },
    });
    expect(planned1.status(), await planned1.text()).toBe(200);
    const planned1Body = await planned1.json();

    // Q2: added as a stub and LEFT a stub — text + role only, no bindings/estimand. This is the
    // exact shape that made the pre-fix parser refuse the whole draft.
    const stub2Res = await investigator.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}/draft/question-stubs`), {
      data: { basedOnRevision: planned1Body.revision, question: { text: 'Is there a dose-response relationship?', role: 'secondary' } },
    });
    expect(stub2Res.status(), await stub2Res.text()).toBe(201);

    // The front end's own id shape for ANY question's workflow step on a live draft
    // (`usePlanQuestionForm.ts`): the draft's whole plan, never a per-question id.
    const specDatasetId = `spec:${sapId}:draft`;

    const match = await investigator.api.post(apiUrl('/api/v1/guided-analysis/opening-templates/match'), {
      data: { projectId, dataset: { datasetId: specDatasetId, displayName: 'Declared data specification', versionHash: '', columns: [] } },
    });
    // Pre-fix: 404 { message: 'SAP not found' }. Post-fix: 200 with the four-template catalogue.
    expect(match.status(), await match.text()).toBe(200);
    const matches = await match.json();
    expect(Array.isArray(matches), JSON.stringify(matches)).toBeTruthy();
    expect(matches).toHaveLength(4);
    for (const m of matches) {
      expect(m).toHaveProperty('templateId');
      expect(m).toHaveProperty('eligible');
    }
    // The actual "cards enabled" behaviour: at least one template is eligible given the
    // declared group + continuous-outcome variables, not merely "the call didn't 404".
    expect(matches.some((m: any) => m.eligible === true), JSON.stringify(matches)).toBeTruthy();
  });
});
