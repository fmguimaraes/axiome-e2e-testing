import { test, expect } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-1633 (epic AXI-1575 — FR22, FR23, FR24, FR25; AC10, AC11, AC12, AC13):
 * the connector authoring follow-ups, in the browser (@SI-035).
 *
 * STATUS: AUTHORED AND NEVER EXECUTED. This suite has not been run against a
 * live stack — the Playwright job is skipped in CI whenever `vars.BASE_URL` is
 * unset, which it is. Treat every assertion below as a STATED expectation, not
 * as evidence; the story's proof is its unit suites.
 *
 * Same subject as AXI-1583's spec beside it, and the same method — the page's
 * OWN `GET /v1/rules/connectors` response is the source of truth, never a
 * fixture, because a fixture here would be the copy of the vocabulary this
 * story exists to delete and could not fail when the form and the server
 * disagree. What is added is the half AXI-1583 left to the client:
 *
 *  - each slot's KIND (AC12) — the badge must equal that slot's own
 *    `connectorKind`. `describe.top_n`'s `filter` is the case that matters: it
 *    is `type: 'json'` and the retired client-side inference called it an
 *    `enum`, offering a free-text pin for a structured predicate.
 *  - the `semantic` VOCABULARY (FR22/FR24, AC10) — the picker must offer exactly the
 *    server's `canonicalFields`; free text is how a typo published a connector
 *    that reads `indeterminate` on every column, forever.
 *  - a publish refusal's CODE (AC11) — which the server only began sending in
 *    this story, and which the form's refusal reader had a dead parser for.
 *  - Rule detail's sentence template and bound questions (AC13).
 *
 * SKIPS rather than fails on an unseeded stack, an account that cannot author
 * rules, or a server that predates `connectorKind` — the AXI-1565 precedent.
 */
test.describe.configure({ mode: 'serial' });

interface OperationEntry {
  operationId: string;
  parameterScheme: { key: string; connectorKind?: string }[];
  tableInputScheme: { role: string; connectorKind?: string }[];
}

interface ListingEntry {
  operations: OperationEntry[];
  canonicalFields?: { field: string; profiles: string[] }[];
}

/** Every slot of an operation, roles first — the order the form renders them in. */
function slotsOf(operation: OperationEntry): { key: string; connectorKind?: string }[] {
  return [
    ...operation.tableInputScheme.map((role) => ({
      key: role.role,
      connectorKind: role.connectorKind,
    })),
    ...operation.parameterScheme.map((param) => ({
      key: param.key,
      connectorKind: param.connectorKind,
    })),
  ];
}

/** Open Create Rule as a summary rule and return the editor + what it was offered. */
async function openConnectorForm(page: import('@playwright/test').Page) {
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
  const listing: ListingEntry = await (await listingPromise).json();
  return { editor, listing };
}

test('AC12 (FR24) — every slot badge is the kind the SERVER declared, `filter` included @SI-035', async ({
  page,
}) => {
  const { editor, listing } = await openConnectorForm(page);
  const topN = (listing.operations ?? []).find((op) => op.operationId === 'describe.top_n');
  test.skip(!topN, 'describe.top_n is not offered on this stack');
  const slots = slotsOf(topN!).filter((slot) => slot.connectorKind);
  test.skip(slots.length === 0, 'this server predates connectorKind');

  await editor.getByLabel('Connector operation').selectOption('describe.top_n');

  for (const slot of slots) {
    // The badge lives in the slot's own label row, beside its Declare checkbox,
    // so scoping to that row keeps another slot's badge from satisfying this.
    const row = editor.locator('label').filter({ has: editor.getByLabel(`Declare ${slot.key}`) });
    await expect(row, `slot "${slot.key}" must show the kind the server declared`).toContainText(
      slot.connectorKind!,
    );
  }
});

test('AC10 (FR22, FR24) — the `semantic` control offers the platform\'s canonical fields, not free text @SI-035', async ({
  page,
}) => {
  const { editor, listing } = await openConnectorForm(page);
  const fields = listing.canonicalFields ?? [];
  test.skip(fields.length === 0, 'no semantic profile resolves a canonical field on this stack');
  const grouped = (listing.operations ?? []).find(
    (op) => op.operationId === 'describe.grouped_aggregate',
  );
  test.skip(!grouped, 'describe.grouped_aggregate is not offered on this stack');

  await editor.getByLabel('Connector operation').selectOption('describe.grouped_aggregate');
  await editor.getByLabel('Declare valueColumn').check();

  const picker = editor.getByTestId('connector-semantic-valueColumn');
  await expect(picker).toBeVisible();
  for (const field of fields) {
    await expect(
      picker.getByLabel(`${field.field} for valueColumn`),
      `the picker must offer the platform's own canonical field "${field.field}"`,
    ).toBeVisible();
  }
});

test('AC11 (FR23, EC11) — a PUBLISH refusal shows its CODE in the Rule detail banner @SI-035', async ({
  page,
}) => {
  const { editor, listing } = await openConnectorForm(page);
  const grouped = (listing.operations ?? []).find(
    (op) => op.operationId === 'describe.grouped_aggregate',
  );
  test.skip(!grouped, 'describe.grouped_aggregate is not offered on this stack');
  const groupColumns = grouped!.tableInputScheme.find((role) => role.role === 'groupColumns');
  test.skip(!groupColumns, 'groupColumns is not offered on this stack');

  // CREATE, then PUBLISH — two different gates, and only the second one emits
  // this code. `CONNECTOR_CARDINALITY_EXCEEDS_OPERATION` comes from
  // `validateConnectorForPublish`; the SHAPE validator the create path runs
  // declines to judge a bound it would have to look the operation up to know
  // (`rule-connector-shape.ts`), so Create Rule stores the draft and navigates
  // to `/rules/:id` with no refusal at all. Asserting it after Create would
  // assert a message the create path structurally cannot produce.
  await editor.getByLabel('Connector operation').selectOption('describe.grouped_aggregate');

  // A cardinality ABOVE the kernel role's own bound, typed into a free-text
  // field the form deliberately does not validate.
  //
  // The obvious choice — pinning `aggregation` to a value outside its enum —
  // is NOT expressible here and that is not an oversight: `aggregation`
  // declares `allowedValues`, so the form renders a <select> of exactly the
  // operation's own set, and an out-of-enum value cannot be entered at all.
  // Cardinality is the refusal a real author CAN reach, because `formIssues`
  // reports only blank or non-numeric input and leaves the bound to the server
  // (pinned by UT-FE-CONN-1583-014).
  await editor.getByLabel('Declare groupColumns').check();
  await editor.getByLabel('Minimum columns for groupColumns').fill('1');
  await editor.getByLabel('Maximum columns for groupColumns').fill('99');

  await page.getByPlaceholder('e.g., IMM-ACT-01').fill(`SUM-E2E-${Date.now() % 100000}`);
  await page
    .getByPlaceholder('e.g., Evidence of immune activation')
    .fill('AXI-1633 cardinality refusal probe');

  const create = page.getByRole('button', { name: /^create rule$/i }).first();
  test.skip((await create.count()) === 0, 'no create control on this build');
  await create.click();

  // The draft was accepted; the refusal is still ahead of us.
  await page.waitForURL(/\/rules\/[0-9a-f-]{8,}$/i, { timeout: 30_000 });

  const publish = page.getByRole('button', { name: /^publish$/i }).first();
  test.skip(
    (await publish.count()) === 0,
    'Publish is not offered: this account lacks rule:publish, or the rule is not a draft',
  );
  await publish.click();

  // Rule detail's banner is the ONLY screen a publish refusal is ever shown on:
  // `ConnectorEditor` is mounted by Create Rule alone. The code is asserted
  // rather than the sentence because the parser lifts it out of the message, so
  // a banner that dropped it would still show a plausible-looking refusal.
  const refusal = page.getByTestId(
    /^connector-refusal-code-connector\.parameterScheme\.groupColumns\.cardinality-/,
  );

  // `handleLifecycleAction` runs `validateRuleForPublish` BEFORE it calls the
  // server, and that gate requires an attribute evaluation, an expression and an
  // output field of EVERY protocol type — a SUMMARY_RULE is not exempt. This
  // probe authors none of them, so on most stacks the click stops at the
  // client-side panel and the request is never issued. Skipping on that panel is
  // the honest outcome: the run proved nothing about the server's refusal, and
  // failing here would blame the connector for a form the probe did not fill.
  const clientGate = page.getByText(/Cannot publish: \d+ validation error/i);
  await expect(refusal.or(clientGate).first()).toBeVisible({ timeout: 30_000 });
  test.skip(
    (await clientGate.count()) > 0,
    'client-side publish validation blocked the probe (attribute evaluation, expression and output field are required of every protocol type); the connector refusal is reachable here only after those are authored, or directly via the API',
  );

  await expect(refusal.first()).toContainText('CONNECTOR_CARDINALITY_EXCEEDS_OPERATION');
});

test('AC13 (FR25) — Rule detail names the sentence template and the bound questions @SI-035', async ({
  page,
  request,
}) => {
  // Any rule this caller can see that HAS a connector. Presence of the field is
  // the condition (P6) — never a code prefix, and never the protocol type.
  const rules = await request.get(`${API_BASE_URL}/api/v1/rules?limit=200`);
  test.skip(!rules.ok(), 'rules are unreachable for this caller');
  const body = (await rules.json()) as { data?: { id: string; connector?: unknown }[] };
  const withConnector = (body.data ?? []).find((rule) => !!rule.connector);
  test.skip(!withConnector, 'no connector rule is visible to this caller');

  await page.goto(`/rules/${withConnector!.id}`);
  const section = page.getByTestId('connector-section');
  await expect(section).toBeVisible();

  // The question list renders even when it is EMPTY: "none we can show you" is a
  // different statement from the section being absent, and the empty case is the
  // one a cross-tenant reader must get.
  await expect(section.getByTestId('connector-bound-questions')).toBeVisible();

  // The sentence is shown as a TEMPLATE — FR25 audits the wording, so the
  // `{placeholder}` tokens must survive to the screen, unfilled. A connector on
  // an operation the describe register does not cover shows none, correctly.
  const template = section.getByTestId('connector-sentence-template');
  if ((await template.count()) > 0) {
    await expect(template).toContainText('{');
  }
});
