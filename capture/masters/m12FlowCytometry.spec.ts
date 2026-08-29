import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureM12 } from './m12FlowCytometry';

test('UT-CAP-036 — M12 reports blocked against the real fixture (OQ4)', () => {
  const result = captureM12();
  assert.equal(result.status, 'blocked');
  assert.match(result.detail, /OQ4/);
  assert.equal(result.id, 'M12');
});
