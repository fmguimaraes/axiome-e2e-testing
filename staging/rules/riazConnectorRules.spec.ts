import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  carrierProblems,
  connectorProblems,
  DESCRIBE_CARRIERS,
  findCarrier,
  isEntitled,
  needsGrant,
  RIAZ_CONNECTORS,
  type RuleDetail,
} from './riazConnectorRules';

/**
 * UT-E2E-DESC-022..026 — the connector + carrier staging rules (AXI-1565, epic
 * AXI-1555 FR34). See `staging/steps/UT.md`.
 */

const published = (over: Partial<RuleDetail> = {}): RuleDetail =>
  ({ id: 'r1', code: 'SUM-RANK-01', version: 1, status: 'published', scope: 'system', connector: { operationId: 'describe.grouped_aggregate' }, ...over }) as RuleDetail;

test('UT-E2E-DESC-022: rule access ALL entitles without a grant, NONE cannot be granted, CUSTOM needs one', () => {
  assert.equal(needsGrant('ALL', false), false);
  assert.equal(isEntitled('ALL', false), true);
  assert.equal(needsGrant('CUSTOM', false), true);
  assert.equal(isEntitled('CUSTOM', false), false);
  assert.equal(isEntitled('CUSTOM', true), true);
  assert.equal(needsGrant('NONE', false), false);
  assert.equal(isEntitled('NONE', true), false);
});

test('UT-E2E-DESC-023: a connector that is absent, unpublished or bound to the wrong operation is a problem, a correct one is silent', () => {
  assert.equal(connectorProblems('SUM-RANK-01', 'describe.grouped_aggregate', published(), 'ALL').length, 0);
  assert.match(connectorProblems('SUM-RANK-01', 'describe.grouped_aggregate', undefined, 'ALL')[0], /not published on this stack/);
  assert.match(connectorProblems('SUM-RANK-01', 'describe.grouped_aggregate', published({ status: 'draft' }), 'ALL')[0], /is draft, not published/);
  assert.match(connectorProblems('SUM-COUNT-01', 'describe.count', published(), 'ALL')[0], /binds operation describe\.grouped_aggregate, expected describe\.count/);
  assert.match(connectorProblems('SUM-RANK-01', 'describe.grouped_aggregate', published(), 'NONE')[0], /rule access mode is NONE/);
});

test('UT-E2E-DESC-024: the carrier is resolved by the op: tag the runner matches, newest published version first', () => {
  const rules = [
    published({ id: 'c1', code: 'DESC-GROUPED-AGGREGATE', tags: ['describe', 'op:describe.grouped_aggregate'], version: 1 }),
    published({ id: 'c2', code: 'DESC-GROUPED-AGGREGATE', tags: ['op:describe.grouped_aggregate'], version: 3 }),
    published({ id: 'c3', code: 'DESC-COUNT', tags: ['op:describe.count'], status: 'draft' }),
  ];
  assert.equal(findCarrier(rules, 'describe.grouped_aggregate')?.id, 'c2');
  assert.equal(findCarrier(rules, 'describe.count'), undefined, 'a draft carrier cannot be resolved');
  assert.equal(findCarrier(rules, 'describe.top_n'), undefined);
});

test('UT-E2E-DESC-025: a missing carrier reports the operation that cannot resolve and the remedy', () => {
  const problems = carrierProblems('DESC-TOP-N', 'describe.top_n', undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /op:describe\.top_n/);
  assert.match(problems[0], /create-describe-rules\.ts/);
  assert.deepEqual(carrierProblems('DESC-TOP-N', 'describe.top_n', published({ tags: ['op:describe.top_n'] })), []);
});

test('UT-E2E-DESC-026: the staged surface is the four cited connectors over the three describe operations', () => {
  assert.deepEqual(RIAZ_CONNECTORS.map((c) => c.code), ['SUM-RANK-01', 'SUM-CROSS-01', 'SUM-COUNT-01', 'SUM-TOPN-01']);
  assert.deepEqual([...new Set(RIAZ_CONNECTORS.map((c) => c.operationId))].sort(), DESCRIBE_CARRIERS.map((c) => c.operationId).sort());
});
