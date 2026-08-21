import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createSubject,
  createWorkspace,
  newRoleRequestContext,
  publishSchema,
  roleTokens,
  seedBrowserSession,
  type SubjectFixture,
} from './subject-fixtures';

/**
 * AXI-1247 — subject registry & CRUD (manual-e2e §4.2 / §5.10; FR9, FR12, EC8, AC3).
 *
 * The registry is the pseudonymized subject entity: a system-assigned UUID plus
 * an operator-supplied `code` and lifecycle `status`, carrying NO name / birth
 * date / contact fields (FR9, NFR1). This spec drives the workspace-scoped
 * `/api/v1/workspaces/:ws/subjects` surface end-to-end — create (201, system
 * UUID, `active`), duplicate-code collision (409 naming the code, EC8), server
 * paging, read-by-id (404 for an unknown uuid), rename + rename-collision (FR12),
 * tombstone + double-tombstone (409), and the status/search list filters — then
 * the three registry pages (list / create / detail) plus the not-found state and
 * the code-not-UUID breadcrumb (AC3). Data is provisioned per run through the
 * public API (self-contained, no ambient seed — NFR3); the browser is seeded with
 * fresh admin tokens pointed at the fixture workspace before every `goto`.
 */

let adminApi: APIRequestContext;
let adminTokens: { accessToken: string; refreshToken: string };
let ws: string;
let orgId: string;
let seededA: SubjectFixture;
let seededB: SubjectFixture;

let codeSeq = 0;
/** A fresh, pattern-valid (`^[A-Za-z0-9_-]{1,64}$`) code, unique per run. */
function freshCode(prefix: string): string {
  codeSeq += 1;
  return `${prefix}-${Date.now()}-${codeSeq}`;
}

test.beforeAll(async () => {
  const ctx = await adminContext();
  orgId = ctx.orgId;
  try {
    ws = await createWorkspace(ctx.api, orgId, ctx.userId, 'subject-registry');
    await publishSchema(ctx.api, ws);
    seededA = await createSubject(ctx.api, ws, freshCode('SUBJ-A'));
    seededB = await createSubject(ctx.api, ws, freshCode('SUBJ-B'));
  } finally {
    await ctx.api.dispose();
  }
  adminApi = await newRoleRequestContext('admin');
  adminTokens = await roleTokens('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** Issue a workspace-scoped registry request with the admin token. */
function registry(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  workspaceId: string,
  body?: unknown,
) {
  return adminApi[method](apiUrl(path), {
    headers: { 'X-Workspace-Id': workspaceId },
    data: body as any,
  });
}

/** Seed the SPA session on the fixture workspace, then open the Subjects list. */
async function openSubjects(page: Page): Promise<void> {
  await seedBrowserSession(page, adminTokens, ws, orgId);
  await page.goto('/subjects');
  await expect(page.getByRole('heading', { name: 'Subjects' })).toBeVisible();
}

test.describe('AXI-1247 — subject registry & CRUD (§4.2 / §5.10)', () => {
  // ─── API contract (FR9 / FR12 / EC8 — the server half) ──────────────

  test('FR9 AC3 — POST registers a pseudonymized subject (system UUID, active, no identity fields) and GET lists it', async () => {
    const code = freshCode('SUBJ-NEW');
    const create = await registry('post', `/api/v1/workspaces/${ws}/subjects`, ws, {
      code,
      reason: 'Enrolled in pilot cohort',
    });
    expect(create.status()).toBe(201);
    const subject = await create.json();
    expect(subject.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(subject.code).toBe(code);
    expect(subject.status).toBe('active');
    // FR9 / NFR1: the entity carries ONLY the pseudonymized code — never a name,
    // birth date, or contact field.
    for (const forbidden of ['name', 'firstName', 'lastName', 'dob', 'dateOfBirth', 'birthDate', 'contact', 'email', 'phone']) {
      expect(subject[forbidden]).toBeUndefined();
    }

    const list = await (await registry('get', `/api/v1/workspaces/${ws}/subjects`, ws)).json();
    expect(Array.isArray(list.subjects)).toBe(true);
    expect(typeof list.total).toBe('number');
    expect(list.subjects.some((s: SubjectFixture) => s.code === code)).toBe(true);
  });

  test('FR9 EC8 — a duplicate code is refused 409 naming the collision, and nothing new is written', async () => {
    const code = freshCode('SUBJ-DUP');
    await registry('post', `/api/v1/workspaces/${ws}/subjects`, ws, { code, reason: 'first' });
    const before = (await (await registry('get', `/api/v1/workspaces/${ws}/subjects`, ws)).json()).total;

    const dup = await registry('post', `/api/v1/workspaces/${ws}/subjects`, ws, { code, reason: 'again' });
    expect(dup.status()).toBe(409);
    expect((await dup.text())).toContain(code);

    const after = (await (await registry('get', `/api/v1/workspaces/${ws}/subjects`, ws)).json()).total;
    expect(after).toBe(before);
  });

  test('FR9 — GET ?page=&limit= pages server-side (limit caps the page, total counts all)', async () => {
    const res = await registry('get', `/api/v1/workspaces/${ws}/subjects?page=1&limit=1`, ws);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.subjects.length).toBe(1);
    // At least the two seeded subjects exist, so the full count exceeds the page.
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  test('FR9 — GET /:id returns the subject; a random uuid 404s', async () => {
    const ok = await registry('get', `/api/v1/workspaces/${ws}/subjects/${seededA.id}`, ws);
    expect(ok.status()).toBe(200);
    expect((await ok.json()).code).toBe(seededA.code);

    const miss = await registry(
      'get',
      `/api/v1/workspaces/${ws}/subjects/11111111-1111-1111-1111-111111111111`,
      ws,
    );
    expect(miss.status()).toBe(404);
  });

  test('FR12 EC8 — PATCH renames a subject; renaming onto another subject\'s code 409s', async () => {
    const subject = await createFresh('SUBJ-REN');
    const renamed = freshCode('SUBJ-RENAMED');
    const ok = await registry('patch', `/api/v1/workspaces/${ws}/subjects/${subject.id}`, ws, {
      code: renamed,
      reason: 'Code renumbered after site merge',
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).code).toBe(renamed);

    const clash = await registry('patch', `/api/v1/workspaces/${ws}/subjects/${subject.id}`, ws, {
      code: seededB.code,
      reason: 'collide',
    });
    expect(clash.status()).toBe(409);
    expect(await clash.text()).toContain(seededB.code);
  });

  test('FR12 — DELETE tombstones the subject; a second DELETE 409s (already tombstoned)', async () => {
    const subject = await createFresh('SUBJ-TOMB');
    const del = await registry('delete', `/api/v1/workspaces/${ws}/subjects/${subject.id}`, ws, {
      reason: 'Withdrew consent',
    });
    expect(del.status()).toBe(200);
    expect((await del.json()).status).toBe('tombstoned');

    const again = await registry('delete', `/api/v1/workspaces/${ws}/subjects/${subject.id}`, ws, {
      reason: 'again',
    });
    expect(again.status()).toBe(409);
  });

  test('FR9 — ?status and ?search filter the registry (tombstoned excluded from active; code substring matches)', async () => {
    const marker = freshCode('ZFIND');
    const subject = await createFresh(marker);

    // ?search matches by code substring over the (active) registry.
    const hit = await (await registry('get', `/api/v1/workspaces/${ws}/subjects?search=${marker}`, ws)).json();
    expect(hit.subjects.every((s: SubjectFixture) => s.code.includes(marker))).toBe(true);
    expect(hit.subjects.some((s: SubjectFixture) => s.id === subject.id)).toBe(true);

    // Tombstoning moves it out of the active view and into the tombstoned view.
    await registry('delete', `/api/v1/workspaces/${ws}/subjects/${subject.id}`, ws, { reason: 'gone' });

    const tomb = await (await registry('get', `/api/v1/workspaces/${ws}/subjects?status=tombstoned`, ws)).json();
    expect(tomb.subjects.some((s: SubjectFixture) => s.id === subject.id)).toBe(true);

    const active = await (await registry('get', `/api/v1/workspaces/${ws}/subjects?status=active`, ws)).json();
    expect(active.subjects.some((s: SubjectFixture) => s.id === subject.id)).toBe(false);
  });

  test('FR12 — a blank reason is refused 400 (a reason is mandatory for every mutation)', async () => {
    const res = await registry('post', `/api/v1/workspaces/${ws}/subjects`, ws, {
      code: freshCode('SUBJ-NOREASON'),
      reason: '   ',
    });
    expect(res.status()).toBe(400);
  });

  test('AC3 — deny-by-default: a non-member is refused 403 on the registry', async () => {
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.get(apiUrl(`/api/v1/workspaces/${ws}/subjects`), {
        headers: { 'X-Workspace-Id': ws },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── Registry pages (AC3 — the browser half) ────────────────────────

  test('FR9 AC3 — the registry table renders the provisioned subjects', async ({ page }) => {
    await openSubjects(page);
    const row = page.getByRole('row', { name: new RegExp(seededA.code) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell', { name: seededA.code, exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(seededB.code) })).toBeVisible();
  });

  test('FR9 AC3 — "New subject" opens the create form and a valid submit lands on /subjects/<uuid>', async ({ page }) => {
    await openSubjects(page);
    await page.getByRole('button', { name: 'New subject' }).click();
    await expect(page).toHaveURL(/\/subjects\/new$/);
    await expect(page.getByRole('heading', { name: 'New subject' })).toBeVisible();

    const code = freshCode('SUBJ-UI');
    await page.getByPlaceholder('e.g. SUBJ-0001').fill(code);
    await page.getByPlaceholder(/Why is this subject/).fill('Registered via the UI');
    await page.getByRole('button', { name: 'Create subject' }).click();

    await expect(page).toHaveURL(/\/subjects\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: new RegExp(code) })).toBeVisible();
  });

  test('AC3 EC8 — a duplicate code in the create form surfaces the server collision message inline', async ({ page }) => {
    const code = freshCode('SUBJ-UIDUP');
    await createFresh(code);
    await openSubjects(page);
    await page.getByRole('button', { name: 'New subject' }).click();

    await page.getByPlaceholder('e.g. SUBJ-0001').fill(code);
    await page.getByPlaceholder(/Why is this subject/).fill('Trying a taken code');
    await page.getByRole('button', { name: 'Create subject' }).click();

    await expect(page.getByText(/already exists in this workspace/)).toBeVisible();
    // Stayed on the create form — no navigation to a detail page.
    await expect(page).toHaveURL(/\/subjects\/new$/);
  });

  test('FR9 AC3 — the detail breadcrumb shows the subject code, not the raw UUID', async ({ page }) => {
    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto(`/subjects/${seededA.id}`);
    // Detail resolved (header carries the code).
    await expect(page.getByRole('heading', { name: new RegExp(seededA.code) })).toBeVisible();

    // The breadcrumb crumb carries the code…
    const crumb = page.getByRole('listitem').filter({ hasText: seededA.code });
    await expect(crumb.first()).toBeVisible();
    // …and the raw UUID appears nowhere on the page by default (the Registry
    // popover that would reveal it stays closed).
    await expect(page.getByText(seededA.id, { exact: false })).toHaveCount(0);
  });

  test('AC3 — an unknown subject URL shows the not-found state with a link back to the registry', async ({ page }) => {
    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto('/subjects/not-a-real-id');
    await expect(page.getByRole('heading', { name: 'Subject not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the subject registry' })).toBeVisible();
  });
});

/** Create a subject in the fixture workspace via the admin token (for mutation
 *  tests that must not disturb the shared read set). */
async function createFresh(code: string): Promise<SubjectFixture> {
  const res = await registry('post', `/api/v1/workspaces/${ws}/subjects`, ws, {
    code,
    reason: 'AXI-1247 E2E mutation subject',
  });
  if (res.status() !== 201) throw new Error(`createFresh ${code} → ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  return { id: body.id, code };
}
