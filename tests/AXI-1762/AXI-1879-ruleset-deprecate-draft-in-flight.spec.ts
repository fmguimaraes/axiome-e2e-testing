import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ReviewWorld, RuleResponse, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1879 (epic AXI-1762 — FR14; owner ruling 1, 2026-09-28): a RULESET whose
 * member has a draft edit in flight is never silently demoted.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §31 (31.3.1–31.3.3).
 *
 * AXI-1853 closed the single-rule path (`RulesService.deprecate`); this story
 * closes the ruleset path. The guard sits in the ONE helper that supersedes
 * members, so `deprecate`, `activate` and `reactivate` all refuse alike — the
 * owner's ruling applies to all three, and that is asserted here rather than
 * assumed.
 *
 * API-level by design: no ruleset-authoring UI exists. Every call goes through
 * the real gateway to the real organization-service.
 *
 * ⚠️ `admin/rulesets/*` is a GLOBAL, platform-wide surface (one active ruleset
 * at a time, materializing system-scope rules across the whole database — the
 * caveat AXI-1149 and AXI-1808 already record). Run this against a sidecar
 * stack of its own, never a shared demo backend that someone is using.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * A schema-valid import with two FR9-COMPLETE members, so both reach `checked`
 * and can be walked to `published`: §31 needs one member mid-edit (MID-A) and
 * one clean published member (CLEAN-B) that the refusal must NOT name.
 */
function rulesetPayload(labelPrefix: string) {
  const member = (suffix: string, question: string) => ({
    rule_id: unique(`${labelPrefix}-${suffix}`).slice(0, 40),
    name: `AXI-1879 ${suffix} member`,
    category: 'phenotype_detection',
    question,
    logic: { type: 'comparison', operator: '>', field: 'cd4_count', value: 500 },
    // `scoring` is written to the rule's `outputFields` AS-IS, so it must BE the
    // field array, not an object wrapping one. FR9's `protocol_compliance` then
    // requires BOTH of a Feature Rule's output fields; short of either, the member
    // lands `draft`, can never be submitted for review, and this fixture could
    // never reach a published member to fork.
    scoring: [
      { key: 'feature_name', type: 'string', description: 'Name of the computed feature.' },
      { key: 'value', type: 'number', description: 'Numeric feature value per row.' },
    ],
  });
  return {
    name: unique(`AXI-1879 ${labelPrefix}`),
    version: '1.0.0',
    rules: [member('mid-a', 'Is CD4 count elevated?'), member('clean-b', 'Is CD4 count depressed?')],
  };
}

interface Fixture { rulesetId: string; midA: RuleResponse; cleanB: RuleResponse }

async function ruleDetail(world: ReviewWorld, id: string): Promise<RuleResponse> {
  return (await send(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

/** Import a ruleset and leave it DRAFT (nothing materialized yet). */
async function importDraft(world: ReviewWorld, labelPrefix: string): Promise<string> {
  const payload = rulesetPayload(labelPrefix);
  const importRes = await world.admin.post(apiUrl('/api/v1/admin/rulesets/import'), {
    multipart: { file: { name: 'ruleset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) } },
  });
  expect(importRes.status(), await importRes.text()).toBe(201);
  const imported = await importRes.json();
  expect(imported.success, JSON.stringify(imported.validationReport)).toBe(true);
  return imported.ruleset.id as string;
}

async function rulesetStatus(world: ReviewWorld, rulesetId: string): Promise<string> {
  const ruleset = await send(world.admin, 'get', `/api/v1/admin/rulesets/${rulesetId}`);
  return String(ruleset.status ?? ruleset.ruleset?.status).toUpperCase();
}

async function importAndActivate(world: ReviewWorld, labelPrefix: string): Promise<{ rulesetId: string; members: Member[] }> {
  const rulesetId = await importDraft(world, labelPrefix);

  const activateRes = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/activate`));
  // The gateway answers 201 here (the controller's default); 200 is accepted too
  // so this seeding step never becomes the thing under test.
  expect([200, 201], await activateRes.text()).toContain(activateRes.status());

  // The member listing keys each row by `id` + `ruleKey`, and that `id` is the
  // RULESET MEMBER's id, NOT the materialized rule's — a `GET /rules/<member id>`
  // is a 404. The materialized rule is resolved by its `code`, which activation
  // sets to the member's `ruleKey`. The listing order is not guaranteed either,
  // so MID-A and CLEAN-B are always picked by key.
  const listing = await send(world.admin, 'get', `/api/v1/admin/rulesets/${rulesetId}/rules?limit=50`);
  const members = await Promise.all(
    (listing.data as Member[]).map(async (m) => ({ ruleKey: m.ruleKey, id: await materializedRuleId(world, m.ruleKey) })),
  );
  return { rulesetId, members };
}

interface Member { id: string; ruleKey: string }

/** The id of the live rule activation materialized for `ruleKey` (its `code`). */
async function materializedRuleId(world: ReviewWorld, ruleKey: string): Promise<string> {
  const found = await send(world.admin, 'get', `/api/v1/rules?search=${encodeURIComponent(ruleKey)}&limit=50`);
  const row = (found.data as Array<{ id: string; code: string }>).find((r) => r.code === ruleKey);
  if (!row) throw new Error(`no materialized rule with code "${ruleKey}"`);
  return row.id;
}

const memberByKey = (members: Member[], suffix: string): Member => {
  const found = members.find((m) => m.ruleKey.includes(suffix));
  if (!found) throw new Error(`no ruleset member matching "${suffix}" in ${members.map((m) => m.ruleKey).join(', ')}`);
  return found;
};

/** Walk a `checked` member through review to `published` (a second admin is not required here: the member is seeder-authored, not Claude-authored). */
async function publish(world: ReviewWorld, id: string, note: string): Promise<void> {
  await send(world.admin, 'post', `/api/v1/rules/${id}/submit-for-review`);
  const inReview = await ruleDetail(world, id);
  // The approval body's field is `note` — `justification` is rejected with
  // "An approval requires a justification."
  await send(world.admin, 'post', `/api/v1/rules/${id}/approve`, {
    note,
    expectedContentHash: inReview.review!.contentHash,
  });
  expect((await ruleDetail(world, id)).status).toBe('published');
}

/**
 * §31.2: a ruleset whose MID-A is published AND THEN forked by an edit (a draft
 * in flight over a still-served published version), and whose CLEAN-B is
 * published and left alone.
 */
async function seedRulesetMidEdit(world: ReviewWorld, labelPrefix: string): Promise<Fixture> {
  const { rulesetId, members } = await importAndActivate(world, labelPrefix);
  expect(members.length).toBe(2);
  const aId = memberByKey(members, '-mid-a-').id;
  const bId = memberByKey(members, '-clean-b-').id;
  for (const id of [aId, bId]) {
    const detail = await ruleDetail(world, id);
    // Naming the failing FR9 checks here turns "it is draft" into "this check failed".
    expect(detail.status, `FR9 checks: ${JSON.stringify((detail as any).checks ?? (detail as any).review?.checks ?? detail)}`).toBe('checked');
  }

  await publish(world, aId, 'AXI-1879 e2e — publish MID-A before forking it.');
  await publish(world, bId, 'AXI-1879 e2e — publish CLEAN-B and leave it alone.');

  // Any edit to a published rule forks the live row (FR14): that fork, over a
  // still-published version, IS the draft in flight the guard refuses.
  await send(world.admin, 'patch', `/api/v1/rules/${aId}`, { question: 'Is CD4 count elevated (revised)?' });
  const midA = await ruleDetail(world, aId);
  expect(midA.status, 'MID-A is forked onto the editing ladder').not.toBe('published');
  expect(midA.servedVersion, 'MID-A still serves its published version').toBeTruthy();

  const cleanB = await ruleDetail(world, bId);
  expect(cleanB.status).toBe('published');
  const fixture = { rulesetId, midA, cleanB };
  pending.push(fixture);
  return fixture;
}

/** The refusal body of a ruleset lifecycle call that the guard blocks. */
async function refusal(world: ReviewWorld, rulesetId: string, action: 'deprecate' | 'activate' | 'reactivate'): Promise<string> {
  const res = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/${action}`), {
    data: { reason: `AXI-1879 e2e — ${action} with a member mid-edit.` },
  });
  const body = await res.text();
  expect(res.status(), body).toBe(400);
  return body;
}

let world: ReviewWorld;
/** Fixtures whose MID-A may still be mid-edit; see the `afterEach` below. */
const pending: Fixture[] = [];

/**
 * `admin/rulesets` is a GLOBAL surface: activating a ruleset SUPERSEDES the
 * members of the one currently active, so it runs the very guard under test. A
 * fixture left with its MID-A mid-edit therefore blocks the NEXT test's seeding,
 * which would look like a failure of that test rather than leftovers from this
 * one. Serial mode plus this cleanup keeps each test's arrangement its own.
 */
test.describe.configure({ mode: 'serial' });

/**
 * Activation supersedes the members of whichever ruleset is active, so a MID-A
 * this spec left mid-edit in an EARLIER run blocks the first seeding of the next
 * one — the spec would fail on its own leftovers. Resolve them first, scoped to
 * rulesets this spec created (`AXI-1879 ...`) so no one else's rule is touched.
 */
async function resolveLeftoverDrafts(): Promise<void> {
  const listing = await send(world.admin, 'get', '/api/v1/admin/rulesets?limit=100');
  const mine = (listing.data as Array<{ id: string; name: string; status: string }>).filter(
    (r) => r.name.startsWith('AXI-1879 ') && r.status?.toUpperCase() === 'ACTIVE',
  );
  for (const ruleset of mine) {
    const members = await send(world.admin, 'get', `/api/v1/admin/rulesets/${ruleset.id}/rules?limit=50`);
    for (const member of members.data as Member[]) {
      const id = await materializedRuleId(world, member.ruleKey).catch(() => undefined);
      if (!id) continue;
      const detail = await ruleDetail(world, id);
      if (detail.status === 'checked' || detail.status === 'in_review') {
        await publish(world, id, 'AXI-1879 e2e — resolve a draft left in flight by an earlier run.').catch(() => undefined);
      }
    }
  }
}

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  await resolveLeftoverDrafts();
});

test.afterEach(async () => {
  while (pending.length) {
    const fixture = pending.pop()!;
    const current = await ruleDetail(world, fixture.midA.id);
    if (current.status === 'checked' || current.status === 'in_review' || current.status === 'draft') {
      await publish(world, fixture.midA.id, 'AXI-1879 e2e — resolve the in-flight draft so the next test can activate.').catch(() => undefined);
    }
  }
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-1879 — ruleset lifecycle refuses a member with a draft edit in flight', () => {
  test('FR14 (§31.3.1) — deprecating a ruleset with a member mid-edit is refused and writes nothing @SI-017', async () => {
    const { rulesetId, midA, cleanB } = await seedRulesetMidEdit(world, 'deprecate');

    const body = await refusal(world, rulesetId, 'deprecate');
    expect(body).toContain('DEPRECATE_DRAFT_IN_FLIGHT:');
    // The offender is named; the clean member is NOT, and no discard is offered.
    expect(body).toContain(midA.code);
    expect(body).not.toContain(cleanB.code);
    expect(body.toLowerCase()).not.toContain('discard');

    // Nothing was written: the ruleset is still ACTIVE and both members are untouched.
    const ruleset = await send(world.admin, 'get', `/api/v1/admin/rulesets/${rulesetId}`);
    expect(String(ruleset.status ?? ruleset.ruleset?.status).toUpperCase()).toBe('ACTIVE');

    const afterA = await ruleDetail(world, midA.id);
    expect(afterA.status).toBe(midA.status);
    expect(afterA.version).toBe(midA.version);
    const afterB = await ruleDetail(world, cleanB.id);
    expect(afterB.status).toBe('published');
    expect(afterB.version).toBe(cleanB.version);
  });

  test('FR14 (§31.3.2) — once the draft is published, the same ruleset deprecates as before @SI-017', async () => {
    const { rulesetId, midA, cleanB } = await seedRulesetMidEdit(world, 'resolved');

    // There is no discard action — the draft is never dropped, it is published.
    await publish(world, midA.id, 'AXI-1879 e2e — resolve the in-flight draft.');

    const res = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/deprecate`), {
      data: { reason: 'AXI-1879 e2e — deprecate once no draft is in flight.' },
    });
    // The lifecycle routes answer 201 (the controller default); the refusal path
    // is a 400, so accepting either success code never weakens what is asserted.
    expect([200, 201], await res.text()).toContain(res.status());

    for (const member of [midA, cleanB]) {
      const after = await ruleDetail(world, member.id);
      expect(after.status).toBe('deprecated');
      // A new version row is minted for the demotion.
      expect(after.version).toBeGreaterThan(member.version);
    }
  });

  test('FR14 (§31.3.3) — the refusal names the next step and never offers a discard @SI-017', async () => {
    const { rulesetId } = await seedRulesetMidEdit(world, 'wording');
    const body = await refusal(world, rulesetId, 'deprecate');
    expect(body).toContain('submit each draft for review and publish it before retrying');
    expect(body.toLowerCase()).not.toContain('discard');
  });

  test('FR14 (§31.4, owner ruling) — activate and reactivate run the SAME guard, with the same typed reason and no writes @SI-017', async () => {
    // activate/reactivate guard the members of the ruleset they SUPERSEDE (the
    // one currently ACTIVE), not their target's, and each has its own status
    // precondition — activate takes a DRAFT, reactivate a DEPRECATED. So:
    //   Z — activated clean, then superseded by X  → DEPRECATED (reactivate target)
    //   X — the ACTIVE ruleset whose MID-A is mid-edit (the guarded one)
    //   Y — imported only                          → DRAFT (activate target)
    const z = await importAndActivate(world, 'reactivate-target');
    for (const m of z.members) await publish(world, m.id, 'AXI-1879 e2e — publish Z so superseding it is clean.');
    const { rulesetId: xId, midA, cleanB } = await seedRulesetMidEdit(world, 'allthree');
    expect(await rulesetStatus(world, z.rulesetId), 'Z was superseded by X').toBe('DEPRECATED');
    const yId = await importDraft(world, 'activate-target');

    const targets = { activate: yId, reactivate: z.rulesetId } as const;
    for (const action of ['activate', 'reactivate'] as const) {
      const body = await refusal(world, targets[action], action);
      expect(body, `${action} refuses with the same typed reason`).toContain('DEPRECATE_DRAFT_IN_FLIGHT:');
      expect(body, `${action} names the offender`).toContain(midA.code);
      expect(body, `${action} does not name the clean member`).not.toContain(cleanB.code);
    }

    // Neither refusal wrote anything: every ruleset and both members are exactly as seeded.
    expect(await rulesetStatus(world, xId)).toBe('ACTIVE');
    expect(await rulesetStatus(world, yId)).toBe('DRAFT');
    expect(await rulesetStatus(world, z.rulesetId)).toBe('DEPRECATED');
    const afterA = await ruleDetail(world, midA.id);
    expect(afterA.status).toBe(midA.status);
    expect(afterA.version).toBe(midA.version);
    const afterB = await ruleDetail(world, cleanB.id);
    expect(afterB.status).toBe('published');
    expect(afterB.version).toBe(cleanB.version);
  });
});
