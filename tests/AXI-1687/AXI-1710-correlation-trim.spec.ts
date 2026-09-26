import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1710 - O.W7 Catalogue growth S4, governed correlation trim (epic AXI-1687). Offline: files
 * and Jest only; no planner, API, provider key or bio-compute process is reached; E2E_LIVE_LLM is
 * never read. Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md O.S4.1 to O.S4.4.
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

test.describe('AXI-1710 governed correlation trim', () => {
  test.beforeEach(requireBack);

  test('O.S4.1 AC102 stats.correlation_trimmed is declared outside the registry with inferential claim keys and required declared parameters @SI-017', () => {
    const claims = codeOnly(`${K}/claim-declarations.ts`);
    expect(claims).toContain("'stats.correlation_trimmed': INFERENTIAL");
    const registry = codeOnly(`${K}/operation-registry.ts`);
    expect(registry).not.toContain('correlation_trimmed');
    const op = codeOnly(`${K}/correlation-trim-operation.ts`);
    for (const k of ['trimCriterion', 'trimValue', 'sensitivityOf']) expect(op).toContain(`key: '${k}'`);
  });

  test('O.S4.2 the trim names dropped subjects, refuses undeclared criteria, and orders primary before sensitivity @SI-045', () => {
    const r = jest([`${K}/correlation-trim-operation.spec.ts`, `${K}/index.spec.ts`, `${K}/operation-registry.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('O.S4.3 AC30 the stats.correlation definition is unchanged and exactly two plan-identity manifests exist @SI-017', () => {
    const reg = codeOnly(`${K}/operation-registry.ts`);
    expect(reg).toContain("operationId: 'stats.correlation'");
    expect(reg).toContain("columns: Object.freeze(['coefficient', 'pValue', 'ciLow', 'ciHigh', 'n', 'reason'])");
    const dir = path.join(BACK_ROOT as string, 'apps/organization-service/src/guided-analysis/plan/compile/__fixtures__/rebaselines');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });
});
