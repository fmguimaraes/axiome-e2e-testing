import { test, expect } from '@playwright/test';
import { composition, compositionApiAs, type CompositionApi } from '../AXI-2422/harness/composition-api';
import { registryApiAs, type RegistryApi } from '../AXI-2422/harness/registry-api';

/**
 * AXI-2459 (epic AXI-2455 — TPL FR58, FR24, FR25, EC26; AC26, AC29). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2459 (1–4).
 *
 * A template composition MAY declare its main result `{output, pValueField, signedEffectField,
 * cellBound}`; validator check (f) `main_result_declared` BLOCKs an undeclared output or a field the
 * output's step lacks. Every route used is a dry-run or a read: nothing is written to any tenant.
 * Run against a stack serving this branch's organization-service:
 *   `API_BASE_URL=<gateway> npx playwright test tests/AXI-2455/AXI-2459-*`
 */

const MAIN = { output: 'p_value', pValueField: 'pValue', signedEffectField: 'effectSize', cellBound: false };

/** The harness composition plus a `p_value` output read from the Mann-Whitney step `s1`. */
function declaring(mainResult: unknown): any {
  const base = composition();
  const pValue = { name: 'p_value', shape: 'numeric', cardinality: 'one', source: { stepId: 's1', column: 'pValue' } };
  return { ...base, outputs: [...base.outputs, pValue], mainResult };
}

const mainCheckOf = (report: any) => report.checks.find((c: any) => c.checkId === 'main_result_declared');
const codesOf = (findings: any[]) => findings.map((f: any) => f.code);

let user: CompositionApi;
let registry: RegistryApi;

test.beforeAll(async () => {
  user = await compositionApiAs('user');
  registry = await registryApiAs('user');
});
test.afterAll(async () => {
  await user?.dispose();
  await registry?.dispose();
});

test.describe('AXI-2459 — template versions declare their main result', { tag: ['@SI-069', '@SI-070', '@SI-002'] }, () => {
  test('AXI-2459.1 (AC26, FR58): a valid declaration validates PASS on the sixth check, under validator 1.2.0 or later', async () => {
    // Act
    const res = await user.validate({ composition: declaring(MAIN) });
    // Assert
    expect(res.status, res.text).toBe(200);
    expect(res.body.verdict).toBe('PASS');
    expect(mainCheckOf(res.body)).toMatchObject({ verdict: 'PASS', findings: [] });
    const [major, minor] = String(res.body.validatorVersion).split('.').map(Number);
    expect(major > 1 || minor >= 2, res.body.validatorVersion).toBe(true);
  });

  test('AXI-2459.2 (EC26, AC29): an undeclared output, or a field its step lacks, BLOCKs the report', async () => {
    // Act
    const ghostOutput = await user.validate({ composition: declaring({ ...MAIN, output: 'ghost' }) });
    const ghostField = await user.validate({ composition: declaring({ ...MAIN, pValueField: 'pval' }) });
    // Assert
    expect(ghostOutput.body.verdict).toBe('BLOCK');
    expect(codesOf(mainCheckOf(ghostOutput.body).findings)).toEqual(['main_result_output_unknown']);
    expect(ghostField.body.verdict).toBe('BLOCK');
    expect(codesOf(mainCheckOf(ghostField.body).findings)).toEqual(['main_result_field_unknown']);
  });

  test('AXI-2459.3 (FR58): a malformed declaration is refused 400 naming the field', async () => {
    // Act
    const res = await user.validate({ composition: declaring({ ...MAIN, cellBound: 'yes' }) });
    // Assert
    expect(res.status, res.text).toBe(400);
    expect(res.text).toContain('composition.mainResult.cellBound must be a boolean');
  });

  test('AXI-2459.4 (FR58): the immutable T1 0.2 and 0.3 resolve with NO main-result declaration', async () => {
    // Act
    const recipe = await registry.resolve('T1', '0.2');
    const composed = await registry.resolve('T1', '0.3');
    // Assert
    expect(recipe.status, JSON.stringify(recipe.body)).toBe(200);
    expect(composed.status, JSON.stringify(composed.body)).toBe(200);
    expect(recipe.body).not.toHaveProperty('mainResult');
    expect(composed.body).not.toHaveProperty('mainResult');
  });
});
