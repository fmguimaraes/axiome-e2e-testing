import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1692 - D.W3 QC wiring, early (epic AXI-1687, area D; FR31-FR34, FR37).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`,
 * section "AXI-1692 section" G.1 to G.5.
 *
 * HARD RULE FOR THIS FILE (NFR1, zero LLM spend): no scenario opens the planner, calls the API
 * or reaches any endpoint that could touch the platform's Anthropic key. The QC wiring has no
 * browser surface: its facts are SOURCE FILES and the OFFLINE Jest suites (pure builder,
 * compiler goldens, mocked adapter, in-process QC executor). `E2E_LIVE_LLM` is never read here
 * and is forced empty for the child process.
 */

const GA = 'apps/organization-service/src/guided-analysis';
const PLAN = () => path.join(BACK_ROOT as string, GA, 'plan');
const read = (p: string) => readFileSync(p, 'utf8');

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')} - set AXIOME_*_ROOT`);
}

function runJest(suites: readonly string[]): { status: number | null; summary: string } {
  const r = spawnSync('npx', ['jest', '-c', 'apps/organization-service/jest.config.ts', ...suites, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
  return { status: r.status, summary: `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

test.describe('AXI-1692 G.1 - one options builder serves every consumer (AC31)', { tag: ['@SI-045'] }, () => {
  test('AC31: the builder is defined once and called by the service, both adapters and the golden spec', async () => {
    requireBack();
    const validator = read(path.join(PLAN(), 'plan-validator.ts'));
    expect(validator.match(/export function plannerValidationOptions\(/g)).toHaveLength(1);
    for (const file of ['planner.service.ts', 'compiled-planner.adapter.ts', 'anthropic-planner.adapter.ts', 'compile/grados-golden.spec.ts']) {
      expect(read(path.join(PLAN(), file)), `${file} calls the builder`).toMatch(/plannerValidationOptions\(/);
    }
    // The compiled adapter's I08 no longer sees connector codes alone.
    const compiled = read(path.join(PLAN(), 'compiled-planner.adapter.ts'));
    expect(compiled).toMatch(/availableRuleCodes: intentRuleCodes\(built\)/);
    expect(compiled).not.toMatch(/availableRuleCodes: connectors\.map/);

    const run = runJest(['planner-validation-options']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
    expect(run.summary).toMatch(/Tests:\s+\d+ passed/);
  });
});

test.describe('AXI-1692 G.2 - the seed tenant is offered IMM-QC-01 and IMM-QC-12, never IMM-QC-02 (AC32, AC37, EC17)', { tag: ['@SI-045', '@SI-017'] }, () => {
  test('AC32 AC37 EC17: batch_variance_explained has no registered producer, so IMM-QC-02 is withheld and its citation refused by I08', async () => {
    requireBack();
    const registry = read(path.join(BACK_ROOT as string, 'apps/organization-service/src/rule-runs/kernel/qc-attribute-resolver-registry.ts'));
    const block = registry.slice(
      registry.indexOf("attributeKey: 'batch_variance_explained'"),
      registry.indexOf("attributeKey: 'parent_event_count'"),
    );
    expect(block).not.toMatch(/producer:/);
    for (const key of ['sample_size', 'min_arm_subjects']) {
      const at = registry.indexOf(`attributeKey: ${key === 'min_arm_subjects' ? 'ARM_SUBJECTS_ATTRIBUTE_KEY' : `'${key}'`}`);
      expect(registry.slice(at, at + 400), `${key} declares a derived producer`).toMatch(/producer: Object\.freeze\(\{ kind: 'derived'/);
    }

    const run = runJest(['planner-validation-options', 'compiled-planner.adapter.spec', 'qc-rule-offering']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
  });
});

test.describe('AXI-1692 G.3 - cached qcRules block without thresholds; two hashes on the attempt line (AC33)', { tag: ['@SI-045'] }, () => {
  test('AC33: the compiled adapter renders qcRules, drops the raw catalogue and logs both digests', async () => {
    requireBack();
    const compiled = read(path.join(PLAN(), 'compiled-planner.adapter.ts'));
    expect(compiled).toMatch(/\.\.\.\(qcRules\.length \? \{ qcRules \} : \{\}\)/);
    expect(compiled).toMatch(/availableRules: _catalogue/);
    const telemetry = read(path.join(PLAN(), 'compile/attempt-telemetry.ts'));
    expect(telemetry).toMatch(/readonly offeredRuleCodesHash: string/);
    expect(telemetry).toMatch(/readonly connectorRulesHash: string/);
    // The cached view type carries exactly code, name, checks.
    const offering = read(path.join(PLAN(), 'qc-rule-offering.ts'));
    const view = offering.slice(offering.indexOf('export interface QcRuleView'), offering.indexOf('export function qcRuleViews'));
    expect(view).toMatch(/code: string/);
    expect(view).toMatch(/name: string/);
    expect(view).toMatch(/checks: readonly string\[\]/);
    expect(view).not.toMatch(/readonly (operator|value|threshold)/);

    const run = runJest(['compiled-planner.adapter.spec', 'planner-validation-options']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
  });
});

test.describe('AXI-1692 G.4 - per-arm n is counted in subjects and narrated as such (AC34)', { tag: ['@SI-045', '@SI-017'] }, () => {
  test('AC34: 10 subjects and 20 rows per arm is n = 10; IMM-QC-01 says "rows in scope"; bindings reach the QC run', async () => {
    requireBack();
    const seeds = read(path.join(BACK_ROOT as string, 'apps/organization-service/src/rules/seed-rules.ts'));
    expect(seeds).toMatch(/code: 'IMM-QC-12'/);
    expect(seeds).toMatch(/attributeKey: 'min_arm_subjects'/);
    const shape = read(path.join(PLAN(), 'compile/shapes/qc-check.shape.ts'));
    expect(shape).toMatch(/'IMM-QC-01': 'rows in scope'/);
    expect(shape).toMatch(/armSubjectBindings\(groupingColumn, subjectColumn\)/);
    const runner = read(path.join(BACK_ROOT as string, 'apps/organization-service/src/governed-execution/executor/rule-runs-analysis-runner.ts'));
    expect(runner).toMatch(/columnBindingsParam\(input\.params\)/);

    const run = runJest(['qc-attribute-resolver-registry', 'qc-run-executor.service', 'rule-runs-analysis-runner', 'planner-validation-options']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
  });
});

test.describe('AXI-1692 G.5 - the golden spec carries no rule list of its own (AC31, FR21)', { tag: ['@SI-045'] }, () => {
  test('AC31: no RULE_CODES constant and no qcChecksEnabled literal; the golden suite is green', async () => {
    requireBack();
    const raw = read(path.join(PLAN(), 'compile/grados-golden.spec.ts'));
    // Code only: the history comments legitimately name the removed literals.
    const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src).not.toMatch(new RegExp('const RULE' + '_CODES\\b'));
    expect(src).not.toMatch(/qcChecksEnabled: true/);
    expect(src).toMatch(/plannerValidationOptions\(seedTenantCtx\)/);

    const run = runJest(['plan/compile/grados-golden']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
  });
});
