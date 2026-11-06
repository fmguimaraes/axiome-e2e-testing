import { randomUUID } from 'crypto';
import type { APIRequestContext, Page, Request, Route } from '@playwright/test';
import { apiUrl } from '../../../config/env';

/**
 * AXI-2445 (epic AXI-2433) — the narrowest test double the Plan tab still needs.
 *
 * REAL (AXI-2438, on the stack): start / read / save / discard the draft, add / edit / reorder /
 * remove questions, the project-scoped `GET …/sap-draft`, and the version reads.
 *
 * DOUBLED (AXI-2439, not on main yet), and only for ONE project:
 *  - `GET …/saps/:sapId/draft/completeness` — computed from the REAL draft (read through the API);
 *    only CC1, CC13 and CC14 are implemented (the checks the scenarios drive). Not SI-071.
 *  - `POST …/saps/:sapId/draft/finalise` — records a final version built from the REAL draft and
 *    discards the real draft (finalising consumes it).
 *  - `GET …/sap-templates` — the newest version per template (EC10).
 *  - Because nothing real can mint a final version before AXI-2439, the version READS
 *    (`GET …/saps`, `GET …/saps/:sapId/versions`) are overlaid with the recorded versions once the
 *    double holds one, and an Amend (`POST …/saps/draft` while a version exists) copies the latest
 *    version into the real draft through the real question API — what AXI-2439's start-from-final
 *    will do server-side — and reports `basedOnVersion` on the draft reads.
 *
 * Drop this double once AXI-2439 is deployed: no assertion of the spec depends on it.
 */

export interface StubQuestionInput {
  text: string;
  role: 'primary' | 'key_secondary' | 'secondary' | 'exploratory';
  estimand: Record<string, string>;
  template: { templateId: string; templateVersion: string };
  bindings: Array<{ slot: string; column: string; semanticRole: string }>;
  parameters: { alpha: number; sidedness: string };
  decisionCriterion: { kind: 'p_at_or_below_alpha'; direction?: 'positive' | 'negative' };
  sensitivityAnalyses: unknown[];
}

/** A client-authored question (no `questionId` / `position` — server facts). */
export function questionInput(n: number, role: StubQuestionInput['role'] = 'primary', overrides: Partial<StubQuestionInput> = {}): StubQuestionInput {
  return {
    text: `Does marker ${n} differ between arms?`,
    role,
    estimand: {
      population: 'All randomised subjects',
      variable: `marker ${n}`,
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Arm A vs arm B',
    },
    template: { templateId: 'T1', templateVersion: '0.2' },
    bindings: [{ slot: 'outcome', column: 'value', semanticRole: 'measurement' }],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
    ...overrides,
  };
}

/** `(method, path under /api/v1, body?) → {status, body}` against the real gateway. */
export type ApiCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export function apiCallOf(ctx: APIRequestContext, headers: Record<string, string> = {}): ApiCall {
  return async (method, path, body) => {
    const res = await ctx.fetch(apiUrl(`/api/v1${path}`), { method, headers, ...(body === undefined ? {} : { data: body }) });
    const text = await res.text();
    return { status: res.status(), body: text ? JSON.parse(text) : null };
  };
}

function expectStatus(res: { status: number; body: any }, status: number, what: string): any {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** One write the double answered (finalise), for body assertions. */
export interface StubWrite {
  method: string;
  path: string;
  body: unknown;
}

export class SapApiStub {
  /** Final versions the doubled finalise recorded, ascending. */
  versions: any[] = [];
  /** The version the open (real) draft was copied from, while an amendment is open. */
  amendBase: number | null = null;
  newestTemplates: Record<string, string> = { T1: '0.2' };
  /** Writes the double answered itself (finalise). */
  readonly writes: StubWrite[] = [];
  /** Every non-GET request the PAGE sent to this project's SAP routes (real or doubled). */
  readonly pageWrites: StubWrite[] = [];

  constructor(readonly projectId: string, readonly userId: string, readonly datasetId: string) {}

  private get base() { return `/projects/${this.projectId}`; }

  // ─── Setup through the real API (no page) ──────────────────────────────────

  /** Start the real draft, add `questions`, then set `title` (if any). Returns the draft. */
  async seedDraft(call: ApiCall, questions: StubQuestionInput[], title?: string): Promise<any> {
    let draft = expectStatus(await call('POST', `${this.base}/saps/draft`, {}), 201, 'start draft');
    draft = await this.addQuestions(call, draft, questions);
    if (title !== undefined) {
      draft = expectStatus(await call('PUT', `${this.base}/saps/${draft.sapId}/draft`, { basedOnRevision: draft.revision, title }), 200, 'save title');
    }
    return draft;
  }

  /** A final version through the real draft + the doubled finalise (an amendment when one exists). */
  async seedFinal(call: ApiCall, title: string, questions: StubQuestionInput[], amendmentReason: string | null = null): Promise<any> {
    if (this.versions.length) {
      const draft = await this.startAmendment(call, call);
      expectStatus(await call('PUT', `${this.base}/saps/${draft.sapId}/draft`, { basedOnRevision: draft.revision, title }), 200, 'save title');
      return this.finaliseReal(call, draft.sapId, amendmentReason);
    }
    const draft = await this.seedDraft(call, questions, title);
    return this.finaliseReal(call, draft.sapId, amendmentReason);
  }

  /** Open an amendment draft of the latest version (real draft, copied content). */
  async seedAmendment(call: ApiCall): Promise<any> {
    return this.startAmendment(call, call);
  }

  private async addQuestions(call: ApiCall, start: any, questions: StubQuestionInput[]): Promise<any> {
    let draft = start;
    for (const q of questions) {
      draft = expectStatus(await call('POST', `${this.base}/saps/${draft.sapId}/draft/questions`, {
        basedOnRevision: draft.revision, analysisDatasetId: this.datasetId, question: q,
      }), 201, 'add question');
    }
    return draft;
  }

  /** Real start, then the latest version's text and questions copied in (what AXI-2439 will do). */
  private async startAmendment(call: ApiCall, startCall: ApiCall): Promise<any> {
    const latest = this.versions[this.versions.length - 1];
    let draft = expectStatus(await startCall('POST', `${this.base}/saps/draft`, {}), 201, 'start amendment');
    draft = expectStatus(await call('PUT', `${this.base}/saps/${draft.sapId}/draft`, {
      basedOnRevision: draft.revision, title: latest.title, questionText: latest.questionText, planText: latest.planText,
    }), 200, 'copy text');
    const inputs = latest.plan.questions.map(({ questionId: _id, position: _pos, ...rest }: any) => rest as StubQuestionInput);
    draft = await this.addQuestions(call, draft, inputs);
    this.amendBase = latest.version;
    return { ...draft, basedOnVersion: latest.version };
  }

  private async finaliseReal(call: ApiCall, sapId: string, amendmentReason: string | null): Promise<any> {
    const draft = expectStatus(await call('GET', `${this.base}/saps/${sapId}/draft`), 200, 'read draft');
    const n = this.versions.length + 1;
    const previous = this.versions[this.versions.length - 1] ?? null;
    const now = new Date().toISOString();
    const v = {
      id: sapId, sapVersionId: randomUUID(), projectId: this.projectId, version: n, authorUserId: this.userId,
      contentHash: `${n}a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80`.slice(0, 64),
      createdAt: now, updatedAt: now, supersededBy: null,
      title: draft.title, questionText: draft.questionText, planText: draft.planText, linkedMethods: [], status: 'final',
      plan: draft.plan, analysisDatasetId: draft.plan.analysisDatasetId,
      finalisedAt: now, finalisedByUserId: this.userId, amendmentReason, contentHashVersion: 2,
    };
    expectStatus(await call('DELETE', `${this.base}/saps/${sapId}/draft?basedOnRevision=${draft.revision}`), 204, 'consume draft');
    if (previous) previous.supersededBy = v.sapVersionId;
    this.versions.push(v);
    this.amendBase = null;
    return v;
  }

  // ─── Completeness double (CC1, CC13, CC14 only) ────────────────────────────

  private completenessOf(d: any) {
    const qs = d.plan.questions as Array<{ role: string }>;
    return {
      engineVersion: 'e2e-double',
      results: [
        qs.some((q) => q.role === 'primary')
          ? { checkId: 'CC1', status: 'pass', message: 'A primary question exists.', ruleRef: 'RULE-SAP-ACTA-OUTCOME-HIERARCHY-DECLARED' }
          : { checkId: 'CC1', status: 'fail', message: 'No question has role primary.', ruleRef: 'RULE-SAP-ACTA-OUTCOME-HIERARCHY-DECLARED' },
        qs.length >= 1 && qs.length <= 50
          ? { checkId: 'CC13', status: 'pass', message: 'ok', ruleRef: 'SAP-PLATFORM-STRUCTURAL-CONSTRAINT' }
          : { checkId: 'CC13', status: 'fail', message: `The plan has ${qs.length} questions.`, ruleRef: 'SAP-PLATFORM-STRUCTURAL-CONSTRAINT' },
        String(d.title).trim()
          ? { checkId: 'CC14', status: 'pass', message: 'ok', ruleRef: 'SAP-PLATFORM-STRUCTURAL-CONSTRAINT' }
          : { checkId: 'CC14', status: 'fail', field: 'title', message: 'The title is blank.', ruleRef: 'SAP-PLATFORM-STRUCTURAL-CONSTRAINT' },
      ],
    };
  }

  // ─── Page routing ──────────────────────────────────────────────────────────

  async install(page: Page): Promise<void> {
    const prefix = `/api/v1${this.base}/sap`;
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (!path.startsWith(prefix) || r.method() === 'GET' || r.method() === 'OPTIONS') return;
      this.pageWrites.push({ method: r.method(), path: `${path.slice(`/api/v1${this.base}`.length)}${new URL(r.url()).search}`, body: r.postDataJSON() ?? undefined });
    });
    await page.route((url) => url.pathname.startsWith(prefix), (route, request) => this.handle(page, route, request));
  }

  private async handle(page: Page, route: Route, request: Request): Promise<void> {
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url());
    const path = url.pathname.slice(`/api/v1${this.base}`.length);
    const method = request.method();
    const h = request.headers();
    const call = apiCallOf(page.request, { authorization: h['authorization'] ?? '', 'x-workspace-id': h['x-workspace-id'] ?? '' });
    const headers = corsHeaders(request);
    const json = (status: number, payload: unknown) => route.fulfill({ status, json: payload, headers });
    const latest = this.versions[this.versions.length - 1] ?? null;

    if (path === '/sap-templates') {
      return json(200, Object.entries(this.newestTemplates).map(([templateId, templateVersion]) => ({ templateId, templateVersion, isNewest: true })));
    }
    let m = path.match(/^\/saps\/([^/]+)\/draft\/completeness$/);
    if (m && method === 'GET') {
      const real = await call('GET', `${this.base}/saps/${m[1]}/draft`);
      return real.status === 200 ? json(200, this.completenessOf(real.body)) : json(real.status, real.body);
    }
    m = path.match(/^\/saps\/([^/]+)\/draft\/finalise$/);
    if (m && method === 'POST') {
      const body = request.postDataJSON();
      this.writes.push({ method, path, body });
      if (this.amendBase !== null && !body?.amendmentReason) {
        return json(422, { statusCode: 422, message: 'amendmentReason is required', errorCode: 'SAP_CONTENT_INVALID' });
      }
      return json(201, await this.finaliseReal(call, m[1], body?.amendmentReason ?? null));
    }
    if (path === '/saps' && method === 'GET' && latest) return json(200, { data: [latest], meta: { total: 1 } });
    if (/^\/saps\/[^/]+\/versions$/.test(path) && method === 'GET' && latest) return json(200, this.versions);
    if (path === '/saps/draft' && method === 'POST' && latest) {
      const draft = await this.startAmendment(call, async () => {
        const res = await route.fetch();
        const text = await res.text();
        return { status: res.status(), body: text ? JSON.parse(text) : null };
      });
      return json(201, draft);
    }
    // A real draft route: answered by the stack; while an amendment is open, report its base version.
    if (this.amendBase === null) return route.continue();
    const res = await route.fetch();
    if (method === 'DELETE' && /^\/saps\/[^/]+\/draft$/.test(path) && res.status() === 204) this.amendBase = null;
    const text = await res.text();
    if (!text) return route.fulfill({ response: res, headers: { ...res.headers(), ...headers } });
    const payload = JSON.parse(text);
    const overlaid = payload && typeof payload === 'object' && 'revision' in payload ? { ...payload, basedOnVersion: this.amendBase } : payload;
    return route.fulfill({ response: res, json: overlaid, headers: { ...res.headers(), ...headers } });
  }
}

/** The front (5174) calls the gateway (3000) cross-origin: a fulfilled response must carry CORS. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers()['origin'] ?? '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'authorization,content-type,x-workspace-id',
  };
}
