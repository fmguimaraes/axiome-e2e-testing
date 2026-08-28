import { test, expect } from '@playwright/test';
import { IDENTITY_REGISTRY, assertRegistryIntegrity, findIdentity } from '../../staging/identities/registry';

/**
 * AXI-1370 — identity registry integrity (FR1/FR3, Capture Spec §3/§12).
 * API-level, no browser.
 *
 * @SI-044.
 */

test.describe('FR1 FR3 — the identity registry declares the epic\'s identity set', () => {
  test('FR1 — exactly one service-account identity', () => {
    expect(IDENTITY_REGISTRY.filter((d) => d.role === 'service-account')).toHaveLength(1);
  });

  test('FR3 — exactly three distinct internal cast authors (Capture Spec §3)', () => {
    const cast = IDENTITY_REGISTRY.filter((d) => d.role === 'cast');
    expect(cast).toHaveLength(3);
    expect(new Set(cast.map((d) => d.handle)).size).toBe(3);
  });

  test('FR13/Capture Spec §12 — exactly one external stakeholder identity', () => {
    expect(IDENTITY_REGISTRY.filter((d) => d.role === 'external-stakeholder')).toHaveLength(1);
  });

  test('NFR5/AC20 — no entry ever carries a password field', () => {
    for (const entry of IDENTITY_REGISTRY) {
      expect(entry).not.toHaveProperty('password');
    }
  });

  test('registry integrity — every handle is unique', () => {
    expect(() => assertRegistryIntegrity(IDENTITY_REGISTRY)).not.toThrow();
  });

  test('registry integrity — a duplicate handle is rejected', () => {
    const dup = [...IDENTITY_REGISTRY, { ...IDENTITY_REGISTRY[0], email: 'other@axiome.local' }];
    expect(() => assertRegistryIntegrity(dup)).toThrow(/duplicate handle/);
  });

  test('registry integrity — a duplicate email is rejected', () => {
    const dup = [...IDENTITY_REGISTRY, { ...IDENTITY_REGISTRY[0], handle: 'service-2' }];
    expect(() => assertRegistryIntegrity(dup)).toThrow(/duplicate email/);
  });

  test('registry integrity — no service-account entry is rejected', () => {
    const noService = IDENTITY_REGISTRY.filter((d) => d.role !== 'service-account');
    expect(() => assertRegistryIntegrity(noService)).toThrow(/no service-account identity/);
  });

  test('findIdentity — resolves a known handle', () => {
    expect(findIdentity('cast-clinician').role).toBe('cast');
  });

  test('findIdentity — throws for an unknown handle', () => {
    expect(() => findIdentity('not-a-real-handle')).toThrow(/no entry for handle/);
  });
});
