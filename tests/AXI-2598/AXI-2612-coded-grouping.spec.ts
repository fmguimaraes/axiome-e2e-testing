/**
 * AXI-2612 (epic AXI-2598 — bug fix for the `numeric-coded-grouping-not-bindable` defect found
 * by the AXI-2601 rehearsal's S6 step) — isolates the mapping step: provision the preset study
 * through upload, then request the data-binding proposal for a plan declaring a 0/1-coded
 * grouping field (`atteinte_pancreatique`), and assert no `role_mismatch`/`level_not_measured`
 * BLOCK is raised for it, and the Investigator (no `governs_analysis_parameters`) can confirm
 * the mapping directly — never needing the provisioner's dataset-semantic-declaration workaround
 * `R.mapping` falls back to today.
 *
 * Reuses the AXI-2601 bare-API rehearsal harness end to end (world/preset/provision/upload) —
 * this spec adds no new provisioning path. Run against a stack carrying the AXI-2612 fix
 * (`axiome-back` `preflightSapRun`'s plan-authorised grouping promotion); against `main` before
 * the fix merges, this spec is EXPECTED to fail at the final assertion (the known defect is still
 * open — see `harness/known-defects.ts` `numeric-coded-grouping-not-bindable`, step S6).
 *
 * Configuration is env only, same as AXI-2601 (`harness/config.ts`). No trace/video/screenshot
 * (project `handover-api`), no LLM call, no token in any output.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { evidenceVerdict, readHandoverConfig, type HandoverConfig } from './harness/config';
import { Ledger } from './harness/report';
import type { Preset } from './harness/preset';
import * as R from './harness/rehearsal';
import { setUpWorld } from './harness/world';

const PRESET_PATH = path.resolve(process.cwd(), 'fixtures/handover/mag4-preset.json');

let cfg: HandoverConfig | null = null;
let configMissing: string[] = [];
let ledger: Ledger | null = null;
let reh: R.Rehearsal | null = null;
let worldError: string | null = null;

test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 });

test.describe('AXI-2612 handover suite — coded-grouping field binds as declared @SI-065 @SI-071', () => {
  test.beforeAll(async () => {
    const res = readHandoverConfig(process.env);
    if (!res.ok) {
      configMissing = res.missing;
      return;
    }
    cfg = res.config;
    const preset = JSON.parse(readFileSync(PRESET_PATH, 'utf8')) as Preset;
    const csvBytes = readFileSync(path.resolve(process.cwd(), preset.dataFile.path));
    const token = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
    ledger = new Ledger({
      mode: cfg.mode,
      runToken: token,
      startedAt: new Date().toISOString(),
      target: { label: cfg.targetLabel, baseUrl: cfg.baseUrl, apiBaseUrl: cfg.apiBaseUrl, workspaceId: cfg.workspaceId },
      commits: cfg.commits,
      evidence: evidenceVerdict(cfg),
      preset: { presetId: preset.presetId, presetVersion: preset.presetVersion, dataFileSha256: preset.dataFile.sha256 },
    });
    ledger.paths = { reportRoot: path.resolve(process.cwd(), cfg.reportRoot), slug: `${cfg.runDate}-axi2612-coded-grouping` };
    try {
      const world = await setUpWorld(cfg);
      ledger.report.notes.push(...world.notes);
      ledger.report.identities.push(`investigator ${world.investigatorEmail} (workspace role Investigator) — mapping only, no provisioner workaround expected`);
      reh = R.newRehearsal(cfg, world, ledger, preset, csvBytes, token);
    } catch (err) {
      worldError = (err as Error).message;
      ledger.report.notes.push(`setup failed: ${worldError}`);
    }
  });

  test.afterAll(async () => {
    if (reh && reh.datasetId) {
      const step = reh.ledger.step('CLEAN', 'Clean up');
      await R.runStep(reh, step, () => R.cleanup(reh as R.Rehearsal, step)).catch(() => undefined);
    }
    if (ledger) {
      const dir = ledger.write();
      console.log(`[AXI-2612] report written to ${path.relative(process.cwd(), dir)}`);
    }
  });

  test('AC12612.1 — preset, sign-in, provision and upload succeed (prerequisites for mapping)', async () => {
    expect(configMissing, 'FR2: handover configuration (env only)').toEqual([]);
    expect(worldError, 'FR4: investigator sign-in and workspace read').toBeNull();
    const r = reh as R.Rehearsal;
    for (const [id, title, body] of [
      ['S1', 'Preset against the data file', R.checkPreset] as const,
      ['S2', 'Sign-in, surface and rights', R.signIn] as const,
      ['S3', 'Leftovers of an earlier run', R.sweepLeftovers] as const,
      ['S4', 'Provision the preset study', R.provision] as const,
      ['S5', 'Upload, ingestion, link', R.upload] as const,
    ]) {
      const s = r.ledger.step(id, title);
      await R.runStep(r, s, async () => {
        if (id === 'S1') {
          const problems = await R.checkPreset(r, s);
          if (problems.length > 0) throw new Error(`FR12: preset refused — ${problems.join(' | ')}`);
          return;
        }
        await (body as (rr: R.Rehearsal, ss: typeof s) => Promise<void>)(r, s);
      });
      expect(s.status, `${id} ${title} must succeed to reach mapping`).toBe('pass');
    }
  });

  test('AC12612.2 — a 0/1-coded grouping field (atteinte_pancreatique) binds as declared, zero BLOCK, no provisioner workaround needed', async () => {
    const r = reh as R.Rehearsal;
    expect(r.datasetId, 'S5 must have produced a dataset before mapping is attempted').not.toBeNull();
    const s = r.ledger.step('S6', 'Mapping proposal and confirmation');
    await R.runStep(r, s, () => R.mapping(r, s));

    const defects = r.ledger.report.defects.filter((d) => d.step === 'S6');
    const codedGroupingDefect = defects.find((d) => d.code === 'numeric-coded-grouping-not-bindable');
    // This is the AXI-2612 regression assertion: once the fix is merged, the plan-authorised
    // promotion inside `preflightSapRun` makes `atteinte_pancreatique` conform directly, so
    // `R.mapping`'s own detection of this defect (rehearsal.ts, see module comment) never fires
    // and the provisioner workaround it falls back to is never exercised.
    expect(codedGroupingDefect, `S6: numeric-coded-grouping-not-bindable must NOT be observed once AXI-2612 is merged — ${codedGroupingDefect ? codedGroupingDefect.observed : 'not observed'}`).toBeUndefined();
    expect(defects.map((d) => d.code), 'S6: no other mapping defect expected for the preset').toEqual([]);
    expect(s.status, 'S6 mapping step overall status').toBe('pass');
  });
});
