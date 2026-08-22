import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from './rules-fixtures';

/**
 * AXI-1323 — the two-referent Safe Compare gate, driven end-to-end over HTTP
 * (manual-e2e §5, §6, §8c; FR31, AC1, AC2, AC5, AC16, AC18, AC14, FR27).
 *
 * AXI-1242 composed the comparability gate over an engine callback but left it
 * with no runtime caller — no HTTP route, no message pattern. This story wired the
 * live dispatch: `POST /api/v1/rule-runs/comparability` runs the kernel gate over
 * two caller-supplied referents and returns the BLOCK/WARN/PASS verdict. These
 * specs drive that real endpoint through the running gateway → RabbitMQ →
 * organization-service → rule kernel path, so the gate's refusal behaviour is now
 * verified against the running platform, not only the kernel unit suite. A blocked
 * comparison is a 200 response carrying its stated reason (FR27), never an error.
 *
 * The fixtures are the plasmablast Wallace-gate anchor and the MAG4 paired-row
 * failure modes, the same facts the kernel unit suite and the scenario library use.
 */

/** The anchor metric's captured 01–04 metadata (gating version / cryo / panel / denominator). */
const CAPTURED = { gateParent: 'CD19lo/CD38+', cryoState: 'fresh', panel: 'MAG4', gatingVersion: 'v2023' };
/** Non-metadata axes that make a pair fully sound (unit/scale, batch, alignment, integrity). */
const SOUND_AXES = {
  unitScale: 'percent',
  assayBatch: 'B1',
  alignmentPosition: '0',
  valuePresent: true,
  derivationKnown: true,
  panelPerformed: true,
};
const LEFT = { axes: SOUND_AXES, captured: CAPTURED };
/** The right referent sits at a later alignment position — a comparable pair, not identical. */
const RIGHT = { axes: { ...SOUND_AXES, alignmentPosition: '3' }, captured: CAPTURED };

interface Verdict {
  comparable: boolean;
  reason: string | null;
  blocking: Array<{ id: string; severity: string; reason: string }>;
  warnings: Array<{ id: string; severity: string; reason: string }>;
}

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await adminApiContext();
});

test.afterAll(async () => {
  await api?.dispose();
});

/** POST a comparison to the live gate endpoint; assert a 200 and return the verdict. */
async function evaluate(body: unknown): Promise<Verdict> {
  const res = await api.post(apiUrl('/api/v1/rule-runs/comparability'), { data: body });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Verdict;
}

test.describe('AXI-1323 — Safe Compare gate over HTTP (§5/§6/§8c)', { tag: ['@SI-017'] }, () => {
  test('AC16 — two fully comparable referents pass, and an identical request yields an identical verdict', async () => {
    const first = await evaluate({ left: LEFT, right: RIGHT, baselineDeclared: true });
    expect(first.comparable).toBe(true);
    expect(first.reason).toBeNull();
    expect(first.blocking).toEqual([]);
    expect(first.warnings).toEqual([]);
    // Determinism (NFR1): the same inputs re-run give the same verdict.
    const second = await evaluate({ left: LEFT, right: RIGHT, baselineDeclared: true });
    expect(second).toEqual(first);
  });

  test('AC2 EC1 — a blocked denominator vetoes the comparison and names the gate-parent axis', async () => {
    const verdict = await evaluate({
      left: { axes: SOUND_AXES, captured: { ...CAPTURED, gateParent: 'total CD4' } },
      right: RIGHT,
      baselineDeclared: true,
    });
    expect(verdict.comparable).toBe(false);
    expect(verdict.blocking.map((b) => b.id)).toContain('comparable_parent_denominator');
    expect(verdict.reason).toContain('gate parent / denominator');
    expect(verdict.warnings).toEqual([]);
  });

  test('AC1 EC5 — a unit / scale mismatch is a categorical veto', async () => {
    const verdict = await evaluate({
      left: LEFT,
      right: { axes: { ...RIGHT.axes, unitScale: 'per_mm3' }, captured: CAPTURED },
      baselineDeclared: true,
    });
    expect(verdict.comparable).toBe(false);
    expect(verdict.blocking.map((b) => b.id)).toContain('comparable_unit_scale');
    expect(verdict.reason).toContain('unit and scale');
  });

  test('AC5 EC6 — a post-thaw vs fresh draw is a categorical veto (excluded, not compared)', async () => {
    const verdict = await evaluate({
      left: LEFT,
      right: { axes: RIGHT.axes, captured: { ...CAPTURED, cryoState: 'post_thaw' } },
      baselineDeclared: true,
    });
    expect(verdict.comparable).toBe(false);
    expect(verdict.blocking.map((b) => b.id)).toContain('comparable_cryo_state');
    expect(verdict.reason).toContain('cryopreservation state');
  });

  test('AC18 — the assay-run / batch axis scores (WARN) rather than vetoes', async () => {
    const verdict = await evaluate({
      left: LEFT,
      right: { axes: { ...RIGHT.axes, assayBatch: 'B2' }, captured: CAPTURED },
      baselineDeclared: true,
    });
    // Gradable, not categorical: the pair stays comparable and the batch axis is
    // stamped as a warning, never a block.
    expect(verdict.comparable).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.warnings.map((w) => w.id)).toEqual(['comparable_assay_batch']);
    expect(verdict.warnings[0].severity).toBe('WARN');
  });

  test('AC14 — an uncaptured 01–04 axis blocks pending metadata capture, naming the gap', async () => {
    const verdict = await evaluate({
      left: { axes: SOUND_AXES, captured: { ...CAPTURED, gatingVersion: null } },
      right: RIGHT,
      baselineDeclared: true,
    });
    expect(verdict.comparable).toBe(false);
    expect(verdict.reason).toContain('blocked pending metadata capture');
  });

  test('FR27 — a blocked comparison is a first-class 200 response with a stated reason, not an error', async () => {
    const res = await api.post(apiUrl('/api/v1/rule-runs/comparability'), {
      data: { left: LEFT, right: RIGHT, baselineDeclared: false }, // undeclared baseline (rule 08) blocks
    });
    expect(res.status()).toBe(200);
    const verdict = (await res.json()) as Verdict;
    expect(verdict.comparable).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  test('FR31 — a non-boolean integrity flag is not coerced to an affirmation (fail-closed at the wire)', async () => {
    // The gateway pipe's implicit conversion must not turn a string into `true`:
    // the integrity axes affirm only on a genuine boolean, so a string leaves the
    // axis unconfirmed and the gate blocks rather than silently affirming it.
    const badAxes = (pos: string) => ({
      unitScale: 'percent',
      assayBatch: 'B1',
      alignmentPosition: pos,
      valuePresent: 'no',
      derivationKnown: true,
      panelPerformed: true,
    });
    const verdict = await evaluate({
      left: { axes: badAxes('0'), captured: CAPTURED },
      right: { axes: badAxes('3'), captured: CAPTURED },
      baselineDeclared: true,
    });
    expect(verdict.comparable).toBe(false);
    expect(verdict.blocking.map((b) => b.id)).toContain('value_not_missing');
  });
});
