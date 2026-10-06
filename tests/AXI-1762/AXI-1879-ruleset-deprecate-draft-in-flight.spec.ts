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
    scoring: { outputFields: [{ key: 'value', type: 'number', description: 'Computed value.' }] },
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

async function importAndActivate(world: ReviewWorld, labelPrefix: string): Promise<{ rulesetId: string; members: Member[] }> {
  const payload = rulesetPayload(labelPrefix);
  const importRes = await world.admin.post(apiUrl('/api/v1/admin/rulesets/import'), {
    multipart: { file: { name: 'ruleset.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) } },
  });
  expect(importRes.status(), await importRes.text()).toBe(201);
  const imported = await importRes.json();
  expect(imported.success, JSON.stringify(imported.validationReport)).toBe(true);
  const rulesetId = imported.ruleset.id as string;

  const activateRes = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/activate`));
  // The gateway answers 201 here (the controller's default); 200 is accepted too
  // so this seeding step never becomes the thing under test.
  expect([200, 201], await activateRes.text()).toContain(activateRes.status());

  // The member listing keys each row by `id` + `ruleKey`; the order is not
  // guaranteed, so MID-A and CLEAN-B are picked by their key, never by index.
  const rulesRes = await send(world.admin, 'get', `/api/v1/admin/rulesets/${rulesetId}/rules?limit=50`);
  return { rulesetId, members: rulesRes.data as Member[] };
}

interface Member { id: string; ruleKey: string }

const memberByKey = (members: Member[], suffix: string): Member => {
  const found = members.find((m) => m.ruleKey.includes(suffix));
  if (!found) throw new Error(`no ruleset member matching "${suffix}" in ${members.map((m) => m.ruleKey).join(', ')}`);
  return found;
};

/** Walk a `checked` member through review to `published` (a second admin is not required here: the member is seeder-authored, not Claude-authored). */
async function publish(world: ReviewWorld, id: string, note: string): Promise<void> {
  await send(world.admin, 'post', `/api/v1/rules/${id}/submit-for-review`);
  const inReview = await ruleDetail(world, id);
  await send(world.admin, 'post', `/api/v1/rules/${id}/approve`, {
    justification: note,
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
  for (const id of [aId, bId]) expect((await ruleDetail(world, id)).status).toBe('checked');

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
  return { rulesetId, midA, cleanB };
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

test.beforeAll(async () => {
  world = await ReviewWorld.create();
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
    expect(res.status(), await res.text()).toBe(200);

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
    const { rulesetId, midA, cleanB } = await seedRulesetMidEdit(world, 'allthree');

    for (const action of ['activate', 'reactivate'] as const) {
      const body = await refusal(world, rulesetId, action);
      expect(body, `${action} refuses with the same typed reason`).toContain('DEPRECATE_DRAFT_IN_FLIGHT:');
      expect(body, `${action} names the offender`).toContain(midA.code);
      expect(body, `${action} does not name the clean member`).not.toContain(cleanB.code);
    }

    // Neither refusal wrote anything: both members are exactly as seeded.
    const afterA = await ruleDetail(world, midA.id);
    expect(afterA.status).toBe(midA.status);
    expect(afterA.version).toBe(midA.version);
    const afterB = await ruleDetail(world, cleanB.id);
    expect(afterB.status).toBe('published');
    expect(afterB.version).toBe(cleanB.version);
  });
});
