import { test, expect } from '@playwright/test';
import { registryApiAs, type RegistryApi } from './harness/registry-api';

/**
 * AXI-2423 (epic AXI-2422 — Analysis Template Library, Registry v0 — FR44-FR49, NFR11, NFR12;
 * AC16-AC19, AC21; EC19). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2423.
 *
 * Activated by AXI-2424, which added the gateway read routes
 * (`GET /api/v1/analysis-templates`, `GET /api/v1/analysis-templates/:id/versions/:version`).
 * Scenario 3 (compile parity through the resolver) is `unit-only`: no HTTP route compiles through
 * the registry yet — UT-TMPL-017..023 and UT-TMPL-074 cover it. Scenario 4 (DB immutability) is
 * the migration's trigger, covered by CI's migrate-from-scratch gate.
 *
 * Read-only: this file writes nothing.
 * Run: `API_BASE_URL=<gateway serving the branch> npx playwright test tests/AXI-2422/AXI-2423-*`
 */

const SEEDED = ['T1', 'T2', 'T3', 'T4', 'T5'];

let api: RegistryApi;

test.beforeAll(async () => {
  api = await registryApiAs('admin');
});
test.afterAll(async () => api?.dispose());

test.describe('AXI-2423 — Registry v0 (AC16, AC17, AC19, AC21)', { tag: ['@SI-069', '@SI-010'] }, () => {
  test('AXI-2423.1 T1-T5 are seeded exactly once at 0.2; T5 is guided-only with BH (AC16, AC17)', async () => {
    // Act
    const list = await api.list();
    const t5 = await api.resolve('T5', '0.2');
    // Assert
    expect(list.status).toBe(200);
    for (const templateId of SEEDED) {
      const entry = list.body.find((e: any) => e.templateId === templateId);
      expect(entry, `${templateId} is listed`).toBeTruthy();
      expect(entry.versions.filter((v: string) => v === '0.2')).toEqual(['0.2']);
    }
    expect(t5.status).toBe(200);
    expect(t5.body).toMatchObject({ templateId: 'T5', templateVersion: '0.2', recipeKey: 'T5', guidedOnly: true });
    expect(t5.body.signature.multipleTesting.method).toBe('benjamini_hochberg');
  });

  test('AXI-2423.2 resolves a known pair, refuses an unknown one with no fallback (AC19, EC19)', async () => {
    // Act
    const known = await api.resolve('T1', '0.2');
    const unknown = await api.resolve('T1', '9.9');
    // Assert
    expect(known.status).toBe(200);
    expect(known.body).toMatchObject({ templateId: 'T1', templateVersion: '0.2', recipeKey: 'T1', guidedOnly: false });
    expect(known.body.signature.outputs).toEqual(['stats.mann_whitney_u']);
    expect(known.body.parameters.map((p: any) => p.key)).toEqual(['groupingColumn', 'groups', 'outcome']);
    expect(unknown.status).toBe(404);
  });
});
