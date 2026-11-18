/**
 * AXI-2663 (epic AXI-2630, FR74, AC55; SI-042). One reproduction run: configuration, the procedure,
 * the comparison with section 20, and the trace. Exit codes: 0 every value matches, 1 a value or
 * response differs, 2 configuration or credentials are missing, 3 a step is blocked.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UnreachableEnvironmentError } from '../../AXI-2598/harness/http';
import { setUpWorld } from '../../AXI-2598/harness/world';
import type { NewModelPreset } from '../harness/new-model-preset';
import { compareWithGolden, type Comparison } from './compare';
import { EXIT_BLOCKED, EXIT_MISMATCH, PROCEDURE_STEPS, StopRun, readResults, verifyInputs, type Procedure } from './procedure';
import { observedFrom } from './read-results';
import { readReproductionConfig, type ReproductionConfig } from './run-config';
import { Trace, writeTrace, type RunEnding } from './trace';

export const EXIT_OK = 0;
export const EXIT_CONFIG = 2;
const PRESET_PATH = 'fixtures/handover/mag4-new-model-preset.json';

export interface RunOutcome extends RunEnding {
  reportDir: string | null;
}

export function endingOf(comparison: Comparison): RunEnding {
  const miss = comparison.firstMismatch;
  if (miss) {
    const message = `Stopped at ${miss.id}: expected ${miss.expected}, actual ${miss.actual}`;
    return { exitCode: EXIT_MISMATCH, verdict: 'MISMATCH', message };
  }
  const residuals = comparison.knownResiduals.map((r) => `${r.id} reads ${r.actual} against ${r.expected} on the slide`);
  const matched = comparison.results.filter((r) => r.outcome === 'match').length;
  const message = `${matched} values match. Known residual: ${residuals.join('; ') || 'none observed'}.`;
  return { exitCode: EXIT_OK, verdict: 'ALL VALUES MATCH', message };
}

async function procedureOf(config: ReproductionConfig, trace: Trace, repoRoot: string, token: string): Promise<Procedure> {
  const preset = JSON.parse(readFileSync(path.join(repoRoot, PRESET_PATH), 'utf8')) as NewModelPreset;
  verifyInputs(repoRoot, preset, trace);
  const world = await setUpWorld(config);
  if (!world.provisioner) throw new StopRun(EXIT_BLOCKED, 'the provisioning identity could not sign in');
  const { investigator, provisioner, workspaceId, organizationId } = world;
  return {
    actors: { investigator, provisioner, workspaceId, organizationId }, trace, preset, repoRoot, token,
    projectId: '', sapId: '', sapVersionId: '', revision: 0,
    fieldIdByName: new Map(), questionIdByKey: new Map(), runIdByKey: new Map(),
  };
}

async function execute(config: ReproductionConfig, trace: Trace, repoRoot: string, token: string): Promise<RunEnding> {
  const procedure = await procedureOf(config, trace, repoRoot, token);
  for (const step of PROCEDURE_STEPS) await step(procedure);
  trace.comparison = compareWithGolden(observedFrom(await readResults(procedure)));
  return endingOf(trace.comparison);
}

function endingOfError(error: unknown): RunEnding {
  const message = error instanceof Error ? error.message : String(error);
  const blocked = error instanceof UnreachableEnvironmentError || (error instanceof StopRun && error.exitCode === EXIT_BLOCKED);
  if (blocked) return { exitCode: EXIT_BLOCKED, verdict: 'BLOCKED', message };
  return { exitCode: EXIT_MISMATCH, verdict: 'STOPPED', message };
}

export async function runReproduction(env: Record<string, string | undefined>, repoRoot: string): Promise<RunOutcome> {
  const parsed = readReproductionConfig(env);
  if (!parsed.ok) {
    const message = `Cannot start. Set these in the environment, then run again:\n- ${parsed.problems.join('\n- ')}`;
    return { exitCode: EXIT_CONFIG, verdict: 'NOT STARTED', message, reportDir: null };
  }
  const token = randomBytes(4).toString('hex');
  const trace = new Trace();
  const ending = await execute(parsed.config, trace, repoRoot, token).catch(endingOfError);
  const slug = `${parsed.config.runDate}-mag4-reproduction-${token}`;
  return { ...ending, reportDir: writeTrace(path.join(repoRoot, parsed.config.reportRoot), slug, trace, ending) };
}
