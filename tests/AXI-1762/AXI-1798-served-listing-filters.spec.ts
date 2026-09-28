import { test, expect } from '@playwright/test';
import {
  Actor,
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  deleteFixtureRules,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1798 (epic AXI-1762 — FR14, EC2, AC12, D1; AXI-1764 review A1): the
 * served listing (`GET /rules?status=published`, every picker's query) judges
 * `search`, `category` and `tags` on what is SERVED — a forked rule's published
 * version — never on its unapproved draft; the page and `meta.total` agree.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §20.
 *
 * Every actor is a throwaway self-registered user holding a throwaway role
 * (AXI-1765 fixtures): an author (`rule:read`) and a reviewer (`rule:read` +
 * `rule:publish`) in a fresh workspace — the admin is never granted
 * `rule:publish`. Every search token is unique per run, so the counts below are
 * exact on any stack.
 */

interface Listing {
  data: RuleResponse[];
  meta: { total: number; page?: number; limit?: number };
}

function token(label: string): string {
  return `${label}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

let world: ReviewWorld;
let author: Actor;
let reviewer: Actor;
let workspaceId: string;

const T = token('t');
const P = token('p');
const PUBLISHED_TITLE = `AXI-1798 published ${T} page ${P}`;
const DRAFT_TITLE = `AXI-1798 draft ${T}`;
const PUBLISHED_TAG = `pub-${T}`;
const DRAFT_TAG = `draft-${T}`;

let forkId: string;
let publishedVersion: number;
let forkLiveStatus: string;
const neverForkedIds: string[] = [];

async function servedListing(query: Record<string, string | number>): Promise<Listing> {
  const params = new URLSearchParams({ status: 'published', ...Object.fromEntries(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  ) });
  const body = (await send(author.api, 'get', `/api/v1/rules?${params.toString()}`)) as Listing;
  expect(Array.isArray(body.data), JSON.stringify(body).slice(0, 300)).toBe(true);
  expect(typeof body.meta?.total).toBe('number');
  return body;
}

/** Create, submit and approve a rule as author → reviewer; returns the published rule. */
async function publishedRule(overrides: Record<string, unknown>): Promise<RuleResponse> {
  const submitted = await inReviewRule(author.api, { scope: 'workspace', workspaceId }, overrides);
  const approved = (await send(reviewer.api, 'post', `/api/v1/rules/${submitted.id}/approve`, {
    note: 'AXI-1798 served-listing fixture approval',
  })) as RuleResponse;
  expect(approved.status).toBe('published');
  return approved;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  world = await ReviewWorld.create();
  author = await world.actor('listing-author', await world.role('listing-reader', ['rule:read']));
  reviewer = await world.actor(
    'listing-reviewer',
    await world.role('listing-publisher', ['rule:read', 'rule:publish']),
  );
  workspaceId = await world.workspace('served-listing', [author, reviewer]);

  // The rule that will be forked: approved with the PUBLISHED content...
  const published = await publishedRule({
    title: PUBLISHED_TITLE,
    category: 'phenotype_detection',
    tags: [PUBLISHED_TAG],
  });
  forkId = published.id;
  publishedVersion = published.version;

  // ...then edited by its author: new title, category and tags nobody approved.
  const edited = (await send(author.api, 'patch', `/api/v1/rules/${forkId}`, {
    title: DRAFT_TITLE,
    category: 'research_stratification',
    tags: [DRAFT_TAG],
    outputFields: COMPLETE_OUTPUT_FIELDS,
    guidance: COMPLETE_GUIDANCE,
  })) as RuleResponse;
  expect(['draft', 'checked']).toContain(edited.status);
  expect(edited.title).toBe(DRAFT_TITLE);
  forkLiveStatus = edited.status;

  // Two never-forked published rules sharing the paging token with the fork.
  for (const suffix of ['a', 'b']) {
    neverForkedIds.push((await publishedRule({ title: `AXI-1798 page ${P} ${suffix}` })).id);
  }
});

test.afterAll(async () => {
  // AXI-1809: soft-delete every rule inReviewRule made, so reruns do not accumulate fixtures.
  if (world) await deleteFixtureRules(world.admin);
  await world?.dispose();
});

test.describe('AXI-1798 — served listing content filters judge the published version', () => {
  // §20.3.1 (AC12, EC2, FR14, D1)
  test('AC12 EC2 — a served search on the NEW draft text does not find the forked rule @SI-017', async () => {
    const listing = await servedListing({ search: `draft ${T}`, limit: 50 });
    expect(listing.data.map((r) => r.id)).not.toContain(forkId);
    expect(listing.meta.total).toBe(0);
    expect(listing.data).toHaveLength(0);
  });

  // §20.3.2 (AC12, EC2)
  test('AC12 EC2 — a served search on the published text finds it, rendered as published, and meta.total agrees @SI-017', async () => {
    const listing = await servedListing({ search: `published ${T}`, limit: 50 });
    expect(listing.meta.total).toBe(1);
    expect(listing.data).toHaveLength(1);
    const row = listing.data[0];
    expect(row.id).toBe(forkId);
    expect(row.status).toBe('published');
    expect(row.title).toBe(PUBLISHED_TITLE);
    expect(row.version).toBe(publishedVersion);
    expect(JSON.stringify(row)).not.toContain(DRAFT_TITLE);
  });

  // §20.3.3 (AC12, FR14)
  test('AC12 FR14 — tags and category are judged on the published version, not the draft @SI-017', async () => {
    const byDraftTag = await servedListing({ tags: DRAFT_TAG, limit: 50 });
    expect(byDraftTag.data.map((r) => r.id)).not.toContain(forkId);
    expect(byDraftTag.meta.total).toBe(0);

    const byPublishedTag = await servedListing({ tags: PUBLISHED_TAG, limit: 50 });
    expect(byPublishedTag.data.map((r) => r.id)).toEqual([forkId]);
    expect(byPublishedTag.meta.total).toBe(1);

    const byDraftCategory = await servedListing({ search: T, category: 'research_stratification', limit: 50 });
    expect(byDraftCategory.data.map((r) => r.id)).not.toContain(forkId);
    expect(byDraftCategory.meta.total).toBe(0);

    const byPublishedCategory = await servedListing({ search: T, category: 'phenotype_detection', limit: 50 });
    expect(byPublishedCategory.data.map((r) => r.id)).toEqual([forkId]);
    expect(byPublishedCategory.meta.total).toBe(1);
  });

  // §20.3.4 (story AC 2)
  test('AC12 — a paged served listing over a forked/never-forked mix has an exact total and no duplicates @SI-017', async () => {
    const expected = [forkId, ...neverForkedIds].sort();
    const seen: string[] = [];
    const totals = new Set<number>();
    for (let page = 1; page <= expected.length + 1; page++) {
      const listing = await servedListing({ search: `page ${P}`, limit: 1, page });
      totals.add(listing.meta.total);
      expect(listing.data.length).toBe(page <= expected.length ? 1 : 0);
      seen.push(...listing.data.map((r) => r.id));
    }
    expect([...totals]).toEqual([expected.length]);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(expected);
  });

  // §20.3.5 (control — FR14: the editing line is still the author's under its live status)
  test('FR14 — control: the live-status listing still matches the draft text @SI-017', async () => {
    const params = new URLSearchParams({ status: forkLiveStatus, search: `draft ${T}`, limit: '50' });
    const listing = (await send(author.api, 'get', `/api/v1/rules?${params.toString()}`)) as Listing;
    const row = listing.data.find((r) => r.id === forkId);
    expect(row, 'the editing line is listed under its live status').toBeDefined();
    expect(row!.title).toBe(DRAFT_TITLE);
    expect(listing.meta.total).toBe(1);
  });
});
