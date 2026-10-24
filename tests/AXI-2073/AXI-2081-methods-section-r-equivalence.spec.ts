import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest } from '@playwright/test';
import { ROLES } from '../../config/roles';
import { ensureAuthTokens } from '../../config/auth';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, pollTerminal,
  type Tenant, type Analysis,
} from '../AXI-1435/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { frozenRenderPayload, uniq } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2081 (epic AXI-2073, FR6-FR8, AC3, AC5, D3, SI-016) — review bounce #2
 * (B1): the audited report's "Methods" section is USER-OBSERVABLE output
 * (real build-identity lines + an R-equivalence line), and a RuleRun-backed
 * evidence chain IS producible through the existing REST harnesses — so this
 * spec builds one for real rather than deferring the whole surface.
 *
 * Recipe (REST-only, no browser needed — this exercises a gateway download
 * route, exactly like AXI-2077's own spec):
 *   1. Seed a tenant + the AXI-1435 all-numeric fixture (`statistical-trigger.csv`),
 *      approve `stats.correlation`'s carrier (AXI-1809) and submit a REAL
 *      `POST /api/v1/rule-runs` run of it, polled to a terminal status
 *      (SUCCEEDED or DEDUPED — both are governed materialised outcomes).
 *   2. Resolve the run's rule-derived `ViewAnalysisSnapshot` and cite it on a
 *      fresh Evidence's `chartEntries[0].snapshotId` — the field the audit
 *      chain assembler walks to find a `run` step (`AuditChainAssemblerService`
 *      resolves `EvidenceVersion.snapshotIds` straight from this field; AXI-2077's
 *      own spec never sets it, which is why that spec's audited chain has NO
 *      run step at all).
 *   3. Download the bundle through the REAL gateway route (controller prefix
 *      `view-analyses` — NOT `/api/v1/evidences/...`, a contract error fixed on
 *      a separate branch and never copied here), unzip it with the system
 *      `unzip` binary (no zip-reading package is a declared devDependency of
 *      this suite), and assert `report.md`'s Methods section names the run's
 *      build-identity lines (a real value, or the literal "not recorded") and
 *      an R-equivalence entry that is `none exists` or `statement index
 *      unavailable` — the demo stack this spec would run against cannot reach
 *      axiome-front's published index, so either is an accepted, HONEST
 *      disposition; what must never appear is a broken link, `undefined` or
 *      `null`.
 *
 * The REAL-link scenario (a run whose buildSha matches a genuinely published
 * R-equivalence entry) is a recorded FOLLOW-UP, not asserted here: it needs a
 * fixture that controls the bio-compute callback's reported `buildSha` to
 * match a specific published release, which is new test-infrastructure work
 * tracked in the manual-e2e doc, not a gap in this spec's own scope.
 *
 * AXI-2073 redesign (2026-10-24): the report is now clinician-readable — the
 * run section is `### <operation label> — produced the cited result` under
 * `## Methods`, the operation is named by its kernel label ("Correlation"),
 * and the build-identity lines are `Library`, `Build SHA`, `Image digest`,
 * `Groups and n` and `Run fingerprint`. The assertions follow that format;
 * the contract under test (a real value or "not recorded", never a
 * placeholder; the R-equivalence line never a broken link) is unchanged.
 *
 * DISPOSITION: see the run notes in
 * `axiome-docs/manual-e2e/AXI-2073-Evidence-Audit-Report.md`.
 */

let api: Api;
let tenant: Tenant;
let analysis: Analysis;
let adminTokens: { accessToken: string; refreshToken: string };
let evidenceId: string;
let versionNumber: number;

const CORRELATION_OP = 'stats.correlation';
/** The redesigned Methods heading of the run that produced the cited snapshot. */
const PRODUCER_HEADING = '### Correlation — produced the cited result';

function producerSection(reportMd: string): string {
  const start = reportMd.indexOf(PRODUCER_HEADING, reportMd.indexOf('## Methods'));
  expect(start, 'report.md has the producing run\'s Methods section').toBeGreaterThanOrEqual(0);
  const end = reportMd.indexOf('\n## ', start);
  return reportMd.slice(start, end === -1 ? undefined : end);
}

function auditReportUrl(evId: string, v: number | string): string {
  // Absolute: the `request` fixture's baseURL is the frontend (SPA index.html).
  return apiUrl(`/api/v1/view-analyses/evidences/${evId}/versions/${v}/audit-report`);
}

/** Submit a real `stats.correlation` run (AXI-1400 harness's `runBody` shape,
 *  inlined here since this spec needs only ONE operation, not the whole
 *  operation matrix) and resolve it to its rule-derived snapshot id. */
async function runCorrelationAndGetSnapshotId(datasetId: string): Promise<string> {
  const body = {
    ruleId: tenant.ruleIds[CORRELATION_OP],
    runKind: 'STATISTICAL',
    operationId: CORRELATION_OP,
    roleBindings: { xColumn: 'score', yColumn: 'score2' },
    operationParams: {},
    projectId: tenant.projectId,
    workspaceId: tenant.workspaceId,
    datasetId,
    snapshotId: analysis.snapshotId,
    viewAnalysisId: analysis.analysisId,
    scope: 'FILTERED',
  };
  const submit = await api.post('/api/v1/rule-runs', body, tenant.headers);
  expect(submit.status, `submit ${CORRELATION_OP} -> ${submit.status}: ${JSON.stringify(submit.body)}`).toBeLessThan(300);
  const ruleRunId: string = submit.body.ruleRunId;
  expect(ruleRunId, `no ruleRunId: ${JSON.stringify(submit.body)}`).toBeTruthy();

  const run = await pollTerminal(api, tenant, ruleRunId);
  expect(
    ['SUCCEEDED', 'DEDUPED'],
    `${CORRELATION_OP} run ${ruleRunId}: ${run.statusMessage ?? run.errorMessage ?? ''}`,
  ).toContain(run.status);
  const resultRunId: string = run.status === 'DEDUPED' ? submit.body.dedupedFromRunId ?? run.dedupedFromRunId : run.id;
  expect(resultRunId, `${CORRELATION_OP} run ${ruleRunId} resolved to no canonical run id`).toBeTruthy();

  const snapshots = await api.get(
    `/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`,
    tenant.headers,
  );
  const producedId: string | undefined =
    asList(snapshots.body).find((s: any) => s.ruleRunId === resultRunId)?.id
    ?? (submit.body.existingSnapshotId as string | undefined);
  expect(producedId, `no rule-derived snapshot registered for run ${resultRunId}`).toBeTruthy();
  return producedId!;
}

async function createEvidenceOverRunSnapshot(snapshotId: string, datasetId: string): Promise<{ id: string; versionNumber: number }> {
  const specId = `spec-${uniq()}`;
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysis.analysisId,
    chartEntries: [
      {
        chartArtifactId: specId,
        snapshotId,
        datasetVersionId: datasetId,
        frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: datasetId }),
      },
    ],
    title: `AXI-2081 ${uniq()}`,
    createdBy: 'e2e-axi-2081',
  }, tenant.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { id: res.body.id, versionNumber: res.body.currentVersion.versionNumber };
}

/** Unzip the downloaded bundle's `report.md` via the system `unzip` binary —
 *  this suite declares no zip-reading package, and a run-backed audit bundle
 *  is only asserted at the byte level here, not structurally parsed. */
function extractReportMd(zipBytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'axi-2081-audit-'));
  const zipPath = join(dir, 'bundle.zip');
  writeFileSync(zipPath, zipBytes);
  return execFileSync('unzip', ['-p', zipPath, 'report.md'], { cwd: dir }).toString('utf8');
}

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  await approveCarriersFor([CORRELATION_OP]);
  const datasetId = await ingestFixture(api, tenant, 'statistical-trigger.csv');
  await assignProfileAndVerify(api, tenant, ['patient_id', 'timepoint']);
  analysis = await ensureAnalysis(api, tenant, 'AXI-2081 methods section r-equivalence', datasetId);

  const snapshotId = await runCorrelationAndGetSnapshotId(datasetId);
  const evidence = await createEvidenceOverRunSnapshot(snapshotId, datasetId);
  evidenceId = evidence.id;
  versionNumber = evidence.versionNumber;

  const bootstrap = await apiRequest.newContext();
  const adminRole = ROLES.find((r) => r.name === 'admin')!;
  adminTokens = await ensureAuthTokens(bootstrap, adminRole);
  await bootstrap.dispose();
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2081 — Methods section build identity + R-equivalence link (FR6-FR8, AC3, AC5, D3)', { tag: ['@SI-016'] }, () => {
  test('AC3/FR6-FR7 — a run-backed evidence download names the run\'s build-identity lines, each a real value or "not recorded"', async ({ request }) => {
    const response = await request.get(auditReportUrl(evidenceId, versionNumber), {
      headers: {
        Authorization: `Bearer ${adminTokens.accessToken}`,
        'X-Workspace-Id': tenant.workspaceId,
      },
    });
    expect(response.status(), await response.text().catch(() => '')).toBe(200);

    const reportMd = extractReportMd(await response.body());
    expect(reportMd, 'report.md has a Methods section').toContain('## Methods');
    expect(reportMd, 'report.md names the producing run (requires a snapshot carrying a real ruleRunId)').toContain(PRODUCER_HEADING);

    // Slice to the producing run's section so every assertion below is scoped
    // to THIS run's own lines, not a sibling branch's.
    const runSection = producerSection(reportMd);

    expect(runSection).not.toContain(`### ${CORRELATION_OP}`);
    for (const label of [
      'What it asks', 'Library', 'Build SHA', 'Image digest', 'Groups and n', 'Run fingerprint',
    ]) {
      const line = runSection.split('\n').find((l) => l.startsWith(`- ${label}:`));
      expect(line, `report.md is missing the "${label}" line`).toBeTruthy();
      const value = line!.slice(`- ${label}: `.length);
      expect(value, `"${label}" rendered an unresolved placeholder`).not.toMatch(/^(undefined|null|)$/);
    }
  });

  test('AC5/FR8/D3 — the R-equivalence entry line is always present and is never a broken link', async ({ request }) => {
    const response = await request.get(auditReportUrl(evidenceId, versionNumber), {
      headers: {
        Authorization: `Bearer ${adminTokens.accessToken}`,
        'X-Workspace-Id': tenant.workspaceId,
      },
    });
    expect(response.status()).toBe(200);

    const reportMd = extractReportMd(await response.body());
    const runSection = producerSection(reportMd);
    const entryLine = runSection.split('\n').find((l) => l.startsWith('- R-equivalence entry:'));
    expect(entryLine, 'report.md is missing the R-equivalence entry line').toBeTruthy();

    const entryValue = entryLine!.slice('- R-equivalence entry: '.length).trim();
    // D3 — the demo stack this spec would run against cannot reach
    // axiome-front's published index (no network egress), so a genuine
    // negative ("none exists") and a transport failure ("statement index
    // unavailable") are BOTH accepted outcomes; the one thing that must never
    // render is a broken link or an unresolved placeholder.
    expect(['none exists', 'statement index unavailable']).toContain(entryValue);
    expect(entryValue, 'R-equivalence entry must never render a bare URL unless resolved').not.toMatch(/^https?:\/\//);
    expect(entryValue).not.toMatch(/^(undefined|null)$/);
  });

  // FOLLOW-UP (recorded, not scoped to this spec — see the manual-e2e doc):
  // a run whose reported buildSha matches an entry axiome-front has actually
  // published needs a fixture that controls the bio-compute callback's
  // reported buildSha; that is new test-infrastructure work, tracked
  // separately from this story's own gap.
});
