import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, missingRepos } from './harness/sibling-repos';

/**
 * AXI-1738 (epic AXI-1687): run kinds for the derived / referent-less steps + the durable plan-node stamp.
 * Offline: Jest only; E2E_LIVE_LLM is removed from the child env (never set, not even empty).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md, RK1738.1 to RK1738.5
 * (RK1738.6 is manual, with its reason).
 */
test.use({ storageState: { cookies: [], origins: [] } });
const RR = 'apps/organization-service/src/rule-runs';
const KERNEL = `${RR}/kernel`;
const RC = 'apps/organization-service/src/run-completion';
const FAMILY = 'apps/organization-service/src/guided-analysis/family';

const jest = (specs: string[], name?: string) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' };
  delete env.E2E_LIVE_LLM;
  const args = ['jest', ...specs, '--silent', ...(name ? ['-t', name] : [])];
  return spawnSync('npx', args, { cwd: BACK_ROOT, encoding: 'utf8', env, timeout: 5 * 60_000 });
};

test.describe('AXI-1738 (back)', () => {
  test.beforeEach(() => {
    const missing = missingRepos(['back']);
    test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')}`);
  });

  test('RK1738.1 the migration is additive and idempotent and the persisted enum equals the wire enum @SI-017', () => {
    const r = jest([`${RR}/derived-run-kinds.migration.static.spec.ts`, `${RR}/run-kind-schema-parity.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RK1738.2 the derived operations run over recorded inputs and are recorded as a RuleRun-shaped result @SI-017', () => {
    const r = jest([`${KERNEL}/derived-run-kinds.spec.ts`, `${RR}/derived-run.service.spec.ts`]);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RK1738.3 the family step is persisted as a FAMILY_ADJUST record and a sibling comparison is recorded only after a scoped read @SI-047', () => {
    const r = jest([`${FAMILY}/sibling-comparison-step.spec.ts`, `${RC}/durable-plan-node.spec.ts`], 'UT-RUNKIND-1738-(046|047|048|050|051|052)');
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RK1738.4 the plan node is stamped durably on the owned run and read on its own completion only @SI-045', () => {
    const r = jest([`${RC}/durable-plan-node.spec.ts`, `${RC}/run-completion.bus.spec.ts`, 'apps/organization-service/src/result-sentence/statistical-sentence.caller.spec.ts'], undefined);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  test('RK1738.5 the dataset-run path refuses the derived kinds by name; the planner catalog and surface spec are unchanged @SI-017', () => {
    const r = jest([`${RR}/surface-spec`, `${KERNEL}/derived-run-kinds.spec.ts`, `${KERNEL}/index.spec.ts`, `${KERNEL}/operation-vocabulary.static.spec.ts`], undefined);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
