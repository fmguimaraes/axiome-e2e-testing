import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';
import { inReviewRule, ReviewWorld } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1764 (epic AXI-1762 — FR8/FR9/FR10/FR14): the merged rule status ladder
 * (`draft -> checked -> in_review -> published -> deprecated -> archived`)
 * and the automated FR9 checked gate.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §7.
 *
 * Every rule is created at `scope: 'system'` with the admin caller (the same
 * `adminApiContext()` fixture AXI-1236's Safe Compare specs use) so no
 * workspace has to be stood up — `assertCanMutateRule` requires platform
 * admin for a system-scope rule, which the admin role already is.
 */

interface RuleCheck {
  id: string;
  passed: boolean;
  message: string;
}

interface RuleResponse {
  id: string;
  status: string;
  checks?: RuleCheck[];
  [key: string]: unknown;
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await adminApiContext();
});

test.afterAll(async () => {
  await api.dispose();
});

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

const COMPLETE_GUIDANCE = {
  whatItDoes: 'Counts rows per group.',
  whenToUse: 'Use when you need a per-group tally.',
  whenNotToUse: 'Do not use for continuous outcomes.',
  example: 'Ten rows per site.',
  youWillGet: 'A bar chart of counts.',
};

async function createFeatureRule(overrides: Record<string, unknown> = {}): Promise<RuleResponse> {
  const res = await api.post(apiUrl('/api/v1/rules'), {
    data: {
      code: uniqueCode('AXI-1764'),
      title: 'AXI-1764 status ladder fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      scope: 'system',
      signals: ['marker:cd4_count'],
      ...overrides,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as RuleResponse;
}

test.describe('AXI-1764 — merged rule status ladder and the checked gate', () => {
  // §7.3.1 (AC8, EC1, FR9)
  test('AC8 EC1 — a rule with incomplete guidance/fields stays draft; completing it reaches checked automatically @SI-017', async () => {
    const created = await createFeatureRule();
    expect(created.status).toBe('draft');
    expect(Array.isArray(created.checks)).toBe(true);
    // `CreateRuleDto` carries no `outputFields` (rule-library.md §1.4), so
    // `field_help_complete` passes VACUOUSLY (no fields to check) and it is
    // `protocol_compliance` — FEATURE_RULE's required `feature_name`/`value`
    // output fields are declared nowhere yet — that fails alongside guidance.
    const failing = (created.checks ?? []).filter((c) => !c.passed).map((c) => c.id);
    expect(failing).toEqual(expect.arrayContaining(['guidance_complete', 'protocol_compliance']));

    const completed = await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
      data: {
        outputFields: [
          { key: 'feature_name', type: 'string', description: 'Name of the computed feature.' },
          { key: 'value', type: 'number', description: 'The computed feature value.' },
        ],
        guidance: COMPLETE_GUIDANCE,
      },
    });
    expect(completed.status(), await completed.text()).toBe(200);
    const completedBody = (await completed.json()) as RuleResponse;
    expect(completedBody.status).toBe('checked');
    expect((completedBody.checks ?? []).every((c) => c.passed)).toBe(true);

    // Breaking a previously-passing check on a subsequent edit returns the
    // rule to `draft` — FR9's "any later edit that makes a check fail" clause.
    const broken = await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
      data: {
        outputFields: [
          { key: 'feature_name', type: 'string', description: '' },
          { key: 'value', type: 'number', description: 'The computed feature value.' },
        ],
      },
    });
    expect(broken.status(), await broken.text()).toBe(200);
    const brokenBody = (await broken.json()) as RuleResponse;
    expect(brokenBody.status).toBe('draft');
  });

  // §7.3.2 (FR10)
  test('FR10 — the author submits a checked rule for review; every other status refuses @SI-017', async () => {
    const created = await createFeatureRule();
    const checked = await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
      data: {
        outputFields: [
          { key: 'feature_name', type: 'string', description: 'Name of the computed feature.' },
          { key: 'value', type: 'number', description: 'The computed feature value.' },
        ],
        guidance: COMPLETE_GUIDANCE,
      },
    });
    const checkedBody = (await checked.json()) as RuleResponse;
    expect(checkedBody.status).toBe('checked');

    const submitted = await api.post(apiUrl(`/api/v1/rules/${created.id}/submit-for-review`));
    expect(submitted.status(), await submitted.text()).toBe(201);
    const submittedBody = (await submitted.json()) as RuleResponse;
    expect(submittedBody.status).toBe('in_review');

    // Already in_review — refuses.
    const again = await api.post(apiUrl(`/api/v1/rules/${created.id}/submit-for-review`));
    expect(again.status()).toBe(400);

    // A fresh draft — refuses too.
    const draftRule = await createFeatureRule();
    const draftAttempt = await api.post(apiUrl(`/api/v1/rules/${draftRule.id}/submit-for-review`));
    expect(draftAttempt.status()).toBe(400);
  });

  // §7.3.3 (EC11)
  test('EC11 — an in_review rule refuses definition/guidance edits outright @SI-017', async () => {
    const created = await createFeatureRule();
    await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
      data: {
        outputFields: [
          { key: 'feature_name', type: 'string', description: 'Name of the computed feature.' },
          { key: 'value', type: 'number', description: 'The computed feature value.' },
        ],
        guidance: COMPLETE_GUIDANCE,
      },
    });
    await api.post(apiUrl(`/api/v1/rules/${created.id}/submit-for-review`));

    const refused = await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
      data: { title: 'A new title while in_review' },
    });
    expect(refused.status()).toBe(400);

    const stillInReview = await api.get(apiUrl(`/api/v1/rules/${created.id}`));
    expect(((await stillInReview.json()) as RuleResponse).status).toBe('in_review');
  });

  // §7.3.4 (AC12, EC2, FR14)
  test('AC12 EC2 — editing a published rule forks a new draft version; the published version keeps serving @SI-017', async () => {
    // AXI-1765 closed AXI-1764's compat window: publishing is now an APPROVAL
    // of an in_review rule by a `rule:publish` holder (manual-e2e §8). The rule
    // is therefore authored in a fresh workspace by a throwaway author and
    // approved by a throwaway reviewer — the admin holds no assigned
    // `rule:publish` and must not be granted one by a test.
    const world = await ReviewWorld.create();
    try {
      const author = await world.actor('fork-author', await world.role('fork-reader', ['rule:read']));
      const reviewer = await world.actor(
        'fork-reviewer',
        await world.role('fork-publisher', ['rule:read', 'rule:publish']),
      );
      const ws = await world.workspace('fork', [author, reviewer]);
      const api = author.api;
      const created = await inReviewRule(api, { scope: 'workspace', workspaceId: ws }, {
        title: 'AXI-1764 status ladder fixture',
      });

      const published = await reviewer.api.post(apiUrl(`/api/v1/rules/${created.id}/approve`), {
        data: { note: 'AXI-1764 fork fixture approval' },
      });
      expect(published.status(), await published.text()).toBe(201);
      const publishedBody = (await published.json()) as RuleResponse;
      expect(publishedBody.status).toBe('published');

      const versionsBeforeEdit = await api.get(apiUrl(`/api/v1/rules/${created.id}/versions`));
      const versionsBeforeBody = (await versionsBeforeEdit.json()) as Array<{ status: string }>;
      expect(versionsBeforeBody.filter((v) => v.status === 'published')).toHaveLength(1);

      const edited = await api.patch(apiUrl(`/api/v1/rules/${created.id}`), {
        data: { title: 'A widened title, forking the published rule' },
      });
      expect(edited.status(), await edited.text()).toBe(200);
      const editedBody = (await edited.json()) as RuleResponse;
      expect(['draft', 'checked']).toContain(editedBody.status);

      const versionsAfterEdit = await api.get(apiUrl(`/api/v1/rules/${created.id}/versions`));
      const versionsAfterBody = (await versionsAfterEdit.json()) as Array<{ status: string; version: number }>;
      // The original published version row is untouched...
      expect(versionsAfterBody.filter((v) => v.status === 'published')).toHaveLength(1);
      // ...and a new draft version row marks the fork.
      expect(versionsAfterBody.filter((v) => v.status === 'draft').length).toBeGreaterThanOrEqual(1);

      const live = await api.get(apiUrl(`/api/v1/rules/${created.id}`));
      const liveBody = (await live.json()) as RuleResponse;
      expect(liveBody.title).toBe('A widened title, forking the published rule');

      // Version numbers stay unique per rule — the fork row is a NEW version,
      // never a second row at the published version's number.
      const versionNumbers = (versionsAfterBody as Array<{ version: number }>).map((v) => v.version);
      expect(new Set(versionNumbers).size).toBe(versionNumbers.length);
      const publishedVersion = (versionsAfterBody as Array<{ status: string; version: number }>).find(
        (v) => v.status === 'published',
      )!.version;
      const forkVersion = Math.max(
        ...(versionsAfterBody as Array<{ status: string; version: number }>)
          .filter((v) => v.status === 'draft')
          .map((v) => v.version),
      );
      expect(forkVersion).toBeGreaterThan(publishedVersion);

      // AXI-1764 rework (EC2, AC12, D1): the published version KEEPS SERVING —
      // every picker asks `GET /rules?status=published`, and the forked rule must
      // still be listed there, as `published`, with the PUBLISHED title — never
      // the unapproved draft edit.
      const served = await api.get(
        apiUrl(`/api/v1/rules?status=published&search=${encodeURIComponent(String(created.code))}&limit=50`),
      );
      expect(served.status(), await served.text()).toBe(200);
      const servedBody = (await served.json()) as { data?: RuleResponse[]; rules?: RuleResponse[] } | RuleResponse[];
      const servedRows = Array.isArray(servedBody) ? servedBody : servedBody.data ?? servedBody.rules ?? [];
      const servedRule = servedRows.find((r) => r.id === created.id);
      expect(servedRule, 'the forked rule must still be served under status=published').toBeDefined();
      expect(servedRule!.status).toBe('published');
      expect(servedRule!.title).toBe('AXI-1764 status ladder fixture');
      expect(servedRule!.version).toBe(publishedVersion);

      // ...and the author's own editing line is still visible under its live status.
      const editing = await api.get(
        apiUrl(`/api/v1/rules?status=${editedBody.status}&search=${encodeURIComponent(String(created.code))}&limit=50`),
      );
      const editingBody = (await editing.json()) as { data?: RuleResponse[]; rules?: RuleResponse[] } | RuleResponse[];
      const editingRows = Array.isArray(editingBody) ? editingBody : editingBody.data ?? editingBody.rules ?? [];
      expect(editingRows.find((r) => r.id === created.id)?.title).toBe('A widened title, forking the published rule');
    } finally {
      await world.dispose();
    }
  });
});
