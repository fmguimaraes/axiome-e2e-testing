import { randomUUID } from 'node:crypto';
import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2540 W5 step 3 (2026-11-26) — cross-story flows no single story owns. API-only, own login (the
 * AXI-2549/AXI-2560 shape: no `page`, no storageState; the spec is registered in the `axi-2549-api` project
 * pattern only if it must run with `--no-deps`; it also runs under `chromium`).
 *
 * epic-1 (AXI-2560 x AXI-2549 x AXI-2548; FR77 FR78 AC71 AC72 EC41 EC42): an ingestion that GENUINELY fails
 *   (NUL byte, AXI-2560) shows a readable reason, and Retry (AXI-2549) on that failed row opens a NEW attempt
 *   without overwriting the old failed row (D42). Gives Retry coverage that AXI-2549 §4.2 skips whenever the
 *   stack's watchdog window is longer than a 2-row CSV takes to ingest.
 * epic-2 (AXI-2550 scenario 3, converted from `manual`; FR84 AC50): the seeded Editor / Approver / Admin /
 *   Investigator roles hold `chart_style:write` as a REAL role row (the migration survived the fallback-merge removal).
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const LOGIN = { email: 'admin@cro-one.com', password: 'admin' };
const TERMINAL = { attempts: 40, intervalMs: 1500 };

let api: APIRequestContext;
let token: string;
let datasetId: string | undefined;

const headers = () => ({ Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID });

async function ingestions(id: string) {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${id}/ingestions`), {
    headers: headers(),
    params: { page: 1, limit: 20 },
  });
  expect(res.ok(), `list ingestions ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return (body.data ?? body) as Array<{ id: string; status: string; errorMessage?: string | null; createdAt: string }>;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let last!: T;
  for (let i = 0; i < TERMINAL.attempts; i += 1) {
    last = await fn();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, TERMINAL.intervalMs));
  }
  return last;
}

test.beforeAll(async () => {
  api = await request.newContext();
  const login = await api.post(apiUrl('/api/v1/auth/login'), {
    data: { email: process.env.E2E_TEST_EMAIL?.trim() || LOGIN.email, password: process.env.E2E_TEST_PASSWORD?.trim() || LOGIN.password },
  });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).accessToken;
});

test.afterEach(async () => {
  if (!datasetId) return;
  await until(() => ingestions(datasetId!), (l) => l.every((i) => ['ready', 'failed'].includes(i.status)));
  await api.delete(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}`), { headers: headers() });
  datasetId = undefined;
});

test.afterAll(async () => {
  await api?.dispose();
});

test('FR77 FR78 AC71 AC72 EC41 — epic-1: a genuinely failed upload (NUL byte) names its reason and Retry opens a new attempt, keeping the failed row', async () => {
  const csv = Buffer.from('id,label\n1,hello\x00world\n2,ok\n', 'binary');
  const init = await api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets`), {
    headers: headers(),
    data: { organizationId: ORGANIZATION_ID, originalFilename: `axi-2540-epic-${randomUUID().slice(0, 8)}.csv`, contentType: 'text/csv' },
  });
  expect(init.ok(), `initiate ${init.status()}`).toBeTruthy();
  const upload = await init.json();
  datasetId = upload.dataset.id as string;
  expect((await api.put(upload.presignedUrl, { data: csv, headers: { 'Content-Type': 'text/csv' } })).ok()).toBeTruthy();
  const fin = await api.patch(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/finalize`), { headers: headers() });
  expect(fin.ok(), `finalize ${fin.status()}`).toBeTruthy();

  const settled = await until(() => ingestions(datasetId!), (l) => l.length > 0 && !['queued', 'running'].includes(l[0].status));
  const failed = settled[0];
  expect(failed.status).toBe('failed');
  expect(failed.errorMessage ?? '').toContain('NUL');

  const retry = await api.post(
    apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/ingestions/${failed.id}/retry`),
    { headers: headers() },
  );
  expect(retry.ok(), `retry ${retry.status()} ${await retry.text()}`).toBeTruthy();
  const body = await retry.json();
  const next: string = body.id ?? body.ingestion?.id;
  expect(next).toBeTruthy();
  expect(next).not.toBe(failed.id);

  const after = await until(() => ingestions(datasetId!), (l) => l.some((i) => i.id === next && ['ready', 'failed'].includes(i.status)));
  const old = after.find((i) => i.id === failed.id);
  expect(old?.status, 'the failed row is never overwritten (D42)').toBe('failed');
  expect(old?.errorMessage ?? '').toContain('NUL');
  expect(after.find((i) => i.id === next)?.status, 'the same bytes fail again, readably').toBe('failed');
});

test('FR84 AC50 — epic-2 (converted from manual AXI-2550 scenario 3): seeded Editor, Approver, Admin and Investigator hold chart_style:write as a real role row', async () => {
  const res = await api.get(apiUrl('/api/v1/roles'), { headers: headers(), params: { limit: 100 } });
  test.skip(res.status() === 403, `roles list refused (${res.status()}): needs a System Admin identity (owner-provided E2E_TEST_PASSWORD)`);
  expect(res.ok(), `roles ${res.status()}`).toBeTruthy();
  const body = await res.json();
  const roles: Array<{ name: string; permissions: string[] }> = body.data ?? body;
  test.skip(!roles.some((r) => r.name === 'Editor'), 'seeded workspace roles are not listed for this identity: needs a System Admin (owner-provided E2E_TEST_PASSWORD)');
  for (const name of ['Editor', 'Approver', 'Admin', 'Investigator']) {
    const role = roles.find((r) => r.name === name);
    expect(role, `${name} role exists`).toBeTruthy();
    expect(role!.permissions, `${name} holds chart_style:write`).toContain('chart_style:write');
  }
});
