import { expect, type APIResponse } from '@playwright/test';
import { canon, randomUuid } from './tenancy';

/**
 * AC3 oracle check. `probe(id)` issues ONE request naming resource `id`. It is
 * called with the foreign (cross-tenant) id and with a fresh random uuid (the
 * genuine miss). Both must be 404 with an identical body once the request-echo
 * fields (`path`, `timestamp`) are dropped and each request's own id is
 * substituted by a placeholder (a `X not found` message legitimately names the
 * id the caller sent; nothing else may differ).
 */
export async function expectIndistinguishableFromMiss(
  foreignId: string,
  probe: (id: string) => Promise<APIResponse>,
): Promise<void> {
  const missId = randomUuid();
  const [denied, miss] = await Promise.all([probe(foreignId), probe(missId)]);
  const d = await canon(denied);
  const m = await canon(miss);
  expect(denied.status(), `cross-tenant probe body: ${d.raw}`).toBe(404);
  expect(miss.status(), `control probe body: ${m.raw}`).toBe(404);
  const norm = (c: string, id: string) => c.split(id).join('<ID>');
  expect(norm(d.canon, foreignId)).toBe(norm(m.canon, missId));
}

export async function expectStatus(res: APIResponse, status: number): Promise<any> {
  const raw = await res.text();
  expect(res.status(), `expected ${status}, body: ${raw.slice(0, 400)}`).toBe(status);
  try { return JSON.parse(raw); } catch { return raw; }
}
