import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant, ensureProject, ingestFixture, ensureDefaultAnalysis } from '../AXI-1507/harness/seed';
import { driveToSplit } from './harness/live-workbench';

/**
 * AXI-1863 (epic AXI-1717) — the Stratify partition picker resolves a column
 * to its glossary/semantic LABEL (`StratifyRunConfigModal`'s partition-field
 * chip, via `resolveGlossaryLabel`), but the Split confirmation below it
 * (`SplitNode.tsx`'s `StratificationRule` / `SplitDetailModal`) rendered the
 * raw column name — the picker said "Objective Response" while the
 * confirmation said "response" for the SAME column. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §32. Tag: @SI-047.
 *
 * PREVIEW PATH, real backend — the fix is front-only (`combinedColumnLabel`
 * + `useProjectSemanticLabels`), so this isolates it with a `page.route`
 * mock of `GET /projects/:projectId/semantic-contract` (the same contract
 * BOTH the picker and `SplitNode` now resolve independently), rather than
 * standing up a real semantic-profile assignment + field-mapping match for
 * one fixture dataset — the same isolation precedent `AXI-1806-declared-run-status.spec.ts`
 * documents (mocking the surface under test, not the backend dependency it reads).
 */

const SEMANTIC_CONTRACT = {
  profile: { id: 'oncology', version: '1.0.0', displayName: 'Oncology' },
  canonicalFields: ['response_status', 'patient_id'],
  vocabulary: { response_status: 'Objective Response' },
  filters: [],
  chartPresets: [],
  fieldMappings: [
    { canonicalField: 'response_status', sourceField: 'response', status: 'matched' },
    // The subject-key mapping (`CANONICAL_SUBJECT_KEY`, `compatibilityGate.ts`)
    // the picker's own gate requires before it will even offer a partition field.
    { canonicalField: 'patient_id', sourceField: 'patient_id', status: 'matched' },
  ],
  fallbackMode: false,
  boostedTemplateIds: [],
};

test.describe('AXI-1863 - Stratify picker and Split confirmation agree on a column\'s label (preview, real backend)', { tag: ['@SI-047'] }, () => {
  let api: Api;
  let t: Awaited<ReturnType<typeof ensureTenant>>;
  let projectId: string;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
    projectId = await ensureProject(api, t, 'AXI-1863 Glossary Label Consistency');
    const datasetId = await ingestFixture(api, t, 'riaz2017_immune_wide.csv');
    await ensureDefaultAnalysis(api, t, projectId, datasetId);
  });
  test.afterAll(async () => { await api?.ctx.dispose(); });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    }, [t.workspaceId, t.orgId] as const);
    // Same semantic-contract response for every call this spec's page makes —
    // read by BOTH the picker's own fetch and `useProjectSemanticLabels`.
    await page.route(`**/projects/${projectId}/semantic-contract`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEMANTIC_CONTRACT) }),
    );
  });

  test('AC - the partition-field chip shows the glossary/semantic label, not the raw column name', async ({ page }) => {
    await page.goto(`/projects/${projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    const confirm = page.getByTestId('population-confirm');
    await expect(confirm).toBeEnabled({ timeout: 60_000 });
    await confirm.click();
    await page.getByTestId('population-continue').click();

    const field = page.getByTestId('stratify-partition-field');
    await expect(field).toBeVisible({ timeout: 30_000 });
    // The chip resolves through the SAME semantic-contract mock — it must
    // read "Objective Response", not the raw "response" column name.
    await expect(field.getByRole('radio', { name: 'Objective Response' })).toBeVisible();
    await expect(field.getByRole('radio', { name: 'response', exact: true })).toHaveCount(0);
  });

  test('AC - the Split confirmation (summary and detail modal) renders the SAME combined label the picker used, never the raw column name alone', async ({ page }) => {
    await driveToSplit(page, projectId, null);

    // StratificationRule summary on the Split node.
    const stratification = page.getByTestId('split-stratification');
    await expect(stratification).toContainText('Objective Response (response)');
    await expect(stratification).not.toContainText('response:');

    // SplitDetailModal's "column" row — the second render path this fix touched.
    await page.getByTestId('split-expand').click();
    const modal = page.getByTestId('split-detail-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Objective Response (response)');
  });
});
