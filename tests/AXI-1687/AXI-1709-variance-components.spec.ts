import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1709 - O.W7 Catalogue growth S3, variance components & disease-adjusted site test (epic
 * AXI-1687; FR37, FR101; ruling 31). Offline: files and Jest only; no planner, API, provider key
 * or bio-compute process is reached; E2E_LIVE_LLM is never read. Scenario doc:
 * manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md VC1709.1 to VC1709.6.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const K = 'apps/organization-service/src/rule-runs/kernel';
const P = 'apps/organization-service/src/guided-analysis/plan';

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
}
const codeOnly = (file: string): string =>
  readFileSync(path.join(BACK_ROOT as string, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

function jest(specs: string[]) {
  return spawnSync('npx', ['jest', ...specs, '--silent'], {
    cwd: path.join(BACK_ROOT as string, 'apps/organization-service'),
    encoding: 'utf8',
    env: { ...process.env, CI: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
}

test.describe('AXI-1709 variance components & adjusted site test', () => {
  test.beforeEach(requireBack);

  test('VC1709.1 site_partition/batch_partition are declarable scope roles on the dataset semantic declaration @SI-045', () => {
    const declaration = codeOnly('libs/contracts/src/dataset/dataset-semantic-declaration.ts');
    expect(declaration).toContain("'site_partition'");
    expect(declaration).toContain("'batch_partition'");
    const r = jest(['apps/organization-service/src/datasets/dataset-semantic-declaration.spec.ts']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.2 a dataset declaring both partitions registers batch_variance_explained as having a producer @SI-017', () => {
    const offering = codeOnly(`${P}/qc-rule-offering.ts`);
    expect(offering).toContain('attributeHasRegisteredProducer');
    expect(offering).toContain('declarationMetaKeysOf');
    const r = jest([`${P}/qc-rule-offering.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.3 the attribute resolver computes a real eta-squared, never a passthrough hint @SI-045', () => {
    const r = jest([`${K}/qc-attribute-resolver-registry.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.4 stats.site_batch_variance_test is registered STATISTICAL/INFERENTIAL with declared censoringSubstitution, existing 37 operations untouched @SI-017', () => {
    const registry = codeOnly(`${K}/operation-registry.ts`);
    expect(registry).toContain("operationId: 'stats.site_batch_variance_test'");
    const claims = codeOnly(`${K}/claim-declarations.ts`);
    expect(claims).toContain("'stats.site_batch_variance_test': INFERENTIAL");
    const r = jest([`${K}/operation-registry.spec.ts`, `${K}/index.spec.ts`, `${K}/rule-run-operation.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.5 the variance_components_test compiled shape binds site/batch from the dataset declaration, familyId signals correction membership @SI-045', () => {
    const shapesIndex = codeOnly(`${P}/compile/shapes/index.ts`);
    expect(shapesIndex).toContain('VARIANCE_COMPONENTS_TEST_SHAPE');
    expect(shapesIndex).toContain('variance_components_test: VARIANCE_COMPONENTS_TEST_SHAPE');
    const shape = codeOnly(`${P}/compile/shapes/variance-components-test.shape.ts`);
    expect(shape).not.toContain('in_correction_family');
    const r = jest([`${P}/compile/shapes/variance-components-test.shape.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.6 readDeclaredMeta projects site/batch columns; NodeScopePolicy stays total over every declared scope-role kind @SI-017', () => {
    const scope = codeOnly(`${P}/declared-scope.ts`);
    expect(scope).toContain('site_partition');
    expect(scope).toContain('batch_partition');
    const r = jest([
      `${P}/declared-scope.spec.ts`,
      'apps/organization-service/src/rule-runs/qc-run-executor.service.spec.ts',
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('VC1709.7 the grados-golden and per-shape compile-identity suites are unmoved by the new dataset/shape @SI-017', () => {
    const r = jest([
      `${P}/compile/grados-golden.spec.ts`,
      `${P}/compile/compile-intent.spec.ts`,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
