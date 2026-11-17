/**
 * AXI-2601 (epic AXI-2598 — feature "Investigator Handover: demo path up to prod", §7.1, §10,
 * §11) — the handover suite, `rehearsal` mode, API only.
 *
 * Provisions a fresh study from the preset definition (`fixtures/handover/mag4-preset.json`),
 * uploads the MAG4 file as the Investigator, maps, runs, polls, reads every result page, saves
 * chart evidence, downloads every report and export kind, reviews and signs, then cleans up —
 * asserting one observable fact per step (FR5) and writing a dated report (FR7) to
 * `reports/AXI-2598/<YYYY-MM-DD>-bare-api-rehearsal/`.
 *
 * Outcome semantics (one test per step, serial), decided from the STATIC per-step registry in
 * `harness/known-defects.ts` (`stepVerdict`), code by code:
 *  - pass         — nothing registered for the step, nothing observed;
 *  - expected fail — every defect registered for the step is still observed and nothing else
 *                    (`test.fail`, one assertion per registered code);
 *  - fail         — a registered defect is NO LONGER observed (the fix landed: remove the entry —
 *                    even if another registered defect of the step remains), or a defect NOT in
 *                    the registry was observed (new: report it, then register it), or the harness
 *                    itself stopped;
 *  - skipped      — the step's input could not be produced upstream (the reason is the skip note).
 * `HANDOVER_CONTINUE_ON_DEFECT=1` (discovery runs only) treats every defect as known so the
 * whole chain is walked and every defect after "Start run" is recorded in one run.
 *
 * Run locally (one command, NFR1): `tests/AXI-2598/harness/run-local.sh`. Configuration is env
 * only (FR2) — see `harness/config.ts`. No trace / video / screenshot (project `handover-api`),
 * no LLM call, no token in any output (NFR4, NFR5).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { evidenceVerdict, readHandoverConfig, type HandoverConfig } from './harness/config';
import { matchesCode, stepVerdict } from './harness/known-defects';
import { Ledger, type StepRecord } from './harness/report';
import type { Preset } from './harness/preset';
import * as R from './harness/rehearsal';
import { setUpWorld } from './harness/world';

const PRESET_PATH = path.resolve(process.cwd(), 'fixtures/handover/mag4-preset.json');
const CONTINUE = /^(1|true)$/i.test(process.env.HANDOVER_CONTINUE_ON_DEFECT ?? '');

let cfg: HandoverConfig | null = null;
let configMissing: string[] = [];
let ledger: Ledger | null = null;
let reh: R.Rehearsal | null = null;
let worldError: string | null = null;
let cleanupRan = false;

test.describe.configure({ mode: 'serial', timeout: 25 * 60_000 });

test.describe('AXI-2601 handover suite — bare API rehearsal @SI-042 @SI-044 @SI-053 @SI-014', () => {
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
    ledger.paths = { reportRoot: path.resolve(process.cwd(), cfg.reportRoot), slug: `${cfg.runDate}-bare-api-rehearsal` };
    if (CONTINUE) ledger.report.notes.push('DISCOVERY run (HANDOVER_CONTINUE_ON_DEFECT=1): every defect treated as expected so the whole chain is walked');
    try {
      const world = await setUpWorld(cfg);
      ledger.report.notes.push(...world.notes);
      ledger.report.identities.push(`investigator ${world.investigatorEmail} (workspace role Investigator) — every client-path step`);
      if (cfg.provisioner) ledger.report.identities.push(`provisioner ${cfg.provisioner.email} — project creation only`);
      reh = R.newRehearsal(cfg, world, ledger, preset, csvBytes, token);
    } catch (err) {
      worldError = (err as Error).message;
      ledger.report.notes.push(`setup failed: ${worldError}`);
    }
  });

  test.afterAll(async () => {
    if (reh && !cleanupRan && reh.datasetId) {
      // A step stopped the chain: still remove what this run uploaded (FR6).
      const step = reh.ledger.step('S12', 'Clean up (after an interrupted chain)');
      await R.runStep(reh, step, () => R.cleanup(reh as R.Rehearsal, step)).catch(() => undefined);
    }
    if (ledger) {
      const dir = ledger.write();
      console.log(`[AXI-2601] report written to ${path.relative(process.cwd(), dir)}`);
    }
  });

  /**
   * Run one step and decide its outcome from the STATIC registry for that step (`stepVerdict`):
   * every registered defect still observed (and nothing else) → `test.fail` + one failing
   * assertion per registered code; a registered defect no longer observed (fixed) or an
   * unregistered one (new) → red, naming each code. Blocked → skip with the upstream reason.
   * The decision is taken after the body on purpose: a harness crash re-throws from `runStep`
   * and stays red instead of being absorbed by an up-front `test.fail`.
   */
  async function step(id: string, title: string, needs: string[], body: (r: R.Rehearsal, s: StepRecord) => Promise<void>): Promise<void> {
    expect(configMissing, 'FR2: handover configuration (env only)').toEqual([]);
    expect(worldError, 'FR4/EC13: investigator sign-in and workspace read').toBeNull();
    const r = reh as R.Rehearsal;
    const s = r.ledger.step(id, title);
    const blocked = R.block(r, s, needs);
    test.skip(blocked !== null, blocked ?? '');
    await R.runStep(r, s, () => body(r, s));
    if (s.status === 'blocked') test.skip(true, s.facts.at(-1) ?? 'blocked');
    const defects = r.ledger.report.defects.filter((d) => d.step === id);
    const describeDefect = (code: string): string => defects
      .filter((d) => matchesCode(code, d.code))
      .map((d) => `${d.id} [${d.severity}] ${d.code}: ${d.title} — ${d.endpoint} — observed ${d.observed.slice(0, 300)}`)
      .join(' || ');
    const verdict = stepVerdict(id, defects.map((d) => d.code), CONTINUE);
    if (verdict.outcome === 'fail') {
      s.status = 'fail';
      s.facts.push(verdict.message);
      expect.soft(verdict.fixed, `${id}: registered defect(s) no longer observed — the fix landed, remove the entry from known-defects.ts`).toEqual([]);
      expect(verdict.unknown.map(describeDefect), `${id} ${title}: NEW product defect(s) — report, then register in known-defects.ts`).toEqual([]);
      return;
    }
    if (verdict.outcome === 'expected-fail') {
      s.status = 'known-defect';
      test.fail(true, verdict.message);
      // One assertion per registered code: each must be observed (it is, or the verdict would be `fail`).
      for (const code of verdict.stillPresent) expect.soft(describeDefect(code), `${id}: known defect ${code} (still open)`).toBe('');
      return;
    }
    expect(defects.map((d) => d.code), `${id} ${title}: no defect expected`).toEqual([]);
  }

  test('FR31 EC20 AC1 — environment: target, service commits and evidence status are recorded', async () => {
    expect(configMissing, `FR2: missing configuration ${configMissing.join(', ')}`).toEqual([]);
    const s = (ledger as Ledger).step('S0', 'Environment and service commits');
    const c = cfg as HandoverConfig;
    s.facts.push(`target ${c.targetLabel}; mode ${c.mode}; commits ${c.commits ? `front ${c.commits.front}, back ${c.commits.back}, compute ${c.commits.compute}` : 'NOT RECORDED'}`);
    s.facts.push(`counts as evidence: ${(ledger as Ledger).report.evidence.counts ? 'yes' : 'no'} — ${(ledger as Ledger).report.evidence.reason}`);
    // FR31 / scenario §3.1: the report names each service commit when given; without them the run
    // still completes and the report says it does NOT count as evidence (`evidenceVerdict`) — reported, not asserted.
    expect(c.mode, 'FR3: this spec is the rehearsal mode').toBe('rehearsal');
  });

  test('FR12 EC4 EC6 EC7 AC2 — preset: every field and level equals the data file before anything is provisioned', async () => {
    await step('S1', 'Preset against the data file', [], async (r, s) => {
      const problems = await R.checkPreset(r, s);
      if (problems.length > 0) {
        r.blocked.preset = 'preset refused against the data file';
        throw new Error(`FR12: preset refused — ${problems.join(' | ')}`);
      }
    });
  });

  test('FR4 NFR8 EC13 — sign-in: the Investigator identity lands on the investigator surface and cannot create a project', async () => {
    await step('S2', 'Sign-in, surface and rights', ['preset'], R.signIn);
  });

  test('FR6 FR32 EC1 — leftovers: datasets left by a crashed run of this suite are removed first, nothing else touched', async () => {
    await step('S3', 'Leftovers of an earlier run', ['preset'], R.sweepLeftovers);
  });

  test('FR10 FR11 AC2 EC8 FR32 — provision: new project, protocol, declared plan v1 finalised before data with zero mappings', async () => {
    await step('S4', 'Provision the preset study', ['preset'], R.provision);
  });

  test('FR5 EC1 AC15 — upload: the Investigator uploads the MAG4 file, ingestion becomes ready, the file is linked to the study', async () => {
    await step('S5', 'Upload, ingestion, link', ['preset'], R.upload);
  });

  test('FR5 FR12 — mapping: the proposal matches every field by exact name with zero BLOCK, the Investigator confirms it', async () => {
    await step('S6', 'Mapping proposal and confirmation', ['preset', 'project', 'plan', 'dataset', 'ingestion', 'link'], R.mapping);
  });

  test('FR5 — pre-flight: no refusal, and the run is classified "Planned final look"', async () => {
    await step('S7', 'Pre-flight and classification', ['preset', 'project', 'plan', 'dataset', 'ingestion', 'link', 'mapping'], R.preflight);
  });

  test('FR5 EC4 EC5 NFR2 — run: "Start run" completes, every child run succeeds, every question has a verdict or a reason', async () => {
    await step('S8', 'Start and poll the run', ['preset', 'project', 'plan', 'dataset', 'ingestion', 'link', 'mapping'], R.runPlan);
  });

  test('FR5 — result pages: every question page is ready with a rendered chart, and its chart is saved as evidence', async () => {
    await step('S9', 'Result pages and chart evidence', ['preset', 'project', 'plan', 'mapping', 'run', 'results'], R.resultPages);
  });

  test('FR5 FR7 — downloads: every export and report kind is a non-empty file of the declared type', async () => {
    await step('S10', 'Reports and figures', ['preset', 'project', 'plan', 'mapping', 'run', 'results'], R.downloads);
  });

  test('FR5 — review and sign-off: every question is reviewed, the run is signed, the signed report downloads', async () => {
    await step('S11', 'Review and sign-off', ['preset', 'project', 'plan', 'mapping', 'run'], R.reviewAndSign);
  });

  test('FR6 EC1 AC15 FR32 — cleanup: the uploaded dataset is deleted and the same bytes are accepted again', async () => {
    await step('S12', 'Clean up', ['preset', 'dataset'], async (r, s) => {
      cleanupRan = true;
      await R.cleanup(r, s);
    });
  });

  test('FR7 AC20 NFR4 NFR5 — report: the dated report is written with no token or credential shape', async () => {
    expect(ledger, 'FR7: a ledger exists').not.toBeNull();
    const l = ledger as Ledger;
    // `write()` refuses (throws) when run.json or REPORT.md carries a token/credential shape (NFR4).
    const dir = l.write();
    expect(dir).toContain(`${(cfg as HandoverConfig).runDate}-bare-api-rehearsal`);
    expect(Object.keys(l.report.timings).length, 'FR7: per-step timings are recorded').toBeGreaterThan(0);
  });
});
