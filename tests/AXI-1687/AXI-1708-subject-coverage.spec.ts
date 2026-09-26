import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1708 - O.W7 Catalogue growth S2, subject coverage (epic AXI-1687). Offline: files and Jest
 * only; no planner, API, provider key or bio-compute process is reached; E2E_LIVE_LLM is never read.
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section O.S2.1 to O.S2.4.
 */
test.use({ storageState: { cookies: [], origins: [] } });
const K = 'apps/organization-service/src/rule-runs/kernel';

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

test.describe('AXI-1708 subject coverage', () => {
  test.beforeEach(requireBack);

  test('O.S2.1 AC100 describe.subject_coverage is a new DESCRIBE operation; the three existing describe ids remain @SI-045 @SI-017', () => {
    const src = codeOnly(`${K}/describe-operations.ts`);
    expect(src).toContain("DESCRIBE_SUBJECT_COVERAGE = 'describe.subject_coverage'");
    for (const id of ['describe.grouped_aggregate', 'describe.count', 'describe.top_n']) expect(src).toContain(`'${id}'`);
    expect(src).toContain("role: 'subjectKey'");
    expect(src).toContain("role: 'timepointColumn'");
    expect(src).toContain("key: 'requiredTimepoints'");
  });

  test('O.S2.2 FR100 no inferential column and no claim declaration is needed @SI-017', () => {
    const claims = codeOnly(`${K}/claim-declarations.ts`);
    expect(claims).not.toContain('describe.subject_coverage');
    const src = codeOnly(`${K}/describe-operations.ts`);
    const block = src.slice(src.indexOf('const SUBJECT_COVERAGE'), src.indexOf('return Object.freeze([GROUPED'));
    expect(block).not.toMatch(/pValue|cutoff|interval|'auc'/);
  });

  test('O.S2.3 O.S2.4 Q19 dispatch fails closed and the kernel + describe suites pass @SI-045', () => {
    const r = jest([
      `${K}/subject-coverage-operation.spec.ts`,
      `${K}/describe-operations.spec.ts`,
      `${K}/describe-dispatch.spec.ts`,
      `${K}/operation-registry.spec.ts`,
    ]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
