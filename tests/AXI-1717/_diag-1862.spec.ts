import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, driveToScreen, MEASUREMENTS } from './harness/live-workbench';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';

const SCREEN_OP = 'stats.screen_shortlist';

test('AXI-1862 diagnosis: manual measurement selection enables Run rule', async ({ page }) => {
  const s = await seedLiveWorkbench(`AXI-1862-diag3-${Date.now()}`, `AXI-1862-diag3-${Date.now()}`);
  const screenRuleCode = (await approveCarriersFor([SCREEN_OP]))[SCREEN_OP].code;

  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [s.t.workspaceId, s.t.orgId] as const);

  const calls: string[] = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/rule-runs/preflight') || url.includes('/rule-runs/resolve')) {
      let body = '';
      try { body = await res.text(); } catch { body = '<unreadable>'; }
      calls.push(`${res.status()} ${url}\n${body.slice(0, 3000)}`);
    }
  });

  await driveToScreen(page, s.projectId, s.viewAnalysisId);
  await page.getByTestId('screen-choose-rule').click();
  await page.getByTestId(`screen-rule-run-${screenRuleCode}`).click();

  const dialog = page.getByRole('dialog', { name: /^Configure / });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3_000);

  for (const col of MEASUREMENTS) {
    const box = dialog.getByRole('checkbox', { name: col });
    if (await box.count()) await box.check();
  }

  await page.waitForTimeout(3_000);
  console.log('=== CALLS ===');
  for (const c of calls) console.log(c, '\n---');
  console.log('=== DIALOG TEXT ===');
  console.log(await dialog.innerText());
});
