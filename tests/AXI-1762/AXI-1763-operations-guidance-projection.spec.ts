import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1763 (epic AXI-1762 — FR1, FR2, FR5): `GET /rule-runs/operations`
 * projects `description`/`guidance` on every operation and `help` on every
 * parameter/column-role slot.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §4.1.
 *
 * This story ships no authored guidance content (that is AXI-1769–1771), so
 * the live assertion is the CONTRACT: the keys are always present, and
 * `null` — never a missing key — is how "nothing declared yet" is expressed.
 * A hand-built form/consumer that treats a missing key and a `null` value the
 * same way would pass a unit test against a hand-rolled fixture and fail
 * exactly this call against the real, shared kernel registry.
 */
interface OperationHelp {
  label: string;
  what: string;
  why: string;
  example: string;
  valueLabels: Record<string, string> | null;
}

interface OperationGuidance {
  whatItDoes: string;
  whenToUse: string;
  whenNotToUse: string;
  example: string;
  youWillGet: string;
}

interface OperationDescriptor {
  operationId: string;
  description: string;
  guidance: OperationGuidance | null;
  parameters: Array<{ key: string; help: OperationHelp | null }>;
  columnRoles: Array<{ role: string; help: OperationHelp | null }>;
}

// AXI-1763's Authorization is header-based (`Bearer <token>`), never a cookie
// — the `storageState` role fixture (AXI-1264) writes the token into the
// front-end's localStorage for the BROWSER (`page`) fixture only, so an
// API-only spec must obtain its own token exactly like the auth setup project
// does, and attach it explicitly (`config/auth.ts`'s `ensureAuthTokens`).
test('AC14 — GET /rule-runs/operations projects description, guidance and help, null where undeclared', async ({
  request,
}) => {
  const admin = ROLES.find((role) => role.name === 'admin')!;
  const { accessToken } = await ensureAuthTokens(request, admin);

  const response = await request.get(apiUrl('/api/v1/rule-runs/operations'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(response.status()).toBe(200);

  const body = await response.json();
  const operations: OperationDescriptor[] = body.operations ?? [];
  expect(operations.length).toBeGreaterThan(0);

  for (const operation of operations) {
    // `description` is un-withheld (§4.7) — always a non-empty string, never
    // absent, regardless of whether guidance has been authored for it.
    expect(typeof operation.description).toBe('string');
    expect(operation.description.length).toBeGreaterThan(0);

    // `guidance` is a declared key on every entry. No content is authored
    // yet, so today it reads `null` for the whole catalogue — but the KEY
    // itself must be present (`'guidance' in operation`), never simply
    // missing, which is what lets a client render "not yet authored" instead
    // of mistaking a schema drift for an empty state.
    expect(operation).toHaveProperty('guidance');
    expect(operation.guidance === null || typeof operation.guidance === 'object').toBe(true);

    for (const parameter of operation.parameters) {
      expect(parameter).toHaveProperty('help');
      expect(parameter.help === null || typeof parameter.help === 'object').toBe(true);
    }
    for (const role of operation.columnRoles) {
      expect(role).toHaveProperty('help');
      expect(role.help === null || typeof role.help === 'object').toBe(true);
    }
  }
});

test('FR5 — the operations endpoint refuses an unauthenticated read', async ({ request }) => {
  const response = await request.get(apiUrl('/api/v1/rule-runs/operations'), {
    headers: { Authorization: '' },
  });
  expect(response.status()).toBeGreaterThanOrEqual(401);
  expect(response.status()).toBeLessThan(500);
});
