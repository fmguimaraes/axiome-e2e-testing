import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset, SHA256_VERSION_HASH_RE } from './harness/anchor-dataset';
import { buildEnvelope as buildGovernedEnvelope } from '../AXI-1462/harness/governed';
import { buildEnvelope as buildPlannerEnvelope } from '../AXI-1603/harness/planner';
import { workspaceHeader } from '../AXI-1435/harness/api';

/**
 * AXI-1662 (epic AXI-1604 — FR28/FR30, SI-042). The live half of the collapse.
 *
 * AXI-1661 fixed `anchorDataset()` in `tests/AXI-1462/harness/governed.ts`; the
 * near-duplicate in `tests/AXI-1603/harness/planner.ts` never got the fix and
 * kept all four defects (`?? []` columns, the `sha256:unknown` literal, a
 * truthiness availability test that accepted a `pending` upload, and no
 * `categories`). Two copies kept in step by hand is the defect. There is now one
 * resolver, `tests/AXI-1604/harness/anchor-dataset.ts`.
 *
 * `harness-unit/AXI-1604/anchor-dataset.spec.ts` decides the loud-failure and
 * no-second-copy halves offline. THIS spec is the half a unit test cannot give:
 * that both harnesses, against the real stack, build the SAME envelope from the
 * SAME real dataset — the original defect was invisible to types and to a green
 * suite, and only a live response revealed it.
 *
 * Point it at a workspace/project holding a real ingested CSV with
 * `SHADOW_RUN_WORKSPACE_ID` / `SHADOW_RUN_PROJECT_ID` (the same overrides the
 * shadow-run and AXI-1661 specs use; both must be set, or `ensureTenant()`
 * applies and the run skips honestly where that tenant holds no dataset):
 *
 *     SHADOW_RUN_WORKSPACE_ID=... SHADOW_RUN_PROJECT_ID=... \
 *       npx playwright test tests/AXI-1604/AXI-1662-shared-anchor-resolver
 */
test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 });

let api: Api;
let workspaceId: string;
let projectId: string;

test.beforeAll(async () => {
  api = await adminApi();
  const overrideWorkspaceId = process.env.SHADOW_RUN_WORKSPACE_ID;
  const overrideProjectId = process.env.SHADOW_RUN_PROJECT_ID;
  if (overrideWorkspaceId && overrideProjectId) {
    workspaceId = overrideWorkspaceId;
    projectId = overrideProjectId;
    return;
  }
  const t = await ensureTenant(api);
  workspaceId = t.workspaceId;
  projectId = t.projectId;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test(
  'FR28 FR30 — the governed and intent-compiled harnesses build the SAME envelope from the one shared resolver',
  { tag: ['@SI-042'] },
  async () => {
    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no ingested dataset in this workspace — point the run at one with SHADOW_RUN_WORKSPACE_ID/SHADOW_RUN_PROJECT_ID');
    if (!anchor) return;

    const governed = buildGovernedEnvelope(projectId, 'Compare pre_expression between response groups.', [anchor]);
    const planner = buildPlannerEnvelope(projectId, 'Compare pre_expression between response groups.', [anchor]);

    // eslint-disable-next-line no-console
    console.log(`AXI-1462 governed envelope datasets:\n${JSON.stringify(governed.datasets, null, 2)}`);
    // eslint-disable-next-line no-console
    console.log(`AXI-1603 planner envelope datasets:\n${JSON.stringify(planner.datasets, null, 2)}`);

    // One resolver, so one dataset payload — not two shapes that happen to agree.
    expect(planner.datasets).toEqual(governed.datasets);

    for (const envelope of [governed, planner]) {
      const [ds] = envelope.datasets;
      // Real identity: the dataset's own content hash, never a placeholder.
      expect(ds.versionHash).not.toBe('sha256:unknown');
      expect(ds.versionHash).toMatch(SHA256_VERSION_HASH_RE);
      // Real schema: the planner is shown actual column names with semantic types.
      expect(ds.columns.length).toBeGreaterThan(0);
      expect(ds.columns.map((c) => c.type)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(numeric|categorical|identifier|timepoint)$/)]),
      );
      // The category domains the compiled arm validates filter/group values
      // against — the AXI-1603 copy carried none at all.
      expect(
        ds.columns.some((c) => Array.isArray(c.categories) && c.categories.length > 0),
        `at least one categorical column carries its observed domain: ${JSON.stringify(ds.columns)}`,
      ).toBe(true);
      // FR2: the filename lives in `displayName`, the current PlannerDatasetSchema
      // field — not the deprecated legacy `name` both harnesses used to emit.
      expect(ds.displayName).toBeTruthy();
      expect((ds as unknown as Record<string, unknown>).name).toBeUndefined();
    }
  },
);

test(
  'FR28 — the planner accepts the intent-compiled harness envelope and is shown the real schema',
  { tag: ['@SI-042'] },
  async () => {
    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no ingested dataset in this workspace');
    if (!anchor) return;

    const numeric = anchor.columns.find((c) => c.type === 'numeric');
    // A LOW-cardinality categorical: a 24-level gene column would make the
    // question a 24-group comparison, which is legitimately unsupported and
    // would prove nothing about whether the planner saw the schema.
    const categorical = anchor.columns.find(
      (c) => Array.isArray(c.categories) && c.categories.length >= 2 && c.categories.length <= 4,
    );
    test.skip(!numeric || !categorical, 'anchor dataset has no numeric x low-cardinality categorical pair to ask a two-group question about');

    const envelope = buildPlannerEnvelope(
      projectId,
      `Compare ${numeric!.name} between the ${categorical!.categories!.join(' and ')} groups of ${categorical!.name}.`,
      [anchor],
    );
    const res = await api.post(
      '/api/v1/guided-analysis/plan',
      { projectId, envelope, sessionId: null },
      workspaceHeader(workspaceId),
    );

    // eslint-disable-next-line no-console
    console.log(`plan response: status=${res.status} planner=${res.body?.planner} unsupported=${res.body?.intentUnsupported} fallback=${res.body?.plannerFallback} attempts=${res.body?.attemptCount}`);

    expect(res.status, `plan request succeeded: ${JSON.stringify(res.body).slice(0, 500)}`).toBeLessThan(300);
    // The 2026-09-25 run's refusals all read "the dataset schema lists no columns
    // at all". Whatever the planner decides now, it cannot decide it for that reason.
    const reason = JSON.stringify(res.body?.plan?.unsupportedReason ?? res.body?.plan?.reasoning ?? '');
    expect(reason).not.toMatch(/no columns at all/i);
    expect(reason).not.toMatch(/sha256:unknown/);
  },
);
