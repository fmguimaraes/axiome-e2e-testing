import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test, expect, request as apiRequest } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { ensureTenant } from '../AXI-1435/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { apiUrl } from '../../config/env';
import {
  createAdminShadowRunAuth,
  interpretTransportProbe,
  readBackendTransportMode,
  runShadowBankGuarded,
  writeShadowRunSummary,
  LLM_TRANSPORT_PROBE_PATH,
  TRANSPORT_STATEMENT_SERVICE,
  type ShadowRunAuth,
} from '../AXI-1462/harness/shadow';

/**
 * AXI-1716 (epic AXI-1687, area P re-scope). Scenarios RBR1716.1, .2, .4, .5, .6
 * of `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`.
 *
 * THE BLOCKER THIS STORY LIFTS. `runShadowBankGuarded` used to gate every bank
 * run on `GUIDED_ANALYSIS_LIVE_SPEND_GO` plus an FR116 registry row, with no
 * awareness of the transport at all. A run against a `recorded` backend — which
 * reads no key, reaches no network and spends nothing — was refused, every
 * question came back `not_answered: 'guard'`, and `shadow-run/gate/classify.ts`
 * scored those `not_answered`, failing gate condition (a). The owner's recorded
 * strategy (AXI-1758) could not produce a scoreable bank run at all.
 *
 * ZERO SPEND, BY CONSTRUCTION. This spec never sets `E2E_LIVE_LLM`, never sets
 * `GUIDED_ANALYSIS_LLM_TRANSPORT` and never sets `GUIDED_ANALYSIS_LIVE_SPEND_GO`.
 * The bank-run test below SKIPS unless the backend it is pointed at states
 * `recorded` of its own accord — so it cannot spend even if someone points it at
 * a live stack by mistake.
 *
 *     env -u E2E_LIVE_LLM npx playwright test tests/AXI-1687/AXI-1716-recorded-bank-run
 *
 * A question with no committed recording comes back `unsupported` /
 * `recording_missing`, which the gate scores `not_answered`. That is the correct
 * outcome and this spec asserts it as such: it means "go author that recording"
 * (the lead's blind-subagent loop, ruling R-LLM-3), never "the guard refused".
 */
test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 });

let api: Api;
let auth: ShadowRunAuth;
let workspaceId: string;
let projectId: string;

test.beforeAll(async () => {
  auth = await createAdminShadowRunAuth();
  api = auth.api();
  const overrideWorkspaceId = process.env.SHADOW_RUN_WORKSPACE_ID;
  const overrideProjectId = process.env.SHADOW_RUN_PROJECT_ID;
  if (overrideWorkspaceId && overrideProjectId) {
    workspaceId = overrideWorkspaceId;
    projectId = overrideProjectId;
    return;
  }
  const tenant = await ensureTenant(api);
  workspaceId = tenant.workspaceId;
  projectId = tenant.projectId;
});

test.afterAll(async () => {
  await auth?.api().ctx.dispose();
});

test(
  'RBR1716.1 — the backend states the transport it will actually serve, and names itself as the resolver',
  { tag: ['@SI-010', '@SI-045'] },
  async () => {
    const res = await api.get(LLM_TRANSPORT_PROBE_PATH, workspaceHeader(workspaceId));

    expect(res.status).toBe(200);
    // The one field that makes the answer authoritative rather than a guess: the
    // gateway does not construct the transport, so a statement it made for itself
    // would be about a different process's configuration.
    expect(res.body.service).toBe(TRANSPORT_STATEMENT_SERVICE);
    expect(['live', 'recorded']).toContain(res.body.mode);
    expect(Number.isNaN(Date.parse(res.body.resolvedAt))).toBe(false);

    // And the harness reads exactly that, with no env of its own in the loop.
    const statement = await readBackendTransportMode(api, workspaceId);
    expect(statement).toEqual({ mode: res.body.mode, source: 'backend' });
    expect(interpretTransportProbe(res.status, res.body)).toEqual(statement);
  },
);

test(
  'RBR1716.2 — the statement route is authenticated and workspace-scoped like every other guided-analysis route',
  { tag: ['@SI-010'] },
  async () => {
    // Deny-by-default still holds: the mode is not a secret, but it is not public either.
    const anonymous = await apiRequest.newContext();
    const unauthenticated = await anonymous.get(apiUrl(LLM_TRANSPORT_PROBE_PATH), {
      headers: workspaceHeader(workspaceId),
    });
    expect(unauthenticated.status()).toBe(401);
    await anonymous.dispose();

    // The controller carries `@RequireWorkspace()`; a request with no workspace
    // header is refused rather than answered out of some ambient scope.
    const noWorkspace = await api.get(LLM_TRANSPORT_PROBE_PATH);
    expect(noWorkspace.status).toBeGreaterThanOrEqual(400);
  },
);

test(
  'RBR1716.4 — against a RECORDED backend a named bank subset runs with no registry row and no spend go',
  { tag: ['@SI-042', '@SI-045'] },
  async () => {
    const statement = await readBackendTransportMode(api, workspaceId);
    // Never run the bank against a backend that would spend. This skip is the
    // spec's own zero-spend wall, on top of the harness's.
    test.skip(
      statement.mode !== 'recorded',
      `backend reports transport '${statement.mode}' — this spec only runs a bank against a recorded backend`,
    );

    const dataset = await anchorDataset(api, workspaceId, projectId, {
      datasetId: process.env.SHADOW_RUN_DATASET_ID,
    });
    test.skip(!dataset, 'could not anchor a dataset for the bank run');
    if (!dataset) return;

    // Deliberately: no GUIDED_ANALYSIS_LIVE_SPEND_GO, no SHADOW_RUN_REGISTRY_PATH.
    // Before this story every one of these rows came back `not_answered: guard`.
    const result = await runShadowBankGuarded(auth, workspaceId, projectId, 'compiled', [dataset], {
      env: { SHADOW_RUN_QUESTIONS: '3,7,12' },
      registryText: undefined,
    });

    expect(result.transport.mode).toBe('recorded');
    expect(result.guard.allowed).toBe(true);
    expect(result.guard.spendMode).toBe('free_recorded');
    expect(result.guard.rowId).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(result.rows).toHaveLength(3);
    // The blocker: not one row may be refused by the spend guard. A row that is
    // `unsupported` because its recording is missing is a DIFFERENT, correct
    // outcome and is allowed here — it means "go author that recording".
    expect(result.rows.filter((r) => r.notAnsweredReason === 'guard')).toHaveLength(0);
  },
);

test(
  'RBR1716.5 — the run artefact states how its answers were obtained: claude-code, 0 USD, never live',
  { tag: ['@SI-042'] },
  async () => {
    const statement = await readBackendTransportMode(api, workspaceId);
    test.skip(statement.mode !== 'recorded', `backend reports transport '${statement.mode}'`);

    const result = await runShadowBankGuarded(auth, workspaceId, projectId, 'compiled-provenance', [], {
      env: { SHADOW_RUN_QUESTIONS: '3' },
      registryText: undefined,
      // No dataset is anchored here; the run may well refuse per question. What
      // this scenario is about is the ARTEFACT, which must state its transport
      // whatever the rows say.
    });

    const dir = test.info().outputPath('shadow-run');
    const path = writeShadowRunSummary(
      'compiled-provenance',
      {
        status: result.status,
        guard: result.guard,
        transport: result.transport,
        provenance: result.provenance,
        questionIds: result.questionIds,
        abortedAtQuestionId: result.abortedAtQuestionId,
      },
      dir,
    );

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.transport).toEqual({ mode: 'recorded', source: 'backend' });
    expect(written.provenance.label).toBe('claude-code');
    expect(written.provenance.label).not.toBe('live');
    expect(written.provenance.budget).toBe('0 USD (claude-code, blind)');
    expect(written.provenance.registryRowId).toBeUndefined();
  },
);

test(
  'RBR1716.6 — a free run writes no registry row, and the append-only registry check still holds',
  { tag: ['@SI-045'] },
  async () => {
    // `runs/REGISTRY.md` is the record of PAID runs. A recorded run authorises
    // nothing, so it must leave no trace there — and the CI guard must still pass.
    const backRoot = resolve(process.env.AXIOME_BACK_ROOT ?? join(process.cwd(), '..', 'axiome-back'));
    test.skip(!existsSync(backRoot), `axiome-back checkout not found at ${backRoot}`);

    const registryPath = join(
      backRoot,
      'apps/organization-service/src/guided-analysis/shadow-run/runs/REGISTRY.md',
    );
    expect(existsSync(registryPath)).toBe(true);

    const before = readFileSync(registryPath, 'utf8');

    const statement = await readBackendTransportMode(api, workspaceId);
    if (statement.mode === 'recorded') {
      await runShadowBankGuarded(auth, workspaceId, projectId, 'compiled-registry', [], {
        env: { SHADOW_RUN_QUESTIONS: '3' },
        registryText: undefined,
      });
    }

    expect(readFileSync(registryPath, 'utf8')).toBe(before);

    // And the CI append-only guard agrees: nothing in this run touched a row.
    const check = execFileSync(
      'git',
      ['diff', '--name-only', '--', 'apps/organization-service/src/guided-analysis/shadow-run/runs/REGISTRY.md'],
      { cwd: backRoot, encoding: 'utf8' },
    );
    expect(check.trim()).toBe('');
    expect(dirname(registryPath).endsWith('runs')).toBe(true);
  },
);
