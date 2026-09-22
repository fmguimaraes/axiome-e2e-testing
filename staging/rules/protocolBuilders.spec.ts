import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_CONTRACT, checkProtocol, decisionRule, interpretRule, qcRule, stratifyRule, summaryRule, featureRule } from './protocolBuilders';
import { RIAZ_RULE_LIBRARY, rulesForQuestion } from './riazRuleLibrary';

const base = { title: 't', question: 'q', logicSummary: 'l', risksNotes: 'r', category: 'qc_guard' as const };

test('every library rule passes the offline protocol check and covers all six protocols', () => {
  const problems = RIAZ_RULE_LIBRARY.flatMap((e) => checkProtocol(e.make()));
  assert.deepEqual(problems, []);
  assert.deepEqual([...new Set(RIAZ_RULE_LIBRARY.map((e) => e.protocol))].sort(), Object.keys(PROTOCOL_CONTRACT).sort());
  assert.equal(new Set(RIAZ_RULE_LIBRARY.map((e) => e.code)).size, RIAZ_RULE_LIBRARY.length, 'codes are unique');
});

test('every question Q1..Q11 cites at least one rule', () => {
  for (let i = 1; i <= 11; i++) assert.ok(rulesForQuestion(`Q${i}`).length > 0, `Q${i}`);
});

test('builders emit the registry-required output fields', () => {
  const keys = (d: { body: Record<string, unknown> }) => (d.body.outputFields as Array<{ key: string }>).map((f) => f.key);
  assert.ok(['include_mask', 'qc_fail_reasons'].every((k) => keys(qcRule({ ...base, code: 'X', signals: [], evaluations: [{ attributeKey: 'a', operator: '>=', value: 1 }] })).includes(k)));
  assert.ok(['feature_name', 'value'].every((k) => keys(featureRule({ ...base, code: 'X', signals: [], featureName: 'f', formula: 'x' })).includes(k)));
  assert.ok(['group_id', 'n_total', 'n_included', 'aggregation_level', 'aggregation_functions'].every((k) => keys(summaryRule({ ...base, code: 'X', signals: ['feature:f'], aggregationLevel: 'GROUP', aggregations: [], evaluations: [{ attributeKey: 'a', operator: '<', value: 1 }] })).includes(k)));
  assert.ok(['stratify_mode', 'group_id', 'n_included'].every((k) => keys(stratifyRule({ ...base, code: 'X', signals: [], mode: 'PREDEFINED_GROUPING', groupBy: { column: 'c', levels: ['a', 'b'] }, evaluations: [] })).includes(k)));
  assert.ok(['output_type', 'confidence', 'evidence_refs', 'scoring_schema'].every((k) => keys(interpretRule({ ...base, code: 'X', signals: ['feature:f'], outputType: 'state_label', labels: ['a'], scoringSchema: {}, evaluations: [{ attributeKey: 'a', operator: '<', value: 1 }] })).includes(k)));
  assert.ok(['decision_type', 'verdict', 'confidence', 'evidence_refs', 'disclaimer_flags'].every((k) => keys(decisionRule({ ...base, code: 'X', signals: [], decisionType: 'go_no_go', verdicts: ['go'], evaluations: [{ attributeKey: 'a', operator: '==', value: 'x' }] })).includes(k)));
});

test('checkProtocol flags a wrong prefix, a missing guard and a missing input', () => {
  const qc = qcRule({ ...base, code: 'X', signals: ['feature:bad'], evaluations: [{ attributeKey: 'a', operator: '>=', value: 1 }] });
  qc.body.guardOutput = null;
  const problems = checkProtocol(qc);
  assert.ok(problems.some((p) => p.includes('prefix')));
  assert.ok(problems.some((p) => p.includes('guardOutput')));
  const sum = summaryRule({ ...base, code: 'Y', signals: ['meta:only'], aggregationLevel: 'COHORT', aggregations: [], evaluations: [{ attributeKey: 'a', operator: '<', value: 1 }] });
  assert.ok(checkProtocol(sum).some((p) => p.includes('must declare')));
});

test('stratify with groupBy builds one OR leaf per level', () => {
  const d = stratifyRule({ ...base, code: 'S', signals: ['meta:response'], mode: 'PREDEFINED_GROUPING', groupBy: { column: 'response', levels: ['R', 'NR'] }, evaluations: [] });
  assert.equal((d.body.attributeEvaluations as unknown[]).length, 2);
  assert.equal((d.body.expression as { type: string }).type, 'OR');
});
