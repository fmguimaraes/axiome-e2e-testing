import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateInternalThread, evaluateExternalThread, evaluateChartAnchoredCount } from './multiAuthorThreads';

/** UT-STAGE-125..131 (SI-044) — Capture Spec §7/AC9, AXI-1380. */

function internalComment(authorId: string, opts: { status?: string; replyAuthorId?: string } = {}) {
  return { authorId, status: opts.status ?? 'active', replies: opts.replyAuthorId ? [{ authorId: opts.replyAuthorId }] : [] };
}

test('UT-STAGE-125: evaluateInternalThread passes with 3 authors, a reply and a resolved comment', () => {
  const comments = [internalComment('mo'), internalComment('lf', { status: 'resolved', replyAuthorId: 'cn' })];
  assert.equal(evaluateInternalThread(comments).ok, true);
});

test('UT-STAGE-126: evaluateInternalThread fails closed on fewer than 3 distinct authors (EC8)', () => {
  const comments = [internalComment('mo'), internalComment('mo', { replyAuthorId: 'lf' })];
  const result = evaluateInternalThread(comments);
  assert.equal(result.ok, false);
  assert.match(result.detail, /distinct author/);
});

test('UT-STAGE-127: evaluateInternalThread fails when no comment has a reply', () => {
  const comments = [internalComment('mo'), internalComment('lf'), internalComment('cn')];
  const result = evaluateInternalThread(comments);
  assert.equal(result.ok, false);
  assert.match(result.detail, /reply/);
});

test('UT-STAGE-128: evaluateInternalThread fails when no comment is resolved', () => {
  const comments = [internalComment('mo'), internalComment('lf', { replyAuthorId: 'cn' }), internalComment('cn')];
  const result = evaluateInternalThread(comments);
  assert.equal(result.ok, false);
  assert.match(result.detail, /resolved/);
});

test('UT-STAGE-129: evaluateExternalThread fails on an empty thread', () => {
  assert.equal(evaluateExternalThread([]).ok, false);
});

test('UT-STAGE-130: evaluateExternalThread passes when the client side is a single author, an internal reply present', () => {
  const comments = [{ authorId: 'dr', authorType: 'client' }, { authorId: 'cn', authorType: 'internal' }];
  assert.equal(evaluateExternalThread(comments).ok, true);
});

test('UT-STAGE-131: evaluateExternalThread fails when the client side has more than one author', () => {
  const comments = [{ authorId: 'dr', authorType: 'client' }, { authorId: 'other-client', authorType: 'client' }];
  const result = evaluateExternalThread(comments);
  assert.equal(result.ok, false);
  assert.match(result.detail, /expected exactly 1/);
});

test('UT-STAGE-132: evaluateChartAnchoredCount passes when the live count matches the declared count', () => {
  assert.equal(evaluateChartAnchoredCount(4, 4).ok, true);
});

test('UT-STAGE-133: evaluateChartAnchoredCount fails when the live count diverges from the declared count', () => {
  assert.equal(evaluateChartAnchoredCount(2, 4).ok, false);
});
