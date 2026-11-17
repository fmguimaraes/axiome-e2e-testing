/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Page, Route } from '@playwright/test';

/**
 * AXI-2588 (epic AXI-2567) — an in-memory double of the SAP API for ONE project holding an open
 * v1 draft with two questions, installed with `page.route`. It answers the reads the
 * investigator Statistical plan page makes and the question DELETE the new trash button sends
 * (`DELETE …/draft/questions/:id?basedOnRevision=n`), recording every write.
 *
 * Sign-in, the workspace, the project, the membership and the caller's permissions stay REAL
 * (demo gateway + demo DB, where the AXI-2588 migration granted the Investigator the three
 * question rights). `withoutQuestionRights` narrows the REAL `/workspace-permissions/me` answer
 * (fetched, then filtered) to model a role that holds `sap:update` but none of the question rights.
 */

export interface StubWrite { method: string; path: string; search: string }

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

function v1Question(n: number, role: 'primary' | 'secondary', text: string) {
  return {
    questionId: `88888888-8888-4888-8888-00000000000${n}`,
    text, role, position: n,
    estimand: { population: 'p', variable: 'v', intercurrentEvents: 'i', populationSummary: 's', treatmentComparison: 't' },
    template: { templateId: 'T1', templateVersion: '1.0.0' },
    bindings: [],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

export const Q1_TEXT = 'Does CRP fall by week 12?';
export const Q2_TEXT = 'Does ESR fall by week 12?';

export class QuestionRightsStub {
  readonly writes: StubWrite[] = [];
  private readonly sapId = 'sap-e2e-2588';
  private readonly draft: any;

  constructor(private readonly projectId: string, userId: string) {
    const now = new Date().toISOString();
    this.draft = {
      draftId: 'draft-e2e-2588', sapId: this.sapId, projectId, revision: 3, basedOnVersion: null,
      title: 'CRP plan', questionText: 'Does CRP fall?', planText: '',
      updatedBy: userId, createdAt: now, updatedAt: now,
      plan: { schemaVersion: 1, analysisDatasetId: null, questions: [v1Question(1, 'primary', Q1_TEXT), v1Question(2, 'secondary', Q2_TEXT)] },
    };
  }

  get questions(): any[] { return this.draft.plan.questions; }
  questionId(n: 1 | 2): string { return `88888888-8888-4888-8888-00000000000${n}`; }

  writesTo(method: string, suffix: string): StubWrite[] {
    return this.writes.filter((w) => w.method === method && w.path.endsWith(suffix));
  }

  async install(page: Page): Promise<void> {
    await page.route((url) => url.pathname.includes(`/projects/${this.projectId}/sap`), (route) => this.handle(route));
  }

  /** Narrow the caller's REAL permission set: drop every `sap:question_*` right. */
  static async withoutQuestionRights(page: Page): Promise<void> {
    await page.route((url) => url.pathname.endsWith('/workspace-permissions/me'), async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      body.permissions = (body.permissions as string[]).filter((p) => !p.startsWith('sap:question_'));
      await json(route, real.status(), body);
    });
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/v1/, '');
    const method = req.method();
    if (method !== 'GET') this.writes.push({ method, path, search: url.search });
    const answer = this.answer(method, path);
    if (!answer) return route.continue();
    return json(route, answer[0], answer[1]);
  }

  private answer(method: string, path: string): [number, unknown] | null {
    const base = `/projects/${this.projectId}`;
    const sap = `${base}/saps/${this.sapId}`;
    const key = `${method} ${path.replace(sap, '<sap>').replace(base, '<p>')}`;
    if (key === 'GET <p>/saps') return [200, { data: [], meta: { total: 0 } }];
    if (key === 'GET <p>/sap-draft' || key === 'GET <sap>/draft') return [200, this.draft];
    if (key === 'GET <p>/sap-templates') return [200, []];
    if (key === 'GET <sap>/versions') return [200, []];
    if (key.startsWith('DELETE <sap>/draft/questions/')) return [200, this.remove(path.split('/').pop() as string)];
    if (key === 'GET <sap>/draft/completeness') return [200, { engineVersion: 'e2e-stub', results: [] }];
    if (key === 'GET <sap>/runs') return [200, { data: [], meta: { total: 0, page: 1, limit: 50 } }];
    return null;
  }

  private remove(questionId: string) {
    this.draft.plan.questions = this.questions.filter((q) => q.questionId !== questionId)
      .map((q, i) => ({ ...q, position: i + 1 }));
    this.draft.revision += 1;
    this.draft.updatedAt = new Date().toISOString();
    return this.draft;
  }
}
