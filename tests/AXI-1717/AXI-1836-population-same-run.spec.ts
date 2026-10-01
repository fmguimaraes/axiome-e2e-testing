import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant, ensureProject, ingestFixture, ensureDefaultAnalysis, type Tenant } from '../AXI-1507/harness/seed';
import { primeWorkspace, type Seeded } from './harness/live-workbench';

/**
 * AXI-1836 (epic AXI-1717) — the `population-same-run` question, and the
 * `stack` composition that gates it, had NO covering spec (`grep -rn
 * "population-same-run" tests/` returned nothing before this story) and
 * `driveToSplit` answered nothing, so a `stack` composition deadlocked the
 * harness's `population-confirm` wait forever.
 *
 * Scope ruling (AXI-1836): `population-same-run` IS in scope — the merge
 * classification it gates (`mergePreview`, `axiome-front`
 * `src/lib/discoveryWorkbench/population.ts`) is core AXI-1719 Population
 * node behaviour, not a dead branch, and the fail-fast guard this story adds
 * to `seedLiveWorkbench` means a `stack` composition can now only be reached
 * deliberately (as this spec does), never by accident. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md`.
 *
 * REAL BACKEND, LLM-FREE: two project-linked datasets, no discovery plan
 * instantiated — the AXI-1719 PREVIEW path (`analysisId` null), which is all
 * `usePopulation`/`mergePreview` need.
 */

const STACK_A = 'riaz2017_stack_a.csv';
const STACK_B = 'riaz2017_stack_b.csv';

async function seedStackedPopulation(label: string): Promise<{ api: Api; t: Tenant; projectId: string }> {
  const api = await adminApi();
  const t = await ensureTenant(api);
  const projectId = await ensureProject(api, t, `AXI-1836 Population Stack ${label}`);
  // Two datasets sharing the same columns with DISJOINT subject ids (a stratified
  // split of the Riaz fixture) — `mergePreview` classifies this `stack`, never
  // `single` (one dataset) or `blocked` (an overlapping subject).
  const datasetIdA = await ingestFixture(api, t, STACK_A);
  const datasetIdB = await ingestFixture(api, t, STACK_B);
  await ensureDefaultAnalysis(api, t, projectId, datasetIdA);
  await ensureDefaultAnalysis(api, t, projectId, datasetIdB);
  return { api, t, projectId };
}

test.describe('AXI-1836 - the population-same-run question gates a stacked composition (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let seeded: { api: Api; t: Tenant; projectId: string };

  test.beforeAll(async () => {
    seeded = await seedStackedPopulation(`${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await seeded?.api.ctx.dispose(); });

  test('AC1 - two linked datasets with disjoint subjects render Stacked and gate confirm on an answer', async ({ page }) => {
    await primeWorkspace(page, { t: seeded.t } as unknown as Seeded);
    await page.goto(`/projects/${seeded.projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });

    const merge = page.getByTestId('population-merge');
    await expect(merge).toBeVisible({ timeout: 30_000 });
    await expect(merge).toContainText('Stacked');

    const sameRun = page.getByTestId('population-same-run');
    await expect(sameRun).toBeVisible();

    const confirm = page.getByTestId('population-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeDisabled();

    await sameRun.getByRole('button', { name: 'Yes' }).click();
    await expect(sameRun.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(confirm).toBeEnabled({ timeout: 10_000 });

    await confirm.click();
    await expect(page.getByTestId('population-confirmed')).toBeVisible({ timeout: 30_000 });
  });
});
