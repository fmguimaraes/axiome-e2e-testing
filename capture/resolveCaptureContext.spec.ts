import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findApprovedInterpretation, hasFlowCytometryDataset } from './resolveCaptureContext';
import type { Decision } from './resolveCaptureContext';

/** UT-CAP-008..011 — pure decision helpers, unit-tested without a live server. */

test('UT-CAP-008 — hasFlowCytometryDataset is false against the real fixture (OQ4, M12 structurally blocked)', () => {
  // Act / Assert — the fixture's DataRequirement union has no flow-cytometry
  // role at all, so this must be false for the actual committed fixture.
  assert.equal(hasFlowCytometryDataset(), false);
});

test('UT-CAP-009 — findApprovedInterpretation returns the approved decision', () => {
  // Arrange
  const decisions: Decision[] = [
    { id: '1', label: 'reviewed one', status: 'reviewed' },
    { id: '2', label: 'the approved one', status: 'approved' },
  ];
  // Act
  const found = findApprovedInterpretation(decisions);
  // Assert
  assert.equal(found?.id, '2');
});

test('UT-CAP-010 — findApprovedInterpretation returns undefined when none is approved', () => {
  // Arrange
  const decisions: Decision[] = [{ id: '1', label: 'draft', status: 'draft' }];
  // Act / Assert
  assert.equal(findApprovedInterpretation(decisions), undefined);
});

test('UT-CAP-011 — findApprovedInterpretation on an empty list returns undefined', () => {
  // Arrange / Act / Assert
  assert.equal(findApprovedInterpretation([]), undefined);
});
