import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { apiUrl } from '../../config/env';
import {
  EXPORT_HEADER,
  provisionSubjectDownloadFixture,
  newRoleRequestContext,
  roleTokens,
  seedBrowserSession,
  type SubjectDownloadFixture,
} from './subject-fixtures';

/**
 * AXI-1319 — subject clinical-data CSV download (FR41, AC25, NFR4).
 *
 * A complete end-to-end check of the read-only CSV download: the server contract
 * (status, `text/csv`, the `subject_<code>.csv` / `subjects.csv`
 * Content-Disposition, and the promotion-shaped body with biological columns
 * excluded), the deny/error matrix (§5.20 — unknown 404, schema-less 400,
 * workspace-mismatch 403, non-member 403), and the three UI affordances that
 * trigger it (subject-list row action, list "Download all", subject-detail
 * "Download CSV"). Data is provisioned through the public API per run
 * (self-contained, no seed dependence — NFR3); the browser is authenticated by
 * injecting fresh admin tokens into localStorage (`seedBrowserSession`, the
 * fixtures' canonical pattern) and pointed at the fixture workspace.
 */

let fixture: SubjectDownloadFixture;
let adminApi: APIRequestContext;
let adminTokens: { accessToken: string; refreshToken: string };

test.beforeAll(async () => {
  fixture = await provisionSubjectDownloadFixture();
  adminApi = await newRoleRequestContext('admin');
  adminTokens = await roleTokens('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** GET an export route with the admin token, scoped to `workspaceId`. */
function exportGet(path: string, workspaceId: string) {
  return adminApi.get(apiUrl(path), { headers: { 'X-Workspace-Id': workspaceId } });
}

/** Point the authenticated SPA at the fixture workspace (the app reads the
 *  active workspace from localStorage), then open the Subjects list. */
async function openSubjects(page: Page): Promise<void> {
  await seedBrowserSession(page, adminTokens, fixture.schemaWorkspaceId, fixture.orgId);
  await page.goto('/subjects');
  await expect(page.getByRole('heading', { name: 'Subjects' })).toBeVisible();
}

test.describe('AXI-1319 — subject CSV download (FR41/AC25)', () => {
  // ─── API contract (FR41 / AC25 — the server half) ──────────────────

  test('FR41 AC25 — single-subject export streams subject_<code>.csv as promotion-shaped text/csv', async () => {
    const { schemaWorkspaceId, subjectA } = fixture;
    const res = await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/${subjectA.id}/export`, schemaWorkspaceId);

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toContain(`filename="subject_${subjectA.code}.csv"`);

    const body = await res.text();
    const lines = body.trim().split(/\r?\n/);
    // Header is the promotion shape; the biological `bmi` column is excluded (FR41).
    expect(lines[0]).toBe(EXPORT_HEADER);
    expect(lines[0]).not.toContain('bmi');
    // One row per timepoint over the CURRENT versions; missing states render empty.
    expect(body).toMatch(/^SUBJ-0001,Baseline,[^,\n]+,54,A,\s*$/m);
    expect(body).toMatch(/^SUBJ-0001,Week 4,[^,\n]+,55,B,\s*$/m);
  });

  test('FR41 AC25 — all-subjects export streams subjects.csv aggregating every subject', async () => {
    const { schemaWorkspaceId } = fixture;
    const res = await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/export`, schemaWorkspaceId);

    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('filename="subjects.csv"');

    const body = await res.text();
    expect(body.split(/\r?\n/)[0]).toBe(EXPORT_HEADER);
    // Both subjects contribute (SUBJ-0001 across two timepoints, SUBJ-0002 once).
    expect(body).toMatch(/^SUBJ-0001,Baseline,/m);
    expect(body).toMatch(/^SUBJ-0001,Week 4,/m);
    expect(body).toMatch(/^SUBJ-0002,Baseline,[^,\n]+,40,A,stable\s*$/m);
  });

  test('FR41 — export persists nothing: a repeat is identical and the registry is unchanged', async () => {
    const { schemaWorkspaceId } = fixture;
    const before = await (await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/export`, schemaWorkspaceId)).text();
    const after = await (await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/export`, schemaWorkspaceId)).text();
    // Byte-identical across two downloads — a pure read, no state churn.
    expect(after).toBe(before);
    // The subject registry still holds exactly the two fixture subjects.
    const list = await (await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects`, schemaWorkspaceId)).json();
    expect(list.total).toBe(2);
  });

  // ─── Deny / error matrix (§5.20 — NFR4) ────────────────────────────

  test('FR41 NFR4 — an unknown subject id 404s (no cross-workspace oracle)', async () => {
    const { schemaWorkspaceId } = fixture;
    const res = await exportGet(
      `/api/v1/workspaces/${schemaWorkspaceId}/subjects/11111111-1111-1111-1111-111111111111/export`,
      schemaWorkspaceId,
    );
    expect(res.status()).toBe(404);
  });

  test('FR41 — a workspace with no published schema 400s', async () => {
    const { plainWorkspaceId } = fixture;
    const res = await exportGet(`/api/v1/workspaces/${plainWorkspaceId}/subjects/export`, plainWorkspaceId);
    expect(res.status()).toBe(400);
  });

  test('NFR4 — a path/header workspace mismatch 403s before any RPC', async () => {
    const { schemaWorkspaceId, plainWorkspaceId } = fixture;
    // Guard binds the path workspace to the X-Workspace-Id header; a divergence
    // is refused even though the caller is a member of the header workspace.
    const res = await exportGet(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/export`, plainWorkspaceId);
    expect(res.status()).toBe(403);
  });

  test('NFR4 — a caller without subject:read (non-member) is denied 403', async () => {
    const { schemaWorkspaceId } = fixture;
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.get(apiUrl(`/api/v1/workspaces/${schemaWorkspaceId}/subjects/export`), {
        headers: { 'X-Workspace-Id': schemaWorkspaceId },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── UI affordances (AC25 — the browser half) ──────────────────────

  test('AC25 — the subject-list row action downloads subject_<code>.csv', async ({ page }) => {
    await openSubjects(page);
    const { subjectA } = fixture;
    const row = page.getByRole('row', { name: new RegExp(subjectA.code) });
    await expect(row).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      row.getByRole('button', { name: 'Download clinical data (CSV)' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`subject_${subjectA.code}.csv`);

    const csv = readFileSync(await download.path(), 'utf8');
    expect(csv.split(/\r?\n/)[0]).toBe(EXPORT_HEADER);
    expect(csv).toMatch(/^SUBJ-0001,Baseline,[^,\n]+,54,A,/m);
  });

  test('AC25 — the list "Download all" action downloads subjects.csv', async ({ page }) => {
    await openSubjects(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download all' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('subjects.csv');

    const csv = readFileSync(await download.path(), 'utf8');
    expect(csv.split(/\r?\n/)[0]).toBe(EXPORT_HEADER);
    expect(csv).toMatch(/^SUBJ-0002,Baseline,/m);
  });

  test('AC25 — the subject detail page downloads that subject CSV', async ({ page }) => {
    const { subjectA, schemaWorkspaceId, orgId } = fixture;
    await seedBrowserSession(page, adminTokens, schemaWorkspaceId, orgId);
    await page.goto(`/subjects/${subjectA.id}`);

    const button = page.getByRole('button', { name: 'Download CSV' });
    await expect(button).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toBe(`subject_${subjectA.code}.csv`);
  });
});
