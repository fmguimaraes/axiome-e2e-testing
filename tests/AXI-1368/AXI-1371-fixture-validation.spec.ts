import { test, expect } from '@playwright/test';
import { TENANT_FIXTURE } from '../../staging/fixtures/tenantFixture';
import { assertFixtureValid, checkCastHandlesUnique, checkPublicCohort, validateFixture } from '../../staging/fixtures/validateFixture';
import type { TenantFixture } from '../../staging/fixtures/types';

/**
 * AXI-1371 — content fixture format (FR6) + public-cohort constraint (NFR8).
 * Pure functions, no REST calls. Manual-E2E §AXI-1368 §5.3.
 *
 * @SI-044.
 */

function fixtureWith(overrides: Partial<TenantFixture>): TenantFixture {
  return { ...TENANT_FIXTURE, ...overrides };
}

test.describe('FR6 — the shipped tenant fixture is well-formed', () => {
  test('FR6 — TENANT_FIXTURE passes every fixture-format check', () => {
    expect(validateFixture(TENANT_FIXTURE)).toHaveLength(0);
    expect(() => assertFixtureValid(TENANT_FIXTURE)).not.toThrow();
  });

  test('FR6 — every cast handle is unique', () => {
    expect(checkCastHandlesUnique(TENANT_FIXTURE)).toHaveLength(0);
  });
});

test.describe('NFR8 — the fixture format cannot represent a non-public cohort', () => {
  test('NFR8 — the shipped fixture names only the allow-listed public cohort', () => {
    expect(checkPublicCohort(TENANT_FIXTURE)).toHaveLength(0);
  });

  test('NFR8 — a non-public cohort id is rejected', () => {
    const bad = fixtureWith({ publicCohort: 'ap-hm-cerainom' as TenantFixture['publicCohort'] });
    const violations = checkPublicCohort(bad);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('NFR8');
  });

  test('NFR8 — assertFixtureValid throws for a non-public cohort, naming the rule', () => {
    const bad = fixtureWith({ publicCohort: 'mag4' as TenantFixture['publicCohort'] });
    expect(() => assertFixtureValid(bad)).toThrow(/NFR8/);
  });

  test('NFR8 — an empty-string cohort id is rejected, not silently accepted', () => {
    const bad = fixtureWith({ publicCohort: '' as TenantFixture['publicCohort'] });
    expect(checkPublicCohort(bad)).toHaveLength(1);
  });
});

test.describe('FR6 — schema violations are caught', () => {
  test('FR6 — an empty organization name fails validation', () => {
    const bad = fixtureWith({ org: { ...TENANT_FIXTURE.org, name: '' } });
    expect(validateFixture(bad).some((v) => v.rule === 'schema')).toBe(true);
  });

  test('FR6 — a duplicate cast handle fails validation', () => {
    const bad = fixtureWith({ cast: [TENANT_FIXTURE.cast[0], TENANT_FIXTURE.cast[0]] });
    const violations = validateFixture(bad);
    expect(violations.some((v) => v.rule === 'FR6')).toBe(true);
  });
});
