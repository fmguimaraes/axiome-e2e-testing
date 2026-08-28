import { test, expect } from '@playwright/test';
import { STAGING_ACTIONS, resolvePathTemplate } from '../../staging/audit/actionCatalog';

/**
 * AXI-1369 — staging action catalog (FR15 mapping input). Manual-E2E
 * §AXI-1368 §5.4. API-level, no browser: pure-data/pure-function checks —
 * live route confirmation is exercised by `npm run stage:audit` against a
 * running instance, not by this spec (that run's real output is recorded in
 * the story report, not re-asserted here to avoid a live-network unit test).
 *
 * @SI-044.
 */

test.describe('FR15 AC3 — every staging action is declared exactly once, and gaps carry a closing story', () => {
  test('FR15 — action ids are unique', () => {
    const ids = STAGING_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('FR15 — every action has a non-empty method and path template', () => {
    for (const action of STAGING_ACTIONS) {
      expect(action.method.length).toBeGreaterThan(0);
      expect(action.pathTemplate.startsWith('/api/v1/')).toBe(true);
    }
  });

  test('AC3 — the four FR16 candidate gaps carry knownGap on every action they touch, each with a closing story', () => {
    // Five actions (resolve+reopen split the "comments has no resolve" candidate
    // into two probeable routes) trace back to the dev-epic-context's four
    // candidate gaps: comments resolve/reopen, display mode, origin filter, volcano params.
    const gaps = STAGING_ACTIONS.filter((a) => a.knownGap);
    expect(gaps).toHaveLength(5);
    for (const gap of gaps) {
      expect(gap.knownGap!.closesInStory).toMatch(/^AXI-\d+$/);
      expect(gap.knownGap!.reason.length).toBeGreaterThan(20);
    }
  });

  test('FR15 — resolvePathTemplate substitutes every :param with a syntactically valid id', () => {
    const resolved = resolvePathTemplate('/api/v1/workspaces/:workspaceId/datasets/:datasetId/finalize');
    expect(resolved).not.toContain(':');
    expect(resolved.split('/')).toHaveLength(8); // leading '' + api,v1,workspaces,<id>,datasets,<id>,finalize
  });

  test('FR15 — resolvePathTemplate is a no-op on a template with no params', () => {
    expect(resolvePathTemplate('/api/v1/events')).toBe('/api/v1/events');
  });
});
