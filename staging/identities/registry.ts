import type { IdentityDefinition, IdentityHandle } from './types';

/**
 * The auth-harness identity set (AXI-1370, FR1/FR3, Capture Spec §3/§12).
 *
 * One service account (the ordinary user the toolkit acts as by default),
 * three distinct internal cast authors (so a collaboration surface has real,
 * separate authorship — §3), and one external stakeholder (the §12 seat).
 *
 * Display names here are role-based placeholders, not the Capture Spec's
 * cast character names — those are staged *content* (FR6) and belong in the
 * versioned content fixture a later story owns. This registry answers "who
 * can authenticate as whom"; it does not answer "what do they say". A later
 * story is free to `PATCH /api/v1/auth/profile` these identities' names once
 * the content fixture exists, without touching this file's shape.
 *
 * No password field anywhere in this file, by design (FR4/NFR5) — see
 * `./credentials.ts` for how each handle's credential is resolved.
 */
export const IDENTITY_REGISTRY: IdentityDefinition[] = [
  {
    handle: 'service',
    email: 'staging-service@axiome.local',
    firstName: 'Staging',
    lastName: 'Service',
    role: 'service-account',
  },
  {
    handle: 'cast-biologist',
    email: 'staging-cast-biologist@axiome.local',
    firstName: 'Cast',
    lastName: 'Biologist',
    role: 'cast',
  },
  {
    handle: 'cast-bioinformatician',
    email: 'staging-cast-bioinformatician@axiome.local',
    firstName: 'Cast',
    lastName: 'Bioinformatician',
    role: 'cast',
  },
  {
    handle: 'cast-clinician',
    email: 'staging-cast-clinician@axiome.local',
    firstName: 'Cast',
    lastName: 'Clinician',
    role: 'cast',
  },
  {
    handle: 'external-stakeholder',
    email: 'staging-external-stakeholder@axiome.local',
    firstName: 'External',
    lastName: 'Stakeholder',
    role: 'external-stakeholder',
  },
];

export function findIdentity(handle: IdentityHandle, registry: IdentityDefinition[] = IDENTITY_REGISTRY): IdentityDefinition {
  const found = registry.find((d) => d.handle === handle);
  if (!found) throw new Error(`identity registry has no entry for handle "${handle}"`);
  return found;
}

/** Registry-integrity guard (defense-in-depth alongside the `IdentityDefinition` type, which has no `password` field). */
export function assertRegistryIntegrity(registry: IdentityDefinition[] = IDENTITY_REGISTRY): void {
  assertNoDuplicates(registry, (d) => d.handle, 'handle');
  assertNoDuplicates(registry, (d) => d.email, 'email');
  assertNoPasswordField(registry);
  assertHasServiceAccount(registry);
}

function assertNoDuplicates(registry: IdentityDefinition[], key: (d: IdentityDefinition) => string, label: string): void {
  const seen = new Set<string>();
  for (const entry of registry) {
    const value = key(entry);
    if (seen.has(value)) throw new Error(`identity registry has a duplicate ${label}: "${value}"`);
    seen.add(value);
  }
}

function assertNoPasswordField(registry: IdentityDefinition[]): void {
  const leaked = registry.filter((d) => 'password' in d);
  if (leaked.length > 0) {
    throw new Error(`identity registry entries must never carry a password field (FR4/NFR5): ${leaked.map((d) => d.handle).join(', ')}`);
  }
}

function assertHasServiceAccount(registry: IdentityDefinition[]): void {
  if (!registry.some((d) => d.role === 'service-account')) {
    throw new Error('identity registry has no service-account identity');
  }
}
