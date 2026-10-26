import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2260 (epic AXI-2073, owner round 2 decision 5) — the audit report's
 * non-personal-actor warning, driven by the PERSISTED `User.accountKind`
 * (user-service), never by a display-name guess.
 *
 * READ-ONLY and REST-only: downloads the audit bundle of an evidence that
 * already exists in the demo data (Microbiote IgG4 final reference set,
 * same fixtures AXI-2257 walks) and asserts what the report says about its
 * actors. Nothing is created, so it can run against a sidecar that shares
 * the demo database — the ONLY prerequisite is that `admin@cro-one.com` is
 * marked `shared` and `staging-service@axiome.local` is marked `service` on
 * `users.account_kind` (the AXI-2260 data fix).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface EvidenceRef { id: string; version: number; workspaceId: string }

const MAG4_WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const C700: EvidenceRef = { id: 'c700a6bd-e4e6-419d-b506-34190cc7fb0e', version: 1, workspaceId: MAG4_WS };

let token: string;

interface Bundle { md: string }

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status, `login ${email}`).toBeLessThan(300);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function download(ev: EvidenceRef, bearer: string): Promise<Bundle> {
  const res = await fetch(apiUrl(`/api/v1/view-analyses/evidences/${ev.id}/versions/${ev.version}/audit-report`), {
    headers: { Authorization: `Bearer ${bearer}`, 'X-Workspace-Id': ev.workspaceId },
  });
  expect(res.status, `audit-report ${ev.id} v${ev.version}`).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2260-'));
  const zip = join(dir, 'bundle.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-q', zip, '-d', join(dir, 'x')]);
  return { md: readFileSync(join(dir, 'x', 'report.md'), 'utf8') };
}

function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

test.describe('AXI-2260 non-personal-actor warning — read-only on the demo data', () => {
  let c700: Bundle;

  test.beforeAll(async () => {
    token = await login(process.env.E2E_ADMIN_EMAIL ?? 'admin@cro-one.com', process.env.E2E_ADMIN_PASSWORD ?? 'admin');
    c700 = await download(C700, token);
  });

  test('@SI-016 R-1 the shared admin login\'s own evidence authorship, approval and report-generation each warn "non-personal account (shared)"', async () => {
    const verdict = section(c700.md, 'Verdict');
    expect(verdict).toContain('The actor who authored this evidence version (Local Admin) is a non-personal account (shared).');
    expect(verdict).toContain('The actor who generated this report (Local Admin) is a non-personal account (shared).');
  });

  test('@SI-016 R-2 a run executed by the shared admin login warns "The actor who ran this test … is a non-personal account (shared)"', async () => {
    const verdict = section(c700.md, 'Verdict');
    expect(verdict).toMatch(/The actor who ran this test \(Local Admin\) is a non-personal account \(shared\)\./);
  });

  test('@SI-016 R-3 the literal ingestion actor stays "service: ingestion" and raises NO non-personal-account warning', async () => {
    expect(c700.md).toContain('by service: ingestion');
    const verdict = section(c700.md, 'Verdict');
    expect(verdict).not.toContain('service: ingestion) is a non-personal account');
    expect(verdict).not.toMatch(/\(system\) is a non-personal account/);
  });

  test('@SI-016 R-4 the headline stays within the four declared values with the new warning present', async () => {
    const headline = /## Verdict\n\n\*\*(.+?)\*\*/.exec(c700.md)?.[1];
    expect(['Not traceable', 'Traceable — with warnings', 'Traceable — some facts not recorded', 'Complete']).toContain(headline);
  });
});
