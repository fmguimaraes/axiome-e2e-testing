import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alreadyStagedChartComment,
  alreadyStagedExternalMessage,
  alreadyStagedInternalComment,
  alreadyStagedReply,
  resolveCommentAuthorHandles,
} from './commentStaging';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';

/**
 * UT-STAGE-040..049 (SI-044) — FR10/AC9's comment-staging idempotency
 * guards (NFR1: a re-run does not duplicate an already-staged comment,
 * reply, or thread message) and the fixture-level AC9 shape check. See
 * `staging/steps/UT.md`.
 */

test('UT-STAGE-040 (AC9): TENANT_FIXTURE declares >= 3 distinct internal-thread authors, >= 1 reply, >= 1 resolved', () => {
  const internal = TENANT_FIXTURE.content.comments.internalThread;
  const authors = new Set(internal.map((c) => c.authorHandle));
  assert.ok(authors.size >= 3, `expected >= 3 distinct authors, got ${authors.size}`);
  assert.ok(internal.some((c) => (c.replies?.length ?? 0) > 0), 'expected at least one comment with a reply');
  assert.ok(internal.some((c) => c.resolved), 'expected at least one comment marked resolved');
});

test('UT-STAGE-041 (AC9): TENANT_FIXTURE declares exactly 4 chart-anchored comments, each targeting a real chart title', () => {
  const chartAnchored = TENANT_FIXTURE.content.comments.chartAnchored;
  assert.equal(chartAnchored.length, 4);
  const chartTitles = new Set(TENANT_FIXTURE.content.chartSpecs.map((c) => c.title));
  for (const comment of chartAnchored) assert.ok(chartTitles.has(comment.chartTitle), `"${comment.chartTitle}" is not a staged chart title`);
});

test('UT-STAGE-042 (AC9): TENANT_FIXTURE declares a non-zero external thread authored solely by the external stakeholder on the client side', () => {
  const external = TENANT_FIXTURE.content.comments.externalThread;
  assert.ok(external.length > 0);
  const clientAuthors = new Set(external.filter((m) => m.authorType === 'client').map((m) => m.authorHandle));
  assert.deepEqual([...clientAuthors], ['external-stakeholder']);
});

test('UT-STAGE-043: resolveCommentAuthorHandles collects every internal-side author (top-level + replies + chart-anchored + internal external-thread posters), excluding the external stakeholder', () => {
  const handles = resolveCommentAuthorHandles({
    internalThread: [{ type: 'question', authorHandle: 'a', text: 'x', replies: [{ authorHandle: 'b', text: 'y' }] }],
    chartAnchored: [{ chartTitle: 't', authorHandle: 'c', text: 'z' }],
    externalThread: [
      { authorHandle: 'external-stakeholder', authorType: 'client', text: 'q' },
      { authorHandle: 'd', authorType: 'internal', text: 'r' },
    ],
  });
  assert.deepEqual(new Set(handles), new Set(['a', 'b', 'c', 'd']));
});

test('UT-STAGE-044 (NFR1): alreadyStagedInternalComment matches on (type, text) and ignores unrelated entries', () => {
  const existing = [{ id: 'c1', commentType: 'assumption', content: 'exact text', status: 'open', replies: [] }];
  const match = alreadyStagedInternalComment(existing, { type: 'assumption', authorHandle: 'x', text: 'exact text' });
  assert.equal(match?.id, 'c1');
  assert.equal(alreadyStagedInternalComment(existing, { type: 'qc_concern', authorHandle: 'x', text: 'exact text' }), undefined);
  assert.equal(alreadyStagedInternalComment(existing, { type: 'assumption', authorHandle: 'x', text: 'different text' }), undefined);
});

test('UT-STAGE-045 (NFR1): alreadyStagedReply matches on text alone within the parent\'s existing replies', () => {
  const replies = [{ id: 'r1', commentType: 'assumption', content: 'Confirmed on v1.', status: 'open', replies: [] }];
  assert.equal(alreadyStagedReply(replies, { authorHandle: 'x', text: 'Confirmed on v1.' }), true);
  assert.equal(alreadyStagedReply(replies, { authorHandle: 'x', text: 'A different reply.' }), false);
});

test('UT-STAGE-046 (NFR1): alreadyStagedChartComment matches on content alone', () => {
  const existing = [{ id: 'x1', content: 'the exact chart comment body' }];
  assert.equal(alreadyStagedChartComment(existing, 'the exact chart comment body'), true);
  assert.equal(alreadyStagedChartComment(existing, 'a different body'), false);
});

test('UT-STAGE-047 (NFR1): alreadyStagedExternalMessage matches on (content, authorType) — a client message and an internal reply with the same text are distinct', () => {
  const existing = [{ content: 'shared wording', authorType: 'client' }];
  assert.equal(alreadyStagedExternalMessage(existing, { authorHandle: 'external-stakeholder', authorType: 'client', text: 'shared wording' }), true);
  assert.equal(alreadyStagedExternalMessage(existing, { authorHandle: 'cn', authorType: 'internal', text: 'shared wording' }), false);
});
