/**
 * AXI-2612 (epic AXI-2598 — regression spec for the FIXED `numeric-coded-grouping-not-bindable`
 * defect, originally found by the AXI-2601 rehearsal's S6 step and removed from
 * `harness/known-defects.ts` once the fix merged) — isolates the mapping step: provision the
 * preset study through upload, then request the data-binding proposal for a plan declaring a
 * 0/1-coded grouping field (`atteinte_pancreatique`), and assert no `role_mismatch`/
 * `level_not_measured` BLOCK is raised for it, and the Investigator (no
 * `governs_analysis_parameters`) can confirm the mapping directly — never needing the
 * provisioner's dataset-semantic-declaration workaround `R.mapping` used to fall back to.
 *
 * Reuses the AXI-2601 bare-API rehearsal harness end to end (world/preset/provision/upload) —
 * this spec adds no new provisioning path. The prerequisite steps (S1–S5) assert through the
 * SAME `stepVerdict` known-defect machinery the AXI-2601 spec uses (`assertPrerequisite` below):
 * a registered, already-known defect whose step still produced its output (e.g. S5's D1
 * `duplicate-of-foreign-dataset` fallback to a salted upload) satisfies the prerequisite rather
 * than hard-failing it — a NEW or no-longer-observed defect still fails, never silently masked.
 *
 * Configuration is env only, same as AXI-2601 (`harness/config.ts`). No trace/video/screenshot
 * (project `handover-api`, widened `HANDOVER_SPEC` in `playwright.config.ts`), no LLM call, no
 * token in any output.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { evidenceVerdict, readHandoverConfig, type HandoverConfig } from './harness/config';
import { stepVerdict } from './harness/known-defects';
import { Ledger, type StepRecord } from './harness/report';
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

  /**
   * A prerequisite step is satisfied when it is a clean `pass`, OR when every defect it
   * observed is a REGISTERED known defect for that step AND the step still produced the
   * output the next step needs (checked by the caller via `producedOutput`) — the same
   * `stepVerdict` machinery `AXI-2601-bare-api-rehearsal.spec.ts` uses, never a bare
   * `status === 'pass'` check. A registered defect no longer observed (fixed — remove the
   * entry from `known-defects.ts`) or an unregistered one (new defect) still FAILS: this
   * never silently masks a new defect, it only stops re-failing an ALREADY-registered,
   * ALREADY-reported one whose fallback still lets the chain continue.
   */
  function assertPrerequisite(step: StepRecord, defects: readonly { step: string; code: string }[], producedOutput: boolean, label: string): void {
    const codes = defects.filter((d) => d.step === step.id).map((d) => d.code);
    const verdict = stepVerdict(step.id, codes);
    expect(verdict.outcome, `${label}: ${verdict.message}`).not.toBe('fail');
    expect(producedOutput, `${label}: step reported ${verdict.outcome} but produced no usable output for the next step`).toBe(true);
  }

  test('AC12612.1 — preset, sign-in, provision and upload succeed (prerequisites for mapping)', async () => {
    expect(configMissing, 'FR2: handover configuration (env only)').toEqual([]);
    expect(worldError, 'FR4: investigator sign-in and workspace read').toBeNull();
    const r = reh as R.Rehearsal;

    const s1 = r.ledger.step('S1', 'Preset against the data file');
    await R.runStep(r, s1, async () => {
      const problems = await R.checkPreset(r, s1);
      if (problems.length > 0) throw new Error(`FR12: preset refused — ${problems.join(' | ')}`);
    });
    expect(s1.status, 'S1 Preset against the data file').toBe('pass');

    const s2 = r.ledger.step('S2', 'Sign-in, surface and rights');
    await R.runStep(r, s2, () => R.signIn(r, s2));
    expect(s2.status, 'S2 Sign-in, surface and rights').toBe('pass');

    const s3 = r.ledger.step('S3', 'Leftovers of an earlier run');
    await R.runStep(r, s3, () => R.sweepLeftovers(r, s3));
    expect(s3.status, 'S3 Leftovers of an earlier run').toBe('pass');

    const s4 = r.ledger.step('S4', 'Provision the preset study');
    await R.runStep(r, s4, () => R.provision(r, s4));
    expect(s4.status, 'S4 Provision the preset study').toBe('pass');

    // S5 (upload) is where the registered D1 known defect lives (`duplicate-of-foreign-dataset`,
    // AXI-2538): the exact preset file can be refused as a duplicate of another study's upload,
    // and `R.upload` falls back to a salted variant of the same bytes, still producing a usable
    // dataset. A bare `status === 'pass'` check would hard-fail this prerequisite on a defect
    // the rehearsal itself already classifies and tolerates — assert through the SAME verdict
    // machinery instead.
    const s5 = r.ledger.step('S5', 'Upload, ingestion, link');
    await R.runStep(r, s5, () => R.upload(r, s5));
    assertPrerequisite(s5, r.ledger.report.defects, r.datasetId !== null, 'S5 Upload, ingestion, link');
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
