import type { Page, Route } from '@playwright/test';

/**
 * AXI-2569 (epic AXI-2567 — Plan Before Data) — an in-memory double of the SAP + data-binding
 * API for ONE project, installed with `page.route`.
 *
 * WHY A DOUBLE (disclosed in the story report): the AXI-2568 backend (v2 drafts, data bindings,
 * `plan_timing`) is merged on `axiome-back` main but NO running stack serves it against a
 * migrated database — the shared demo DB lacks the AXI-2568 migration, and migrating a shared DB
 * is forbidden for a story agent. Sign-in, the workspace, the project, its membership and the
 * caller's permissions stay REAL (demo gateway); only the SAP routes, the project's dataset links
 * and the dataset's ingestions are answered here, following AXI-2568's contracts
 * (`libs/contracts/src/sap/sap-plan-v2.contract.ts`, `sap-data-binding.contract.ts`).
 * Replace with the real API once a migrated stack exists (W5).
 */

export const STUB_DATASET_ID = 'ds-e2e-2569';
export const STUB_INGESTION_ID = 'ing-e2e-2569';
export const STUB_COLUMNS = ['subject_id', 'arm', 'crp_mg_l'];

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

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });

export class PlanBeforeDataStub {
  readonly writes: StubWrite[] = [];
  private draft: any = null;
  private versions: any[] = [];
  private bindings: any[] = [];
  private seq = 0;
  private readonly sapId = 'sap-e2e-2569';

  constructor(private readonly projectId: string, private readonly userId: string) {}

  private id(prefix: string): string { this.seq += 1; return `${prefix}-${this.seq}`; }
  private now(): string { return new Date().toISOString(); }

  /** A finalised retrospective v1 plan with one primary question (B1's amend scenario). */
  seedFinalV1(): void {
    this.startDraft(1);
    Object.assign(this.draft, { title: 'Retrospective plan', questionText: 'Does score differ by arm?' });
    this.draft.plan = { schemaVersion: 1, analysisDatasetId: STUB_DATASET_ID, questions: [{
      questionId: 'q-seed', position: 1, text: 'Does score differ by arm?', role: 'primary',
      estimand: { population: 'p', variable: 'v', intercurrentEvents: 'i', populationSummary: 's', treatmentComparison: 't' },
      template: { templateId: 'T1', templateVersion: '1.0.0' },
      bindings: [{ slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' }, { slot: 'outcome', column: 'crp_mg_l', semanticRole: 'continuous' }],
      parameters: { alpha: 0.05, sidedness: 'two_sided' }, decisionCriterion: { kind: 'p_at_or_below_alpha' }, sensitivityAnalyses: [],
    }] };
    const v: any = this.finalise();
    v.analysisDatasetId = STUB_DATASET_ID;
  }

  async install(page: Page): Promise<void> {
    await page.route((url) => this.owns(url), (route) => this.handle(route));
  }

  private owns(url: URL): boolean {
    const p = url.pathname;
    return p.includes(`/projects/${this.projectId}/sap`)
      || p.endsWith(`/projects/${this.projectId}/datasets`)
      || p.includes(`/datasets/${STUB_DATASET_ID}/ingestions`);
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData() as string) : undefined;
    if (method !== 'GET') this.writes.push({ method, path, body });
    const answer = this.answer(method, path, url.searchParams, body);
    if (!answer) return route.continue();
    return json(route, answer[0], answer[1]);
  }

  private answer(method: string, path: string, q: URLSearchParams, body: any): [number, unknown] | null {
    const base = `/projects/${this.projectId}`;
    const sap = `${base}/saps/${this.sapId}`;
    const key = `${method} ${path.replace(sap, '<sap>').replace(base, '<p>')}`;
    if (key === 'GET <p>/datasets') return [200, [{ id: 'link-1', projectId: this.projectId, datasetId: STUB_DATASET_ID, frozen: false }]];
    if (path.endsWith(`/datasets/${STUB_DATASET_ID}/ingestions`)) return [200, [{ id: STUB_INGESTION_ID, status: 'ready', ingestionVersion: 1, completedAt: null, createdAt: this.now() }]];
    if (key === 'GET <p>/saps') return [200, { data: this.versions.slice(-1), meta: { total: this.versions.length ? 1 : 0 } }];
    if (key === 'GET <p>/sap-draft') return this.draft ? [200, this.draft] : [404, { message: 'No open draft', code: 'SAP_DRAFT_NOT_FOUND' }];
    if (key === 'GET <p>/sap-templates') return [200, [T1]];
    if (key === 'POST <p>/saps/draft') return [201, this.startDraft(body?.planSchemaVersion)];
    if (key === 'GET <sap>/versions') return [200, this.versions];
    if (key === 'GET <sap>/draft') return [200, this.draft];
    if (key === 'PUT <sap>/draft') return [200, this.saveDraft(body)];
    if (key === 'POST <sap>/draft/questions') return [201, this.addQuestion(body)];
    if (key.startsWith('DELETE <sap>/draft/questions/')) return [200, this.removeQuestion(path.split('/').pop() as string)];
    if (key === 'GET <sap>/draft/completeness') return [200, this.completeness()];
    if (key === 'POST <sap>/draft/finalise') return [201, this.finalise()];
    if (key === 'GET <sap>/data-bindings') return [200, this.bindings];
    if (/^GET <sap>\/versions\/\d+\/data-binding-proposal$/.test(key)) return [200, this.proposal(Number(path.split('/').at(-2)))];
    if (/^POST <sap>\/versions\/\d+\/data-bindings$/.test(key)) return [201, this.confirm(Number(path.split('/').at(-2)), body)];
    if (key === 'GET <sap>/runs') return [200, { data: [], meta: { total: 0, page: 1, limit: 50 } }];
    if (key === 'GET <sap>/run-classification-preview') return [200, { classification: 'planned_final_look', reproducesSapRunId: null }];
    if (key === 'POST <sap>/runs') return [201, this.run(body)];
    if (key.startsWith('GET <sap>/runs/')) return [200, this.run({ version: 1, datasetVersionId: STUB_INGESTION_ID })];
    return null;
  }

  private startDraft(schemaVersion?: number) {
    const latest = this.versions.at(-1);
    const v2 = schemaVersion === 2 || latest?.plan?.schemaVersion === 2;
    const plan = v2
      ? { schemaVersion: 2, analysisDatasetId: null, studyPopulation: latest?.plan?.studyPopulation ?? '', specificationSource: 'declared',
          dataSpecification: structuredClone(latest?.plan?.dataSpecification ?? { fields: [] }), questions: structuredClone(latest?.plan?.questions ?? []) }
      : { schemaVersion: 1, analysisDatasetId: null, questions: [] };
    this.draft = {
      draftId: this.id('draft'), sapId: this.sapId, projectId: this.projectId, revision: 1, basedOnVersion: latest?.version ?? null,
      title: latest?.title ?? '', questionText: latest?.questionText ?? '', planText: latest?.planText ?? '', plan,
      updatedBy: this.userId, createdAt: this.now(), updatedAt: this.now(),
    };
    return this.draft;
  }

  private bump() { this.draft.revision += 1; this.draft.updatedAt = this.now(); return this.draft; }

  private saveDraft(body: any) {
    for (const k of ['title', 'questionText', 'planText'] as const) if (typeof body[k] === 'string') this.draft[k] = body[k];
    if (typeof body.studyPopulation === 'string') this.draft.plan.studyPopulation = body.studyPopulation;
    if (body.dataSpecification) {
      this.draft.plan.dataSpecification = { fields: body.dataSpecification.fields.map((f: any) => ({ ...f, fieldId: f.fieldId ?? this.id('field') })) };
    }
    return this.bump();
  }

  private addQuestion(body: any) {
    const questionId = this.id('q');
    this.draft.plan.questions.push({ ...body.question, questionId, position: this.draft.plan.questions.length + 1 });
    return { ...this.bump(), addedQuestionId: questionId };
  }

  private removeQuestion(questionId: string) {
    this.draft.plan.questions = this.draft.plan.questions.filter((x: any) => x.questionId !== questionId);
    return this.bump();
  }

  private completeness() {
    const plan = this.draft?.plan;
    const hasPrimary = !!plan?.questions?.some((x: any) => x.role === 'primary');
    const pass = (checkId: string) => ({ checkId, status: 'pass', message: 'ok', ruleRef: checkId, questionId: null });
    const results = ['CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8', 'CC9', 'CC10', 'CC11', 'CC12', 'CC13', 'CC14'].map(pass);
    results.unshift(hasPrimary ? pass('CC1') : { ...pass('CC1'), status: 'fail', message: 'The plan needs a primary question.' });
    if (plan?.schemaVersion === 2) {
      results.push(pass('CC15'), pass('CC16'), pass('CC18'));
      results.push({ checkId: 'CC17', status: 'warn', message: 'A declared field is not used by any question.', ruleRef: 'CC17', questionId: null });
    }
    return { results, engineVersion: 'e2e-stub' };
  }

  private finalise() {
    const n = this.versions.length + 1;
    const d = this.draft;
    const version = {
      id: this.sapId, sapVersionId: `sv-${n}`, projectId: this.projectId, version: n, authorUserId: this.userId,
      contentHash: `${'a'.repeat(63)}${n}`, createdAt: this.now(), updatedAt: this.now(), supersededBy: null, status: 'final',
      title: d.title, questionText: d.questionText, planText: d.planText, linkedMethods: [], plan: structuredClone(d.plan),
      analysisDatasetId: null, finalisedAt: this.now(), finalisedByUserId: this.userId, amendmentReason: n > 1 ? 'Amended' : null,
      contentHashVersion: 2, planTiming: d.plan.schemaVersion === 2 ? 'before_data' : null,
    };
    this.versions.forEach((v) => { v.supersededBy = v.supersededBy ?? version.sapVersionId; });
    this.versions.push(version);
    this.draft = null;
    return version;
  }

  private specFields(version: number): any[] {
    return this.versions.find((v) => v.version === version)?.plan?.dataSpecification?.fields ?? [];
  }

  private proposal(version: number) {
    const fields = this.specFields(version).map((f) => {
      const column = STUB_COLUMNS.includes(f.name) ? f.name : null;
      return { fieldId: f.fieldId, name: f.name, status: column ? 'proposed' : 'unmatched', column, basis: column ? 'exact_name' : null, candidates: [] };
    });
    return { sapId: this.sapId, sapVersionId: `sv-${version}`, version, datasetId: STUB_DATASET_ID, ingestionId: STUB_INGESTION_ID,
      fields, columns: STUB_COLUMNS, conformance: { status: 'pass', findings: [], engineVersion: 'e2e-stub' } };
  }

  /** `crp_mg_l` must be bound to the continuous field; anything else is a role_mismatch BLOCK. */
  private confirm(version: number, body: any) {
    const fields = this.specFields(version);
    const findings = body.mapping.flatMap((m: any) => {
      const field = fields.find((f) => f.fieldId === m.fieldId);
      const numeric = m.column === 'crp_mg_l';
      if (!field || (field.semanticRole === 'continuous') === numeric) return [];
      return [{ code: 'role_mismatch', severity: 'block', fieldId: m.fieldId, column: m.column, message: `${m.column} does not match ${field.name}'s declared role.` }];
    });
    const record = {
      dataBindingId: this.id('binding'), sapId: this.sapId, sapVersionId: `sv-${version}`, version, datasetId: STUB_DATASET_ID,
      ingestionId: body.datasetVersionId, mapping: body.mapping, unmapped: [], declarationRevision: null, profileHash: null,
      conformance: { status: findings.length ? 'fail' : 'pass', findings, engineVersion: 'e2e-stub' },
      confirmedByUserId: this.userId, confirmedAt: this.now(), bindingHash: 'b'.repeat(64),
    };
    this.bindings.push(record);
    return record;
  }

  private run(body: any) {
    return {
      sapRunId: 'run-e2e-2569', projectId: this.projectId, sapId: this.sapId, sapVersionId: `sv-${body.version}`,
      datasetVersionId: body.datasetVersionId, classification: 'planned_final_look', status: 'running',
      startedByUserId: this.userId, startedAt: this.now(), completedAt: null, viewAnalysisId: 'va-e2e', engineVersion: null,
      clientRequestId: body.clientRequestId ?? 'x', questions: [], replayed: false,
    };
  }
}
