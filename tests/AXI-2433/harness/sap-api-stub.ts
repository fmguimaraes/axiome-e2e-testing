import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import type { PrivateProjectsWorld } from '../../AXI-2265/private-projects-fixtures';

/**
 * AXI-2445 / AXI-2447 (epic AXI-2433) — SAP fixtures on the REAL stack. Nothing is doubled any
 * more: AXI-2438 (draft + question routes) and AXI-2439 (completeness, finalise / amend,
 * `GET …/sap-templates`, version reads) are both deployed, so every seed goes through the gateway
 * and the page talks to the gateway unrouted. AXI-2447 removed the AXI-2445 doubles (finalise,
 * completeness, templates, the version overlay); the class keeps its name so the specs read alike.
 *
 * A real finalise runs the server's completeness checks, which read the dataset's PROFILED
 * columns (CC4): seeds use `uploadArmScoreDataset` (a two-level `arm`, a numeric `score`) and
 * `questionInput` binds T1 to them, and `seedFinal` waits (bounded) for the profile.
 */

export interface StubQuestionInput {
  text: string;
  role: 'primary' | 'key_secondary' | 'secondary' | 'exploratory';
  estimand: Record<string, string>;
  template: { templateId: string; templateVersion: string };
  bindings: Array<{ slot: string; column: string; semanticRole: string }>;
  parameters: { alpha: number; sidedness: string; [key: string]: unknown };
  decisionCriterion: { kind: 'p_at_or_below_alpha'; direction?: 'positive' | 'negative' };
  sensitivityAnalyses: unknown[];
}

/**
 * T1's newest published version on the live registry. Read once per run by {@link pinNewestT1} —
 * never hard-coded: the registry moves (0.2 → 0.3 landed mid-epic), and a seeded question must pin
 * the version the wizard itself pins (the newest).
 */
export let t1Version = '0.2';

export async function pinNewestT1(call: ApiCall, projectId: string): Promise<string> {
  const res = await call('GET', `/projects/${projectId}/sap-templates`);
  const newest = (res.body as Array<{ templateId: string; templateVersion: string; isNewest: boolean }>)
    .find((t) => t.templateId === 'T1' && t.isNewest);
  if (!newest) throw new Error(`no newest T1 in the catalogue (${res.status})`);
  t1Version = newest.templateVersion;
  return t1Version;
}

/** A complete client-authored T1 question on the arm/score dataset (no `questionId` / `position`). */
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
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
    ...overrides,
  };
}

/** `subject_id,arm,score` — 12 rows, `arm` A/B, `score` numeric: what T1's guards bind. */
export async function uploadArmScoreDataset(world: PrivateProjectsWorld, api: APIRequestContext, label = 'sap'): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `${label}-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset, presignedUrl } = await init.json();
  const rows = Array.from({ length: 12 }, (_, i) => `S${i + 1},${i % 2 === 0 ? 'A' : 'B'},${(i * 1.7 + 3).toFixed(1)}`);
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: `subject_id,arm,score\n${rows.join('\n')}\n` });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await api.patch(`${datasets}/${dataset.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return dataset.id;
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

/** One write the page sent, for body assertions. */
export interface StubWrite {
  method: string;
  path: string;
  body: unknown;
}

const PROFILE_WAIT_MS = 120_000;

export class SapApiStub {
  /** Every non-GET request the PAGE sent to this project's SAP routes (`/sap…`), in order. */
  readonly pageWrites: StubWrite[] = [];

  constructor(readonly projectId: string, readonly userId: string, readonly datasetId: string) {}

  private get base() { return `/projects/${this.projectId}`; }

  /** The finalise requests the page sent. */
  get writes(): StubWrite[] {
    return this.pageWrites.filter((w) => /\/draft\/finalise$/.test(w.path));
  }

  // ─── Setup through the real API (no page) ──────────────────────────────────

  /** Start the real draft (an amendment copy when a version exists), add `questions`, then set `title` (if any). */
  async seedDraft(call: ApiCall, questions: StubQuestionInput[], title?: string): Promise<any> {
    let draft = expectStatus(await call('POST', `${this.base}/saps/draft`, {}), 201, 'start draft');
    draft = await this.addQuestions(call, draft, questions);
    if (title !== undefined) {
      draft = expectStatus(await call('PUT', `${this.base}/saps/${draft.sapId}/draft`, { basedOnRevision: draft.revision, title }), 200, 'save title');
    }
    return draft;
  }

  /** A real final version: version 1 from `questions`, or (when one exists) an amendment retitled `title`. */
  async seedFinal(call: ApiCall, title: string, questions: StubQuestionInput[], amendmentReason: string | null = null): Promise<any> {
    const head = await this.headVersion(call);
    const draft = await this.seedDraft(call, head ? [] : questions, title);
    await this.waitComplete(call, draft.sapId);
    const body = { basedOnRevision: draft.revision, basedOnVersion: draft.basedOnVersion ?? null, ...(head ? { amendmentReason: amendmentReason ?? 'e2e amendment' } : {}) };
    return expectStatus(await call('POST', `${this.base}/saps/${draft.sapId}/draft/finalise`, body), 201, 'finalise');
  }

  /** Open an amendment draft of the latest version (the server copies it). */
  async seedAmendment(call: ApiCall): Promise<any> {
    return expectStatus(await call('POST', `${this.base}/saps/draft`, {}), 201, 'start amendment');
  }

  private async headVersion(call: ApiCall): Promise<number> {
    const list = expectStatus(await call('GET', `${this.base}/saps`), 200, 'list saps');
    return Math.max(0, ...((list.data ?? list) as Array<{ version: number }>).map((v) => v.version));
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

  /** Completeness reads the dataset's profile (CC4): wait until every check passes. */
  private async waitComplete(call: ApiCall, sapId: string): Promise<void> {
    await expect.poll(async () => {
      const report = expectStatus(await call('GET', `${this.base}/saps/${sapId}/draft/completeness`), 200, 'completeness');
      return report.results.filter((r: { status: string }) => r.status === 'fail').map((r: { checkId: string; message: string }) => `${r.checkId}: ${r.message}`);
    }, { timeout: PROFILE_WAIT_MS, intervals: [2_000, 5_000] }).toEqual([]);
  }

  // ─── Page observation (never routing) ──────────────────────────────────────

  async install(page: Page): Promise<void> {
    const prefix = `/api/v1${this.base}/sap`;
    page.on('request', (r) => {
      const url = new URL(r.url());
      if (!url.pathname.startsWith(prefix) || r.method() === 'GET' || r.method() === 'OPTIONS') return;
      this.pageWrites.push({ method: r.method(), path: `${url.pathname.slice(`/api/v1${this.base}`.length)}${url.search}`, body: r.postDataJSON() ?? undefined });
    });
  }
}
