import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correlationIdOf } from '../../tests/AXI-1462/harness/shadow';

/**
 * UT-SHADOW-1631-1..4 (epic AXI-1603 — FR28/FR31 join, SI-042). Pure unit
 * coverage for `correlationIdOf`, the extraction this story adds so the FR28
 * shadow harness stops writing `ShadowRunRow`s with no join key. No live
 * backend involved — see
 * `tests/AXI-1462/AXI-1614-compiled-planner-shadow-run.spec.ts` for the live
 * proof that a real plan response actually carries the field.
 *
 * Lives outside `tests/` (like `staging/**` and `capture/**`) because it is a
 * `node:test` file, not a Playwright spec: `tests/` is Playwright's own
 * `testDir` (`playwright.config.ts`) and its `*.spec.ts` glob would otherwise
 * pick this file up and fail to import it. Run via `npm run harness:unit`.
 * See `UT.md` in this directory.
 */

test('UT-SHADOW-1631-1: correlationIdOf reads a string correlationId off the plan API response body', () => {
  assert.equal(correlationIdOf({ correlationId: 'corr-abc-123' }), 'corr-abc-123');
});

test('UT-SHADOW-1631-2: correlationIdOf returns undefined, never a fabricated value, when the response carries none', () => {
  assert.equal(correlationIdOf({}), undefined);
});

test('UT-SHADOW-1631-3: correlationIdOf rejects a non-string correlationId rather than coercing it', () => {
  assert.equal(correlationIdOf({ correlationId: 42 as unknown as string }), undefined);
});

test('UT-SHADOW-1631-4: correlationIdOf treats an empty-string correlationId as "no id", not a real join key', () => {
  assert.equal(correlationIdOf({ correlationId: '' }), undefined);
});
