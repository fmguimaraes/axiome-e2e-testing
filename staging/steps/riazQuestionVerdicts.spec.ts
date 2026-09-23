import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveGuidedTracePath } from './riazQuestionVerdicts';

/**
 * UT-STAGE-173..175 — where `q1Context()` looks for the Q1 guided trace
 * (AXI-1553 review finding: a cwd-relative default silently resolved to
 * nothing from a story worktree, and the missing-file read failure was
 * swallowed into a wrong `not_evaluable` verdict instead of failing loudly).
 * See `staging/steps/UT.md`.
 */

test('UT-STAGE-173: STAGING_RIAZ_GUIDED_TRACE wins outright when set, regardless of the questions trace path', () => {
  assert.equal(
    deriveGuidedTracePath('/tmp/some/riaz-questions-trace.json', '/explicit/riaz-guided-trace.json'),
    '/explicit/riaz-guided-trace.json',
  );
});

test('UT-STAGE-174: with no override, the guided trace is derived as a SIBLING of the questions trace path', () => {
  assert.equal(
    deriveGuidedTracePath('/home/felipe/dev/axiome/axiome-global/axiome-docs/demo/riaz-2017/riaz-questions-trace.json', undefined),
    '/home/felipe/dev/axiome/axiome-global/axiome-docs/demo/riaz-2017/riaz-guided-trace.json',
  );
});

test('UT-STAGE-175: with neither env var set, falls back to the historical cwd-relative default', () => {
  assert.equal(deriveGuidedTracePath(undefined, undefined), '../axiome-docs/demo/riaz-2017/riaz-guided-trace.json');
  assert.equal(deriveGuidedTracePath('', ''), '../axiome-docs/demo/riaz-2017/riaz-guided-trace.json');
});
