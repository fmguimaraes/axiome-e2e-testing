import { test } from '@playwright/test';

/**
 * AXI-2423 (epic AXI-2422 — Analysis Template Library, Registry v0 — FR44-FR49, NFR11, NFR12;
 * AC16-AC19, AC21; EC19-EC21; SI-069). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2423.
 *
 * Registry v0 ships with NO gateway HTTP route — `{templateId, templateVersion}` resolution is
 * reachable today only through organization-service's internal message patterns
 * (`ANALYSIS_TEMPLATE_REGISTRY_PATTERNS.RESOLVE`/`LIST`, `libs/contracts`), and the one write path
 * (the seed) runs at service boot. Every Playwright spec in this repo drives the platform over
 * the gateway's HTTP API (`adminApi()`/`apiRequest.newContext()` — see `AXI-2410`'s harness for
 * the pattern this file would otherwise follow); there is deliberately no gateway read route for
 * this registry yet (`POST /analysis-templates` + gateway read routes are R2/AXI-2424's job per
 * the feature doc's §11b dependency order). Until that lands, there is no HTTP surface this file
 * can exercise without inventing one outside this story's ownership.
 *
 * What DOES verify AC16-AC19/EC19-EC21 today is the organization-service Jest suite:
 *   - `apps/organization-service/src/analysis-templates/analysis-template-parameter-schema.spec.ts`
 *     (UT-TMPL-001..005 — parameter schema + signature per template, T5 BH)
 *   - `apps/organization-service/src/analysis-templates/analysis-template-seed.service.spec.ts`
 *     (UT-TMPL-006..012 — seed idempotency, T1-T5 content, T5 guided-only, lost races;
 *     plus UT-TMPL-024 — missing recipe refused before any write)
 *   - `apps/organization-service/src/analysis-templates/analysis-template-registry.service.spec.ts`
 *     (UT-TMPL-013..016 — resolve known/unknown pair, no-fallback, list)
 *   - `apps/organization-service/src/analysis-templates/analysis-template-compile-via-registry.spec.ts`
 *     (UT-TMPL-017..023 — compile parity for T1-T5, byte-identical to the hard-coded path, EC21;
 *     unknown-pair / unknown-recipe refusals)
 *   - the migration's immutability triggers + unique constraint (EC20) are enforced at the DB
 *     layer and verified by CI's migrate-from-scratch gate — there is no application write path
 *     to drive a rewrite attempt through in this story.
 *
 * This file is kept as the activation point: it names the three scenarios and skips them with a
 * reason, so the next story that adds the gateway route (AXI-2424) turns them on by filling in
 * the HTTP calls — never by writing a parallel spec file.
 */

test.describe('AXI-2423 — Registry v0 (AC16-AC19, AC21)', { tag: ['@SI-069'] }, () => {
  test.skip(
    true,
    'no gateway HTTP route exists for the analysis-template registry in this story (AXI-2424 ' +
      'adds it); covered today by the organization-service Jest suite named above',
  );

  test('AXI-2423.1 seed is idempotent and seeds exactly T1-T5 at 0.2 (AC16, AC17)', async () => {
    // Activation note: once AXI-2424's gateway read route exists, this becomes
    // `GET /api/v1/analysis-templates` (list) called twice against a freshly-provisioned
    // database, asserting the second call's result set is unchanged.
  });

  test('AXI-2423.2 resolves a known pair, refuses an unknown one with no fallback (AC19)', async () => {
    // Activation note: `GET /api/v1/analysis-templates/T1/versions/0.2` then `.../9.9`.
  });

  test('AXI-2423.3 compiling through the resolver is byte-identical to the hard-coded catalog path (AC18, EC21)', async () => {
    // Activation note: compile the fixed T1-T5 binding fixture through both the existing
    // `POST /api/v1/guided-analysis/opening-templates/compile` and whatever resolver-routed
    // compile endpoint AXI-2424/AXI-2425 exposes, and diff the two plans.
  });
});
