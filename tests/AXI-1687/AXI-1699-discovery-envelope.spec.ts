import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1699 - N.W5 Discovery envelope (epic AXI-1687). Offline: files and Jest only. No planner, API or
 * provider key is reached; E2E_LIVE_LLM is removed from the child environment (never set, never empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section N.1 to N.5.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const OS = 'apps/organization-service/src';
const GA = `${OS}/guided-analysis`;

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
function jest(specs: string[]) {
  const env = { ...process.env, CI: '1' } as NodeJS.ProcessEnv;
  delete env.E2E_LIVE_LLM;
  return spawnSync('npx', ['jest', ...specs, '--silent'], { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
}
const read = (rel: string) => readFileSync(path.join(BACK_ROOT as string, rel), 'utf8');

test.describe('AXI-1699 discovery envelope', () => {
  test.beforeEach(requireBack);

  test('N.1 AC92 EC40 the envelope gains modality, species and assay family as hard axes; an uncaptured axis blocks @SI-017 @SI-014', () => {
    const r = jest([`${OS}/rule-runs/kernel/discovery-context-envelope.spec.ts`, `${OS}/rule-runs/kernel/index.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(read(`${OS}/rule-runs/kernel/discovery-context-envelope.ts`)).toMatch(/modality:[\s\S]*species:[\s\S]*assayFamily:/);
  });

  test('N.2 AC38 AC92 FR38 the envelope READS the one dataset declaration; a contradiction is refused @SI-014 @SI-017', () => {
    const r = jest([`${OS}/rule-runs/discovery-context.service.spec.ts`, `${OS}/datasets/dataset-semantic-declaration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(read(`${OS}/guided-analysis/discovery/discovery.message.controller.ts`)).toMatch(/declarations\.findCurrent/);
  });

  test('N.3 AC92 ruling 38 IMM-CMP is extended with three hard axis checks, kept off the shared gate @SI-017', () => {
    const r = jest([`${OS}/rule-runs/kernel/comparability-checks.spec.ts`, `${OS}/rule-runs/kernel/precondition-evaluator.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('N.4 AC94 AC96 AC98 EC29 survival, covariate, CV and gated-operation questions route to a typed none @SI-045', () => {
    const r = jest([`${GA}/plan/compile/none-routing.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('N.5 AC93 every narrated number states its unit and representation level, or that none is declared @SI-045', () => {
    const r = jest([`${GA}/plan/unit-statement.spec.ts`, `${GA}/plan/discrimination-narration.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('N.6 AC30 the frozen plan identities are untouched: exactly two re-baseline manifests @SI-045', () => {
    const r = jest([`${GA}/plan/compile/plan-identity-rebaseline.spec.ts`, `${GA}/plan/compile/grados-golden.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
