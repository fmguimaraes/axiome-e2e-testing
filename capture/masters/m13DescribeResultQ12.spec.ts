import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTrace, resolveQ12Target } from './m13DescribeResultQ12';

/**
 * UT-E2E-DESC-027..029 — M13's precondition resolution (AXI-1565, epic
 * AXI-1555 FR37). See `staging/steps/UT.md`.
 */

const full = {
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  questions: [
    { id: 'Q4' },
    {
      id: 'Q12',
      viewAnalysisId: 'an-1',
      describe: { results: [{ snapshotId: 'snap-1', sentence: 'HLA-DRA …', citedConnector: 'SUM-RANK-01', decision: { id: 'dec-1' } }] },
    },
  ],
};

test('UT-E2E-DESC-027: a complete trace resolves every id M13 navigates to', () => {
  assert.deepEqual(resolveQ12Target(full), {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    analysisId: 'an-1',
    snapshotId: 'snap-1',
    decisionId: 'dec-1',
    sentence: 'HLA-DRA …',
    connectorCode: 'SUM-RANK-01',
  });
});

test('UT-E2E-DESC-028: a trace without a Q12 describe result blocks with a reason, never a fabricated target', () => {
  assert.match(resolveQ12Target({ ...full, questions: [{ id: 'Q4' }] }) as string, /no Q12/);
  assert.match(resolveQ12Target({ ...full, questions: [{ id: 'Q12', viewAnalysisId: 'an-1' }] }) as string, /no describe result/);
  assert.match(resolveQ12Target({ ...full, organizationId: null }) as string, /no org\/workspace\/project/);
});

test('UT-E2E-DESC-029: a missing trace file is a blocked reason naming the path, not a throw', () => {
  const result = readTrace('/nonexistent/riaz-questions-trace.json');
  assert.equal(typeof result, 'string');
  assert.match(result as string, /no Riaz questions trace at \/nonexistent/);
});
