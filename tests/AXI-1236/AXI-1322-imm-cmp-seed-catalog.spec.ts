import { test, expect, APIRequestContext } from '@playwright/test';
import { adminApiContext, fetchRuleCatalog, type CatalogRule } from './rules-fixtures';

/**
 * AXI-1322 — Safe Compare seed & catalog E2E (manual-e2e §8e.1; AC17, AC18, AC12).
 *
 * The two-referent comparability gate is a control-plane kernel unit with no HTTP
 * or message dispatch yet (that live wiring is tracked by AXI-1323), so the gate's
 * BLOCK/WARN *evaluation* is not reachable end-to-end today. What IS reachable, and
 * what this spec pins against the running stack, is the artefact AXI-1243 delivers
 * into the live system: the seeded `IMM-CMP-01..14` rule family surfacing in the
 * rule catalog (`GET /api/v1/rules`) after the service seeds at startup. This is a
 * genuine end-to-end path — DB seed → org-service → gateway → observable catalog —
 * not a re-run of the kernel unit suite. It verifies the family loads cleanly, is
 * distinct from the pre-existing `IMM-COMP-01` (AC17), and that the seed metadata
 * mirrors the gate's shape: categorical axes are blocking guards while the gradable
 * batch axis scores rather than vetoes (AC18), and every rule declares an output
 * field rather than a bare label (AC12). Read-only against the ambient seed (NFR3);
 * no mutation of the shared catalog.
 */

/** The comparability family the seed installs (AXI-1243). */
const IMM_CMP_CODES = Array.from({ length: 14 }, (_, i) => `IMM-CMP-${String(i + 1).padStart(2, '0')}`);
/** The single gradable axis (assay-run / batch) — scores, never vetoes (AC18). */
const GRADABLE_CODE = 'IMM-CMP-06';
/** Every family member except the gradable one blocks (mandatory guard). */
const BLOCKING_CODES = IMM_CMP_CODES.filter((c) => c !== GRADABLE_CODE);
/** The axes seeded with the explicit `categorical-veto` tag: the five comparability
 *  vetoes (01–05), the two alignment vetoes (07–08) and the three integrity vetoes
 *  (11–13). The trajectory (09), suppression (10) and output-grammar (14) axes also
 *  block but carry their own sub-family tag instead. */
const CATEGORICAL_VETO_TAGGED = [
  'IMM-CMP-01', 'IMM-CMP-02', 'IMM-CMP-03', 'IMM-CMP-04', 'IMM-CMP-05',
  'IMM-CMP-07', 'IMM-CMP-08', 'IMM-CMP-11', 'IMM-CMP-12', 'IMM-CMP-13',
];
/** The pre-existing composite classification rule the family must stay distinct from. */
const DISTINCT_NEIGHBOUR = 'IMM-COMP-01';

let api: APIRequestContext;
let catalog: CatalogRule[];

function byCode(code: string): CatalogRule {
  const rule = catalog.find((r) => r.code === code);
  if (!rule) throw new Error(`rule ${code} absent from the live catalog`);
  return rule;
}

test.beforeAll(async () => {
  api = await adminApiContext();
  catalog = await fetchRuleCatalog(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('AXI-1322 — Safe Compare seed & catalog (§8e.1)', { tag: ['@SI-017'] }, () => {
  test('AC17 — the full IMM-CMP-01..14 family is present and published in the running catalog', async () => {
    const found = catalog.filter((r) => IMM_CMP_CODES.includes(r.code)).map((r) => r.code).sort();
    expect(found).toEqual([...IMM_CMP_CODES].sort());
    for (const code of IMM_CMP_CODES) {
      expect(byCode(code).status, `${code} must be published`).toBe('published');
    }
  });

  test('AC17 — the family is distinct from the pre-existing IMM-COMP-01 (no naming collision, no shared family tag)', async () => {
    const neighbour = byCode(DISTINCT_NEIGHBOUR);
    // The composite classification rule exists…
    expect(neighbour.status).toBe('published');
    // …but carries none of the comparability family markers — it is a different
    // family, not a re-labelled member (AC17: IMM-CMP ≠ IMM-COMP-01).
    expect(neighbour.tags ?? []).not.toContain('imm-cmp');
    expect(neighbour.tags ?? []).not.toContain('comparability');
    // Every code is unique — the seed loader fails closed on duplicates (NFR11),
    // so the running catalog holds exactly one row per code.
    const codes = catalog.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('AC17 NFR11 — every IMM-CMP rule carries the family markers, RUO scope and the no-diagnostic-claims guard', async () => {
    for (const code of IMM_CMP_CODES) {
      const rule = byCode(code);
      expect(rule.tags ?? [], `${code} tags`).toEqual(
        expect.arrayContaining(['comparability', 'imm-cmp', 'v1']),
      );
      expect(rule.category, `${code} category`).toBe('qc_guard');
      expect(rule.ruoOnly, `${code} is RUO-only`).toBe(true);
      expect(rule.safetyFlags ?? [], `${code} safety flags`).toContain('no_diagnostic_claims');
    }
  });

  test('AC18 — every axis blocks except the gradable batch axis (IMM-CMP-06), which scores rather than vetoes', async () => {
    // Every non-gradable axis is a mandatory guard whose seed marks a blocking
    // decision — the veto half of threshold-plus-veto.
    for (const code of BLOCKING_CODES) {
      const rule = byCode(code);
      expect(rule.isMandatory, `${code} is mandatory`).toBe(true);
      expect(rule.guardOutput?.blockDecision, `${code} blocks`).toBe(true);
    }
    // The comparability, alignment and integrity vetoes carry the explicit
    // categorical-veto tag.
    for (const code of CATEGORICAL_VETO_TAGGED) {
      expect(byCode(code).tags ?? [], `${code} categorical-veto tag`).toContain('categorical-veto');
    }
    // The assay-run / batch axis is gradable: tagged so, non-mandatory, and its
    // seed asserts no blocking decision — it warns, never vetoes.
    const gradable = byCode(GRADABLE_CODE);
    expect(gradable.tags ?? []).toContain('gradable');
    expect(gradable.tags ?? []).not.toContain('categorical-veto');
    expect(gradable.isMandatory).toBe(false);
    expect(gradable.guardOutput?.blockDecision ?? false).toBe(false);
  });

  test('AC17 — the three sub-families (alignment 07-09, suppression 10, integrity 11-14) are tagged as seeded', async () => {
    const hasTag = (code: string, tag: string) => (byCode(code).tags ?? []).includes(tag);
    for (const code of ['IMM-CMP-07', 'IMM-CMP-08', 'IMM-CMP-09']) {
      expect(hasTag(code, 'alignment'), `${code} alignment`).toBe(true);
    }
    expect(hasTag('IMM-CMP-10', 'suppression')).toBe(true);
    for (const code of ['IMM-CMP-11', 'IMM-CMP-12', 'IMM-CMP-13', 'IMM-CMP-14']) {
      expect(hasTag(code, 'integrity'), `${code} integrity`).toBe(true);
    }
    // Rule 14 is the output-grammar guard and additionally forbids causality claims.
    expect(hasTag('IMM-CMP-14', 'output-grammar')).toBe(true);
    expect(byCode('IMM-CMP-14').safetyFlags ?? []).toContain('no_causality_claims');
  });

  test('AC12 — every IMM-CMP rule declares an output field, never a bare label', async () => {
    for (const code of IMM_CMP_CODES) {
      const fields = byCode(code).outputFields ?? [];
      expect(fields.length, `${code} must declare at least one output field`).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field.key, `${code} output field key`).toBeTruthy();
        expect(field.type, `${code} output field type`).toBeTruthy();
      }
    }
    // The parent/denominator axis names its comparability output explicitly.
    const gateParent = byCode('IMM-CMP-01').outputFields ?? [];
    expect(gateParent.some((f) => f.key === 'comparable_gate_parent' && f.type === 'boolean')).toBe(true);
  });
});
