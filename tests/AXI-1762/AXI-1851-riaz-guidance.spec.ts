import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';
import { systemRuleCatalogue } from './seeded-rule-approval';

/**
 * AXI-1851 (epic AXI-1762 — FR1, FR3, FR7, FR9; SI-017): the Riaz 2017 library rules are seeded as
 * Claude-authored SYSTEM rows with complete guidance, so `stage:rules` finds them instead of authoring
 * them as the staging admin.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §30.
 *
 * API only, no browser. No second approver is created or simulated (owner ruling): the spec never
 * approves a Riaz row and never writes `authorKind` or `guidance` into any body.
 *
 * Shared-stack guard: 30.3.3 moves one row `checked -> in_review` (an authoring act). It runs ONLY when
 * `E2E_ALLOW_SEED_APPROVAL=1` is set deliberately, the same opt-in the AXI-1809 helper uses. The
 * approve call it makes is refused by the server, so it writes no approval record.
 *
 * Serial: 30.3.2 and 30.3.3 read the same catalogue snapshot.
 */

const RIAZ_CODES = [
  'RIAZ-QC-COHORT-MINN-01',
  'RIAZ-QC-DE-01',
  'RIAZ-FEAT-IFNG-SCORE-01',
  'RIAZ-FEAT-EXH-SCORE-01',
  'RIAZ-FEAT-APM-SCORE-01',
  'RIAZ-SUM-DE-01',
  'RIAZ-SUM-STRATA-01',
  'RIAZ-STRAT-RESP-01',
  'RIAZ-STRAT-IPI-01',
  'RIAZ-INT-PD1-01',
  'RIAZ-INT-IFNG-01',
  'RIAZ-INT-BASELINE-01',
  'RIAZ-INT-IPI-01',
  'RIAZ-INT-EXH-01',
  'RIAZ-INT-DE-01',
  'RIAZ-INT-STRATA-01',
  'RIAZ-INT-APM-01',
  'RIAZ-INT-SENS-01',
  'RIAZ-DEC-BASELINE-01',
  'RIAZ-DEC-IPI-01',
] as const;

const GUIDANCE_FIELDS = ['whatItDoes', 'whenToUse', 'whenNotToUse', 'example', 'youWillGet'] as const;
const SHARED_STACK_OPT_IN = 'E2E_ALLOW_SEED_APPROVAL';

interface RuleDetail {
  id: string;
  code: string;
  status: string;
  scope: string;
  authorKind?: string | null;
  guidance?: Record<string, string> | null;
  checks?: Array<{ id: string; passed: boolean; message: string }>;
  review?: { contentHash?: string | null } | null;
}

let world: ReviewWorld;
let riazRows: Map<string, { id: string; scope: string }>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  const catalogue = await systemRuleCatalogue(world.admin);
  riazRows = new Map();
  for (const row of catalogue) {
    if (row.code.startsWith('RIAZ-')) riazRows.set(row.code, { id: row.id, scope: row.scope });
  }
});

test.describe('AXI-1851 — Riaz library seed rows', () => {
  test('30.3.1 (AC1) every one of the 20 Riaz library codes exists exactly once as a system row @SI-017', async () => {
    const found = RIAZ_CODES.filter((code) => riazRows.has(code));
    expect(found, 'codes missing from the system catalogue').toEqual([...RIAZ_CODES]);
    for (const code of RIAZ_CODES) expect(riazRows.get(code)?.scope).toBe('system');
  });

  test('30.3.2 (AC2, AC3) each Riaz row is Claude-authored, carries complete guidance, and is not draft @SI-017', async () => {
    const failures: string[] = [];
    for (const code of RIAZ_CODES) {
      const row = riazRows.get(code);
      if (!row) continue;
      const detail: RuleDetail = await send(world.admin, 'get', `/api/v1/rules/${row.id}`);
      if (detail.authorKind !== 'claude') failures.push(`${code}: authorKind ${detail.authorKind}`);
      for (const field of GUIDANCE_FIELDS) {
        const value = detail.guidance?.[field];
        if (typeof value !== 'string' || value.trim().length === 0) failures.push(`${code}: guidance.${field} empty`);
      }
      if (detail.guidance?.whatItDoes && detail.guidance.whatItDoes.length > 200) failures.push(`${code}: whatItDoes over 200`);
      if (detail.guidance?.example && detail.guidance.example.length > 120) failures.push(`${code}: example over 120`);
      if (detail.status === 'draft') {
        const failing = (detail.checks ?? []).filter((c) => !c.passed).map((c) => `${c.id}: ${c.message}`);
        failures.push(`${code}: draft (${failing.join(' | ') || 'no failing check reported'})`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('30.3.3 (AC4) the staging admin cannot approve a Claude-authored Riaz row alone @SI-017', async () => {
    test.skip(
      process.env[SHARED_STACK_OPT_IN] !== '1',
      `30.3.3 moves one row to in_review; set ${SHARED_STACK_OPT_IN}=1 to run it on this stack`,
    );
    const row = riazRows.get('RIAZ-DEC-IPI-01');
    if (!row) throw new Error('RIAZ-DEC-IPI-01 is not in the system catalogue; run 30.3.1 first');

    const before: RuleDetail = await send(world.admin, 'get', `/api/v1/rules/${row.id}`);
    if (before.status === 'checked') {
      await send(world.admin, 'post', `/api/v1/rules/${row.id}/submit-for-review`);
    }
    const reviewed: RuleDetail = await send(world.admin, 'get', `/api/v1/rules/${row.id}`);
    if (reviewed.status !== 'in_review' || !reviewed.review?.contentHash) {
      test.skip(true, `row is ${reviewed.status}; a human already decided it, so no self-approval attempt applies`);
    }

    const res = await world.admin.post(apiUrl(`/api/v1/rules/${row.id}/approve`), {
      data: { note: 'AXI-1851 e2e: self-approval must be refused', expectedContentHash: reviewed.review!.contentHash },
    });
    const body = await res.text();
    expect(res.status()).toBe(403);
    expect(body).toContain('SELF_APPROVAL_CLAUDE_AUTHORED');

    const after: RuleDetail = await send(world.admin, 'get', `/api/v1/rules/${row.id}`);
    expect(after.status).toBe('in_review');
  });
});
