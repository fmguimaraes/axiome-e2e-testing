/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Page, Route } from '@playwright/test';

/**
 * AXI-2570 (epic AXI-2567) — an in-memory double of the SAP API for ONE project holding an open
 * DECLARED (schemaVersion 2) draft, installed with `page.route`. Modelled on the AXI-2570
 * contracts (`sap-question-stub.contract.ts`, `SapDraftCompletenessReport`):
 *
 * - `POST …/draft/question-stubs` stores `{questionId, text, role, position}` (no plan field);
 * - `PUT …/draft/questions/:id` replaces a question keeping its id and position (completes a stub);
 * - the completeness read carries `questionStates` — a FIXTURE of the server rule: a stub is
 *   `stub` and fails CC2/CC3/CC6 on its own question; a planned question is `complete`.
 *
 * Sign-in, the workspace, the project and the caller's permissions stay REAL (demo gateway).
 * Why a double: no running stack serves the AXI-2570 branch (see the spec header).
 */

export const ARM_FIELD = 'field-arm';
export const CRP_FIELD = 'field-crp';
export const POPULATION = 'Adults with rheumatoid arthritis, 18-75 years';

export interface StubWrite { method: string; path: string; body: any }

const T1 = {
  templateId: 'T1', templateVersion: '1.0.0', isNewest: true, wholeMatrixMainResultVersion: null,
  mainResult: { pValueField: 'p_value', effectField: null }, parameterSchema: [], supportsOneSidedAlternative: false,
  cellAxisSlots: null, declaredOutputs: {},
  slots: [
    { slot: 'groupingColumn', allowedSemanticRoles: ['grouping_two_levels'] },
    { slot: 'outcome', allowedSemanticRoles: ['continuous'] },
  ],
};

const PLAN_FIELDS = ['estimand', 'template', 'bindings', 'parameters', 'decisionCriterion', 'sensitivityAnalyses'];
const isStub = (q: any) => PLAN_FIELDS.every((f) => !(f in q));

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

export class QuestionFlowStub {
  readonly writes: StubWrite[] = [];
  private readonly sapId = 'sap-e2e-2570';
  private seq = 0;
  private readonly draft: any;

  constructor(private readonly projectId: string, userId: string) {
    const now = new Date().toISOString();
    this.draft = {
      draftId: 'draft-e2e-2570', sapId: this.sapId, projectId, revision: 1, basedOnVersion: null,
      title: 'CRP prospective plan', questionText: 'Does CRP differ between arms?', planText: '',
      updatedBy: userId, createdAt: now, updatedAt: now,
      plan: {
        schemaVersion: 2, analysisDatasetId: null, studyPopulation: POPULATION, specificationSource: 'declared',
        dataSpecification: { fields: [
          { fieldId: CRP_FIELD, name: 'crp_mg_l', label: 'CRP (mg/L)', semanticRole: 'continuous', required: true },
          { fieldId: ARM_FIELD, name: 'arm', label: 'Treatment arm', semanticRole: 'grouping_two_levels', levels: ['A', 'B'], required: true },
        ] },
        questions: [],
      },
    };
  }

  get questions(): any[] { return this.draft.plan.questions; }

  writesTo(method: string, suffix: string): StubWrite[] {
    return this.writes.filter((w) => w.method === method && w.path.endsWith(suffix));
  }

  async install(page: Page): Promise<void> {
    await page.route((url) => url.pathname.includes(`/projects/${this.projectId}/sap`), (route) => this.handle(route));
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
    if (key === 'GET <p>/sap-templates') return [200, [T1]];
    if (key === 'GET <sap>/versions') return [200, []];
    if (key === 'POST <sap>/draft/question-stubs') return [201, this.addStub(body)];
    if (key.startsWith('PUT <sap>/draft/questions/')) return [200, this.replace(path.split('/').pop() as string, body)];
    if (key.startsWith('DELETE <sap>/draft/questions/')) return [200, this.remove(path.split('/').pop() as string)];
    if (key === 'GET <sap>/draft/completeness') return [200, this.completeness()];
    if (key === 'GET <sap>/runs') return [200, { data: [], meta: { total: 0, page: 1, limit: 50 } }];
    return null;
  }

  private bump() { this.draft.revision += 1; this.draft.updatedAt = new Date().toISOString(); return this.draft; }

  private addStub(body: any) {
    this.seq += 1;
    const questionId = `77777777-7777-4777-8777-00000000000${this.seq}`;
    this.questions.push({ questionId, text: body.question.text, role: body.question.role, position: this.questions.length + 1 });
    return { ...this.bump(), addedQuestionId: questionId };
  }

  private replace(questionId: string, body: any) {
    const at = this.questions.findIndex((q) => q.questionId === questionId);
    const kept = this.questions[at];
    this.questions[at] = { ...body.question, questionId, position: kept.position };
    return this.bump();
  }

  private remove(questionId: string) {
    this.draft.plan.questions = this.questions.filter((q) => q.questionId !== questionId);
    return this.bump();
  }

  private completeness() {
    const pass = (checkId: string) => ({ checkId, status: 'pass', message: 'ok', ruleRef: checkId });
    const stubs = this.questions.filter(isStub);
    const results: any[] = ['CC1', 'CC4', 'CC5', 'CC7', 'CC8', 'CC9', 'CC10', 'CC12', 'CC13', 'CC14', 'CC15', 'CC16', 'CC18'].map(pass);
    for (const id of ['CC2', 'CC3', 'CC6']) {
      results.push(...(stubs.length === 0 ? [pass(id)] : stubs.map((s) => ({ checkId: id, status: 'fail', questionId: s.questionId, message: 'awaiting its plan', ruleRef: id }))));
    }
    const questionStates = [...this.questions].sort((a, b) => a.position - b.position)
      .map((q) => ({ questionId: q.questionId, state: isStub(q) ? 'stub' : 'complete' }));
    return { results, engineVersion: 'e2e-stub', questionStates };
  }
}
