import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { psql } from '../AXI-1640/harness/seed';
import { apiCallOf, pinNewestT1, questionInput, uploadArmScoreDataset } from '../AXI-2433/harness/sap-api-stub';

/**
 * AXI-2471 (epic AXI-2455; SAP FR70, FR16, EC34, AC37 — owner ruling 12, 2026-11-07) — the first
 * structured finalise over a legacy free-text SAP: the author is asked for no reason, the server
 * records "First structured version over a legacy free-text SAP" itself, an author-supplied reason
 * is 422 SAP_CONTENT_INVALID, and FR16 applies unchanged to every later amendment.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * § "AXI-2471" (AXI-2471.1 .. AXI-2471.4).
 *
 * A legacy free-text SAP can no longer be written through the API (FR60/FR61, 410
 * SAP_FREE_TEXT_RETIRED), so each world seeds its `saps` row and two `legacy_text`
 * `sap_versions` rows (the FR58 column defaults) straight into the target database
 * (`E2E_PG_CONTAINER`/`E2E_PG_DB`/`E2E_PG_USER`, AXI-1640 harness), exactly the shape the
 * AXI-2434 migration gave every pre-existing SAP.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-002', '@SI-031'] };
const SYSTEM_REASON = 'First structured version over a legacy free-text SAP';
const PROFILE_WAIT_MS = 120_000;

/** organization-service's Postgres schema (AXI-2408 precedent). */
const SVC = 'organization_svc';

let world: PrivateProjectsWorld;
let editor: UiActor;
let datasetId: string;

const sapPath = (projectId: string, sapId: string, suffix = '') =>
  apiUrl(`/api/v1/projects/${projectId}/saps/${sapId}${suffix}`);

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2471 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const projectId: string = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return projectId;
}

/** The pre-AXI-2434 shape: one SAP, versions 1–2 `legacy_text` (v1 superseded by v2). */
function seedLegacySap(projectId: string): string {
  const sapId = randomUUID();
  const v1 = randomUUID();
  const v2 = randomUUID();
  const row = (id: string, n: number) =>
    `('${id}', '${sapId}', ${n}, 'Legacy plan v${n}', 'Objective', 'Free-text plan v${n}', '[]'::jsonb, '${editor.userId}', 'legacy-hash-${n}', now(), now())`;
  psql(
    `INSERT INTO ${SVC}.saps (id, project_id) VALUES ('${sapId}', '${projectId}');` +
      ` INSERT INTO ${SVC}.sap_versions (id, sap_id, version, title, question_text, plan_text, linked_methods, author_user_id, content_hash, created_at, updated_at)` +
      ` VALUES ${row(v1, 1)}, ${row(v2, 2)};` +
      ` UPDATE ${SVC}.sap_versions SET superseded_by_id = '${v2}' WHERE id = '${v1}';`,
  );
  return sapId;
}

/** Start the structured draft over the legacy SAP and make it complete (title + one T1 question). */
async function completeDraft(projectId: string, sapId: string): Promise<{ revision: number; basedOnVersion: number | null }> {
  const started = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/saps/draft`));
  expect(started.status(), await started.text()).toBe(201);
  const draft = await started.json();
  expect(draft.sapId).toBe(sapId);
  const titled = await editor.api.put(sapPath(projectId, sapId, '/draft'), {
    data: { basedOnRevision: draft.revision, title: 'Structured primary plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(sapPath(projectId, sapId, '/draft/questions'), {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: questionInput(1) },
  });
  expect(added.status(), await added.text()).toBe(201);
  await expect
    .poll(async () => {
      const report = await (await editor.api.get(sapPath(projectId, sapId, '/draft/completeness'))).json();
      return report.results.filter((r: { status: string }) => r.status === 'fail').map((r: { checkId: string }) => r.checkId);
    }, { timeout: PROFILE_WAIT_MS, intervals: [2_000, 5_000] })
    .toEqual([]);
  return added.json();
}

async function legacyWorld(name: string) {
  const projectId = await newProject(name);
  await pinNewestT1(apiCallOf(editor.api), projectId);
  const sapId = seedLegacySap(projectId);
  const draft = await completeDraft(projectId, sapId);
  return { projectId, sapId, draft };
}

async function versionsOf(projectId: string, sapId: string) {
  const res = await editor.api.get(sapPath(projectId, sapId, '/versions'));
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Array<{ version: number; status: string; amendmentReason: string | null }>;
}

async function openSapPage(page: Page, projectId: string): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, editor, world.workspaceId);
  await page.goto(`/projects/${projectId}/sap`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  datasetId = await uploadArmScoreDataset(world, editor.api, 'axi2471');
});

test.afterAll(async () => {
  await editor?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2471 — first structured finalise over a legacy free-text SAP', TAGS, () => {
  let api: Awaited<ReturnType<typeof legacyWorld>>;

  test('EC34 AC37 — AXI-2471.2: an author-supplied reason on the first structured final is 422 SAP_CONTENT_INVALID; nothing is written', async () => {
    // Arrange
    api = await legacyWorld('api');
    expect(api.draft.basedOnVersion).toBeNull();

    // Act
    const res = await editor.api.post(sapPath(api.projectId, api.sapId, '/draft/finalise'), {
      data: { basedOnRevision: api.draft.revision, basedOnVersion: null, amendmentReason: 'Structured plan replaces the text' },
    });
    const stillOpen = await editor.api.get(sapPath(api.projectId, api.sapId, '/draft'));

    // Assert
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe('SAP_CONTENT_INVALID');
    expect(body.errors).toEqual([
      {
        field: 'amendmentReason',
        message: 'the first structured version over a legacy free-text SAP carries the system reason; none may be supplied',
      },
    ]);
    expect(stillOpen.status()).toBe(200);
    expect((await versionsOf(api.projectId, api.sapId)).map((v) => v.version).sort()).toEqual([1, 2]);
  });

  test('FR70 AC37 — AXI-2471.1: without a reason the draft finalises into version 3, final, carrying the system reason', async () => {
    // Act
    const res = await editor.api.post(sapPath(api.projectId, api.sapId, '/draft/finalise'), {
      data: { basedOnRevision: api.draft.revision, basedOnVersion: null },
    });

    // Assert
    expect(res.status(), await res.text()).toBe(201);
    expect(await res.json()).toMatchObject({ version: 3, status: 'final', amendmentReason: SYSTEM_REASON });
    const versions = await versionsOf(api.projectId, api.sapId);
    expect(versions.find((v) => v.version === 2)).toMatchObject({ status: 'legacy_text' });
  });

  test('FR16 FR70 — AXI-2471.4: the next amendment after that final needs the author\'s reason again', async () => {
    // Arrange
    const started = await editor.api.post(apiUrl(`/api/v1/projects/${api.projectId}/saps/draft`));
    expect(started.status(), await started.text()).toBe(201);
    const amend = await started.json();
    expect(amend.basedOnVersion).toBe(3);

    // Act
    const missing = await editor.api.post(sapPath(api.projectId, api.sapId, '/draft/finalise'), {
      data: { basedOnRevision: amend.revision, basedOnVersion: 3 },
    });
    const given = await editor.api.post(sapPath(api.projectId, api.sapId, '/draft/finalise'), {
      data: { basedOnRevision: amend.revision, basedOnVersion: 3, amendmentReason: 'Clarified the estimand' },
    });

    // Assert
    expect(missing.status()).toBe(422);
    expect((await missing.json()).errors).toEqual([
      { field: 'amendmentReason', message: 'is required to amend a SAP (version 2 onward)' },
    ]);
    expect(given.status(), await given.text()).toBe(201);
    expect(await given.json()).toMatchObject({ version: 4, status: 'final', amendmentReason: 'Clarified the estimand' });
  });

  test('AC37 — AXI-2471.3: on the Plan tab the finalise dialog asks for no reason, names the system reason, and the history shows it', async ({ page }) => {
    // Arrange
    const ui = await legacyWorld('ui');
    await openSapPage(page, ui.projectId);

    // Act
    await page.getByTestId('sap-finalise').click();
    const dialog = page.getByTestId('sap-finalise-dialog');

    // Assert — the dialog
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('sap-finalise-confirm')).toHaveText('Finalise version 3');
    await expect(page.getByTestId('sap-finalise-reason')).toHaveCount(0);
    await expect(page.getByTestId('sap-finalise-system-reason')).toContainText(SYSTEM_REASON);
    await expect(page.getByTestId('sap-finalise-confirm')).toBeEnabled();

    // Act — finalise
    await page.getByTestId('sap-finalise-confirm').click();

    // Assert — version 3 final, its history row carries the system reason
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('sap-history-reason-3')).toHaveText(SYSTEM_REASON);
    expect((await versionsOf(ui.projectId, ui.sapId)).find((v) => v.version === 3)).toMatchObject({
      status: 'final',
      amendmentReason: SYSTEM_REASON,
    });
  });
});
