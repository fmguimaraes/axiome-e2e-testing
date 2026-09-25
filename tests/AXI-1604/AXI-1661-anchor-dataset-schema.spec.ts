import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset, SHA256_VERSION_HASH_RE } from './harness/anchor-dataset';

/**
 * AXI-1661 (epic AXI-1604 — FR28/FR30, SI-042). The live half of the
 * `anchorDataset()` fix.
 *
 * The 2026-09-25 shadow run
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`) asked all 46
 * Grados questions of both planner arms against an envelope carrying
 * `"columns": []` and `versionHash: "sha256:unknown"`, because the harness read
 * the schema off the workspace dataset LIST row, which carries neither, and
 * degraded silently instead of failing. Nothing in the type system or in the
 * suite noticed: the envelope's SHAPE was valid, only its VALUES were empty.
 *
 * So the regression needs both halves, and this is the half a unit test cannot
 * give: `harness-unit/AXI-1462/governed.spec.ts` pins the loud failure against a
 * stubbed API, and THIS spec pins that the real endpoints, against the real
 * stack, actually hand back a real schema. A green unit test alone would have
 * been green before the fix too.
 *
 * Point it at a workspace/project that holds a real ingested dataset with
 * `SHADOW_RUN_WORKSPACE_ID` / `SHADOW_RUN_PROJECT_ID` (the same overrides the
 * shadow-run spec uses; both must be set, or `ensureTenant()` applies):
 *
 *     SHADOW_RUN_WORKSPACE_ID=... SHADOW_RUN_PROJECT_ID=... \
 *       npx playwright test tests/AXI-1604/AXI-1661-anchor-dataset-schema
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
  'FR28 — the anchored envelope carries the dataset\'s real columns and its real sha256 content hash',
  { tag: ['@SI-042'] },
  async () => {
    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no ingested dataset in this workspace — point the run at one with SHADOW_RUN_WORKSPACE_ID/SHADOW_RUN_PROJECT_ID');
    if (!anchor) return;

    // eslint-disable-next-line no-console
    console.log(`anchored envelope fragment:\n${JSON.stringify(anchor, null, 2)}`);

    // The version hash is the dataset's real content hash, never a placeholder.
    expect(anchor.versionHash).not.toBe('sha256:unknown');
    expect(anchor.versionHash).toMatch(SHA256_VERSION_HASH_RE);

    // The planner is shown actual column names — the thing the 2026-09-25 run never was.
    expect(anchor.columns.length).toBeGreaterThan(0);
    for (const column of anchor.columns) {
      expect(column.name, `column name on ${anchor.datasetId}`).toBeTruthy();
      expect(column.type, `type of column "${column.name}"`).toBeTruthy();
    }

    // Types are the profiler's semantic vocabulary (what the product's own
    // envelope carries), not a raw storage type.
    expect(anchor.columns.map((c) => c.type)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(numeric|categorical|identifier|timepoint)$/)]),
    );
  },
);
