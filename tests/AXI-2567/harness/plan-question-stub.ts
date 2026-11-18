/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Page, Route } from '@playwright/test';

/**
 * AXI-2590 (epic AXI-2567) — an in-memory double of the SAP API for ONE project whose open draft
 * is a DECLARED (schemaVersion 2) plan holding one question STUB, installed with `page.route`.
 * Modelled on the AXI-2570 stub contracts and the AXI-2590 catalogue addition
 * (`SapTemplateCatalogEntry.workflow`: name, method, inputs, choices, guidance, composition,
 * validator verdict) — the shapes `GET …/sap-templates` returns on the AXI-2590 back branch.
 *
 * Sign-in, the workspace, the project and the caller's permissions stay REAL (demo gateway).
 * Why a double: the shared stack serves `main`, which has neither the `workflow` facts, the
 * `spec:<sapId>:draft` resolver NOR a migrated v2 draft (see the spec headers). STUB-ONLY: this
 * double also intercepts `/guided-analysis/opening-templates/match` (contract-shaped, computed
 * from the SAME fields the draft stub serves — review ruling 2026-11-18, item (b)) and
 * `/guided-analysis/intent-prefill/suggest` (a real LLM call on `main` — stubbed to a
 * deterministic "no suggestion" so the ranking test never pays for or depends on one). Real
 * validation of both routes against the AXI-2590 back branch is OWED AT W5.
 */

export const ARM = 'field-arm';
export const CRP = 'field-crp';
export const IL6 = 'field-il6';
export const POPULATION = 'Adults with rheumatoid arthritis, 18-75 years';
export const QUESTION = 'Is CRP higher in arm A than in arm B?';
export const STUB_ID = '90909090-9090-4090-8090-000000000001';

export const FIELDS = [
  { fieldId: ARM, name: 'arm', label: 'Treatment arm', semanticRole: 'grouping_two_levels', levels: ['A', 'B'], canonicalField: 'arm', profilePin: '1', required: true },
  { fieldId: CRP, name: 'crp_mg_l', label: 'CRP (mg/L)', semanticRole: 'continuous', canonicalField: 'crp', profilePin: '1', required: true },
  { fieldId: IL6, name: 'il6_pg_ml', label: 'IL-6 (pg/mL)', semanticRole: 'continuous', required: true },
];

export interface StubWrite { method: string; path: string; body: any }

const pass = { validatorVerdict: 'PASS', publishedAt: '2026-11-02T10:00:00.000Z', libraries: [{ library: 'scipy', version: '1.11.4' }] };

function entry(over: any): any {
  return {
    isNewest: true, wholeMatrixMainResultVersion: null, parameterSchema: [], cellAxisSlots: null,
    declaredOutputs: { mainPValueField: 'p_value' },
    ...over,
    mainResult: {
      pValueField: 'p_value', signedEffectField: null, undefinedReasonField: 'reason', cellBound: false, cellAxisFields: null,
      source: 'declared', ...over.mainResult,
    },
  };
}

const slotDef = (slotId: string, shape: string, cardinality: string, name: string) => ({ slotId, shape, cardinality, wording: { name } });
const out = (name: string, stepId: string) => ({ name, shape: 'numeric', cardinality: 'one', source: { stepId, column: name } });

export const T1 = entry({
  templateId: 'T1', templateVersion: '0.4', supportsOneSidedAlternative: true,
  mainResult: { operationId: 'stats.mann_whitney_u', signedEffectField: 'effect_size' },
  slots: [
    { slot: 'groupingColumn', allowedSemanticRoles: ['grouping_two_levels'], minColumns: 1, maxColumns: 1 },
    { slot: 'outcome', allowedSemanticRoles: ['continuous'], minColumns: 1, maxColumns: 1 },
  ],
  workflow: {
    ...pass, analysisTemplateId: 'at-e2e-t1', name: 'Compare two groups', method: 'Mann-Whitney U test', intentShape: 'compare_groups',
    inputs: [
      { slot: 'groupingColumn', name: 'Groups defined by', question: 'Which variable splits the subjects into the two groups?', hint: null },
      { slot: 'outcome', name: 'Measurement compared', question: 'Which measurement is compared between them?', hint: null },
    ],
    choices: [],
    guidance: {
      whatItDoes: 'Tests whether one group tends to have higher values than the other, without assuming a normal distribution.',
      whenToUse: 'Two independent groups and one measurement.',
      whenNotToUse: 'Paired samples, or more than two groups.',
    },
    composition: {
      nodeLibraryVersion: '1.0.0',
      slots: [slotDef('groupingColumn', 'categorical', 'one', 'Groups defined by'), slotDef('outcome', 'numeric', 'one', 'Measurement compared')],
      steps: [{
        stepId: 'compare', operationId: 'stats.mann_whitney_u', libraryPin: { library: 'scipy', version: '1.11.4' },
        roles: [
          { role: 'groupColumn', sources: [{ kind: 'slot', slotId: 'groupingColumn' }] },
          { role: 'valueColumn', sources: [{ kind: 'slot', slotId: 'outcome' }] },
        ],
        parameters: [{ key: 'alternative', mode: 'user_settable' }],
      }],
      outputs: [out('p_value', 'compare'), out('effect_size', 'compare')],
    },
    defaultChart: 'boxplot_v1',
  },
});

export const T2 = entry({
  templateId: 'T2', templateVersion: '0.3', supportsOneSidedAlternative: false,
  mainResult: { operationId: 'stats.kruskal_wallis' },
  slots: [
    { slot: 'groupingColumn', allowedSemanticRoles: ['grouping_three_plus_levels'], minColumns: 1, maxColumns: 1 },
    { slot: 'outcome', allowedSemanticRoles: ['continuous'], minColumns: 1, maxColumns: 1 },
  ],
  workflow: {
    ...pass, analysisTemplateId: 'at-e2e-t2', name: 'Compare three or more groups', method: "Kruskal-Wallis test, then Dunn's pairwise test (Holm)",
    intentShape: 'compare_groups_omnibus',
    inputs: [
      { slot: 'groupingColumn', name: 'Groups defined by', question: null, hint: null },
      { slot: 'outcome', name: 'Measurement compared', question: null, hint: null },
    ],
    choices: [{
      key: 'posthoc', name: 'Pairwise follow-up', question: 'Compare every pair of groups after the overall test?', hint: null,
      options: [{ value: 'dunn', label: 'Dunn (Holm)' }, { value: 'none', label: 'None' }], default: 'dunn',
    }],
    guidance: null, composition: null, defaultChart: 'boxplot_v1',
  },
});

export const T3 = entry({
  templateId: 'T3', templateVersion: '0.4', supportsOneSidedAlternative: true,
  mainResult: { operationId: 'stats.spearman' },
  slots: [
    { slot: 'x', allowedSemanticRoles: ['continuous'], minColumns: 1, maxColumns: 1 },
    { slot: 'y', allowedSemanticRoles: ['continuous'], minColumns: 1, maxColumns: 1 },
  ],
  workflow: {
    ...pass, analysisTemplateId: 'at-e2e-t3', name: 'Correlate two measurements', method: 'Spearman correlation', intentShape: 'correlate',
    inputs: [
      { slot: 'x', name: 'First measurement', question: null, hint: null },
      { slot: 'y', name: 'Second measurement', question: null, hint: null },
    ],
    choices: [], guidance: null, composition: null, defaultChart: 'scatter_v1',
  },
});

/** A version the validator BLOCKed — never offered. */
export const T1_BLOCKED = { ...T1, templateVersion: '0.5', workflow: { ...T1.workflow, validatorVerdict: 'BLOCK' } };

const PLAN_FIELDS = ['estimand', 'template', 'bindings', 'parameters', 'decisionCriterion', 'sensitivityAnalyses'];
const isStub = (q: any) => PLAN_FIELDS.every((f) => !(f in q));

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

export class PlanQuestionStub {
  readonly writes: StubWrite[] = [];
  private readonly sapId = 'sap-e2e-2590';
  private readonly draft: any;
  catalog: any[] = [T2, T1, T1_BLOCKED, T3];

  constructor(private readonly projectId: string, userId: string, fields: any[] = FIELDS) {
    const now = new Date().toISOString();
    this.draft = {
      draftId: 'draft-e2e-2590', sapId: this.sapId, projectId, revision: 1, basedOnVersion: null,
      title: 'CRP prospective plan', questionText: QUESTION, planText: '',
      updatedBy: userId, createdAt: now, updatedAt: now,
      plan: {
        schemaVersion: 2, analysisDatasetId: null, studyPopulation: POPULATION, specificationSource: 'declared',
        dataSpecification: { fields },
        questions: [{ questionId: STUB_ID, text: QUESTION, role: 'primary', position: 1 }],
      },
    };
  }

  get questions(): any[] { return this.draft.plan.questions; }

  writesTo(method: string, suffix: string): StubWrite[] {
    return this.writes.filter((w) => w.method === method && w.path.endsWith(suffix));
  }

  async install(page: Page): Promise<void> {
    await page.route((url) => url.pathname.includes(`/projects/${this.projectId}/sap`), (route) => this.handle(route));
    await page.route((url) => url.pathname.endsWith('/guided-analysis/opening-templates/match'), (route) => this.handleMatch(route));
    await page.route((url) => url.pathname.endsWith('/guided-analysis/intent-prefill/suggest'), (route) =>
      json(route, 200, { status: 'not_answered' }));
  }

  /**
   * AXI-2590 (ruling (b)) — a deterministic, contract-shaped `OpeningTemplateMatch[]`, computed
   * from the POSTed dataset's own columns (the virtual draft schema the page sends), not a
   * canned fixture: a future fields change to the constructor still gets a consistent match.
   */
  private async handleMatch(route: Route): Promise<void> {
    const req = route.request();
    const body = JSON.parse(req.postData() as string) as { dataset: { columns: Array<{ name: string; type: string; categories?: string[] }> } };
    const columns = body.dataset.columns;
    const candidates = {
      continuous: columns.filter((c) => c.type === 'numeric').map((c) => c.name),
      grouping: columns.filter((c) => c.type === 'categorical').map((c) => ({ column: c.name, levels: c.categories ?? [], controlLevels: [] as string[] })),
    };
    const results = this.catalog.map((entry) => {
      const eligible = (entry.slots as any[]).every((slot) => this.slotHasCandidate(slot, candidates));
      return { templateId: entry.templateId, eligible, unmetGuards: eligible ? [] : [`${entry.templateId}.unmet`], candidates };
    });
    return json(route, 200, results);
  }

  private slotHasCandidate(
    slot: { allowedSemanticRoles: string[]; minColumns?: number },
    candidates: { continuous: string[]; grouping: Array<{ column: string; levels: string[] }> },
  ): boolean {
    const min = slot.minColumns ?? 1;
    if (slot.allowedSemanticRoles.includes('continuous')) return candidates.continuous.length >= min;
    const need2 = slot.allowedSemanticRoles.includes('grouping_two_levels');
    const need3 = slot.allowedSemanticRoles.includes('grouping_three_plus_levels');
    const matching = candidates.grouping.filter((g) => (need2 && g.levels.length === 2) || (need3 && g.levels.length >= 3));
    return matching.length >= min;
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData() as string) : undefined;
    if (method !== 'GET') this.writes.push({ method, path, body });
    const answer = this.answer(method, path, body);
    if (!answer) return route.continue();
    return json(route, answer[0], answer[1]);
  }

  private answer(method: string, path: string, body: any): [number, unknown] | null {
    const base = `/projects/${this.projectId}`;
    const sap = `${base}/saps/${this.sapId}`;
    const key = `${method} ${path.replace(sap, '<sap>').replace(base, '<p>')}`;
    if (key === 'GET <p>/saps') return [200, { data: [], meta: { total: 0 } }];
    if (key === 'GET <p>/sap-draft' || key === 'GET <sap>/draft') return [200, this.draft];
    if (key === 'GET <p>/sap-templates') return [200, this.catalog];
    if (key === 'GET <sap>/versions') return [200, []];
    if (key.startsWith('PUT <sap>/draft/questions/')) return [200, this.replace(path.split('/').pop() as string, body)];
    if (key === 'GET <sap>/draft/completeness') return [200, this.completeness()];
    if (key === 'GET <sap>/runs') return [200, { data: [], meta: { total: 0, page: 1, limit: 50 } }];
    return null;
  }

  private replace(questionId: string, body: any) {
    const at = this.questions.findIndex((q) => q.questionId === questionId);
    const kept = this.questions[at];
    this.questions[at] = { ...body.question, questionId, position: kept.position };
    this.draft.revision += 1;
    this.draft.updatedAt = new Date().toISOString();
    return this.draft;
  }

  private completeness() {
    const ok = (checkId: string) => ({ checkId, status: 'pass', message: 'ok', ruleRef: checkId });
    const stubs = this.questions.filter(isStub);
    const results: any[] = ['CC1', 'CC4', 'CC5', 'CC7', 'CC8', 'CC9', 'CC10', 'CC12', 'CC13', 'CC14', 'CC15', 'CC16', 'CC18'].map(ok);
    for (const id of ['CC2', 'CC3', 'CC6']) {
      results.push(...(stubs.length === 0 ? [ok(id)] : stubs.map((s) => ({ checkId: id, status: 'fail', questionId: s.questionId, message: 'awaiting its plan', ruleRef: id }))));
    }
    const questionStates = this.questions.map((q) => ({ questionId: q.questionId, state: isStub(q) ? 'stub' : 'complete' }));
    return { results, engineVersion: 'e2e-stub', questionStates };
  }
}
