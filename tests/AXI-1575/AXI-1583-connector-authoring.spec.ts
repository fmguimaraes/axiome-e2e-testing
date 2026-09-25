import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-1583 (epic AXI-1575 — FR22, FR24, FR24b, FR28; AC10, AC12, AC14):
 * authoring a summary connector in the product, in the browser (@SI-035).
 *
 * The subject is NOT "a connector was created" — a create is one POST and a
 * unit test can prove the body. The subject is the claim the lead ruling makes
 * and only a live screen can falsify: **the form's connector vocabulary is the
 * BACKEND's**. So the spec reads `GET /v1/rules/connectors` itself, then
 * asserts the operation picker offers exactly those operationIds, and that the
 * parameter rows it renders for a chosen operation are exactly that
 * operation's own declared column roles and parameters. A form carrying a
 * hand-maintained copy passes every unit test and fails precisely here.
 *
 * It also pins the SECURITY half (FR28/AC14) at the only place a browser can
 * see it: the listing route refuses an unauthenticated read. The gateway's
 * deny-by-default is proved server-side by the backend's own tests; this is the
 * cheap end-to-end confirmation that nothing in front of it opened the door.
 *
 * SKIPS rather than fails when the stack offers no describe operation or the
 * signed-in account cannot create rules — an unseeded stack is not a
 * regression (the AXI-1565 precedent).
 */
test.describe.configure({ mode: 'serial' });

interface OperationEntry {
  operationId: string;
  label: string;
  parameterScheme: { key: string }[];
  tableInputScheme: { role: string }[];
}

test('AC14 (FR28) — the connector listing refuses an unauthenticated read @SI-035', async ({
  request,
}) => {
  const response = await request.get(`${API_BASE_URL}/api/v1/rules/connectors`, {
    headers: { Authorization: '' },
  });
  expect(response.status(), 'an unauthenticated connector listing must be refused').toBeGreaterThanOrEqual(
    401,
  );
  expect(response.status()).toBeLessThan(500);
});

test('AC10/AC12 (FR22, FR24) — the Create Rule connector form offers exactly the backend vocabulary @SI-035', async ({
  page,
}) => {
  // The page's own read is the source of truth; intercepting it is how the
  // spec learns what the form was OFFERED without restating a catalogue here.
  const listingPromise = page.waitForResponse(
    (response) => response.url().includes('/rules/connectors') && response.status() === 200,
    { timeout: 30_000 },
  );

  await page.goto('/rules/new');
  const summaryCard = page.getByRole('button', { name: /Summary Rule/i });
  test.skip((await summaryCard.count()) === 0, 'Create Rule is not available to this account');
  await summaryCard.first().click();

  const editor = page.getByTestId('connector-editor');
  await expect(editor).toBeVisible();

  const listing = await listingPromise;
  const operations: OperationEntry[] = (await listing.json()).operations ?? [];
  test.skip(operations.length === 0, 'no describe operation is seeded on this stack');

  // 1. Every offered operation, and nothing else.
  const picker = editor.getByLabel('Connector operation');
  const offered = await picker.locator('option').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value !== ''),
  );
  expect(offered).toEqual(operations.map((operation) => operation.operationId));

  // 2. The chosen operation's own slots, in the server's own order.
  const chosen = operations[0];
  await picker.selectOption(chosen.operationId);
  const expectedSlots = [
    ...chosen.tableInputScheme.map((role) => role.role),
    ...chosen.parameterScheme.map((param) => param.key),
  ];
  for (const slot of expectedSlots) {
    await expect(
      editor.getByLabel(`Declare ${slot}`),
      `the form must offer the operation's own slot "${slot}"`,
    ).toBeVisible();
  }
  const rendered = await editor.locator('input[aria-label^="Declare "]').count();
  expect(rendered, 'the form must offer no slot the operation did not declare').toBe(
    expectedSlots.length,
  );
});
