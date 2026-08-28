import { test, expect } from '@playwright/test';
import { assertNoForbiddenNames, findForbiddenNames } from '../../staging/checks/forbiddenNames';
import type { NamedEntity } from '../../staging/checks/forbiddenNames';

/**
 * AXI-1371 — AC4 forbidden-name check. Pure, no REST calls.
 * Manual-E2E §AXI-1368 §5.4.
 *
 * @SI-044.
 */

test.describe('AC4 — Capture Spec §2.1 replace-column names are rejected', () => {
  test('AC4 — the exact leaked dataset filename is flagged (also carries the E2E marker)', () => {
    const hits = findForbiddenNames([{ kind: 'dataset', name: 'axi50-e2e-race.csv' }]);
    expect(hits.map((h) => h.reason)).toContain('Capture Spec §2.1 replace-column name');
  });

  test('AC4 — the exact leaked project name is flagged (also carries the Jira-key marker)', () => {
    const hits = findForbiddenNames([{ kind: 'project', name: 'AXI-1179 - Longitudinal Data Linking and Merging' }]);
    expect(hits.map((h) => h.reason)).toContain('Capture Spec §2.1 replace-column name');
  });

  test('AC4 — the misspelled cast placeholder is flagged even with neither Jira-key nor E2E markers', () => {
    const hits = findForbiddenNames([{ kind: 'user', name: 'Adminstrator CRO One' }]);
    expect(hits.map((h) => h.reason)).toEqual(['Capture Spec §2.1 replace-column name']);
  });
});

test.describe('AC4 — a Jira-key or E2E/test marker is rejected wherever it appears', () => {
  test('AC4 — a project named for a Jira key is flagged even if not in the exact replace list', () => {
    const hits = findForbiddenNames([{ kind: 'project', name: 'AXI-9999 - Some Other Story' }]);
    expect(hits[0].reason).toBe('named for a Jira key');
  });

  test('AC4 — a workspace literally named "E2E Testing" is flagged', () => {
    const hits = findForbiddenNames([{ kind: 'workspace', name: 'E2E Testing' }]);
    expect(hits.map((h) => h.reason)).toContain('named for E2E testing');
  });

  test('AC4 — "test" is only flagged as a whole word, not as a substring of a legitimate name', () => {
    // "P-value histogram, tested universe" is a real future chart title
    // (Capture Spec §6.2) — "tested" must not trip the same rule as
    // "Testing" does, or a legitimate AXI-1374 chart title would fail AC4.
    const hits = findForbiddenNames([{ kind: 'chart', name: 'P-value histogram, tested universe' }]);
    expect(hits).toHaveLength(0);
  });
});

test.describe('AC4 — clean, real staged names pass', () => {
  const clean: NamedEntity[] = [
    { kind: 'organization', name: 'Biotech One' },
    { kind: 'workspace', name: 'Translational Immuno-Oncology' },
    { kind: 'project', name: 'Melanoma IO cohort, paired timepoints' },
    { kind: 'project', name: 'Riaz 2017 — Nivolumab Melanoma' },
  ];

  test('AC4 — the fixture-driven tenant names are all clean', () => {
    expect(findForbiddenNames(clean)).toHaveLength(0);
  });

  test('AC4 — assertNoForbiddenNames does not throw for a clean tenant', () => {
    expect(() => assertNoForbiddenNames(clean)).not.toThrow();
  });

  test('AC4 — assertNoForbiddenNames throws, naming every hit, for a dirty tenant', () => {
    const dirty = [...clean, { kind: 'workspace' as const, name: 'E2E Testing' }];
    expect(() => assertNoForbiddenNames(dirty)).toThrow(/E2E Testing/);
  });
});
