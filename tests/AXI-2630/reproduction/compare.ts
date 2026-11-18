/**
 * AXI-2663 (epic AXI-2630, FR74, AC55; SI-042). PURE: compares what a run served with the golden
 * values, in a fixed order, and stops at the first value that differs. No I/O, no statistic is
 * computed here: a served number is only rounded to the precision section 20 prints.
 */
import {
  ALPHA, HEATMAP_CELLS, IMAGE_1, IMAGE_2, IMAGE_3, IMAGE_4, KNOWN_RESIDUAL, OPERATIONS,
  type HeatmapCell, type PublishedValue,
} from './golden';

export interface DunnPair {
  stratum: string;
  groupA: string;
  groupB: string;
  nA?: number;
  nB?: number;
  adjustedP?: number;
  adjustmentMethod?: string;
}

export interface ObservedCell {
  reference: string;
  variable: string;
  rho?: number;
  q?: number;
}

export interface Observed {
  image1: { operationId?: string; figure: boolean; pairs: DunnPair[] };
  image2: { operationId?: string; figure: boolean; n?: number; groups?: number; h?: number; p?: number };
  image3: { operationId?: string; figure: boolean; nFrom?: number; nTo?: number; u?: number; p?: number };
  image4: { operationId?: string; figure: boolean; method?: string; familyScope?: string; cells: ObservedCell[] };
}

export type Outcome = 'match' | 'mismatch' | 'known-residual' | 'not-served';

export interface ValueResult {
  id: string;
  expected: string;
  actual: string;
  outcome: Outcome;
}

export interface Comparison {
  verdict: 'all-match' | 'mismatch';
  results: ValueResult[];
  firstMismatch: ValueResult | null;
  knownResiduals: ValueResult[];
}

interface Expectation {
  id: string;
  expected: string;
  evaluate: (o: Observed) => { actual: string; outcome: Outcome };
}

const ABSENT = 'absent from the result';
const roundsTo = (actual: number, target: { value: number; decimals: number }) =>
  Number(actual.toFixed(target.decimals)) === target.value;

function describePublished(p: PublishedValue): string {
  const platform = `${p.platform.value.toFixed(p.platform.decimals)} (platform)`;
  return p.reference ? `${platform}, rounding to ${p.reference.value.toFixed(p.reference.decimals)} (reference)` : platform;
}

function publishedValue(id: string, p: PublishedValue, read: (o: Observed) => number | undefined): Expectation {
  return {
    id,
    expected: describePublished(p),
    evaluate: (o) => {
      const actual = read(o);
      if (actual === undefined) return { actual: ABSENT, outcome: 'mismatch' };
      const holds = roundsTo(actual, p.platform) && (!p.reference || roundsTo(actual, p.reference));
      return { actual: String(actual), outcome: holds ? 'match' : 'mismatch' };
    },
  };
}

function exactValue<T>(id: string, expected: T, read: (o: Observed) => T | undefined): Expectation {
  return {
    id,
    expected: String(expected),
    evaluate: (o) => {
      const actual = read(o);
      if (actual === undefined) return { actual: ABSENT, outcome: 'mismatch' };
      return { actual: String(actual), outcome: actual === expected ? 'match' : 'mismatch' };
    },
  };
}

const pairOf = (o: Observed, stratum: string, a: string, b: string) =>
  o.image1.pairs.find(
    (p) => p.stratum === stratum && ((p.groupA === a && p.groupB === b) || (p.groupA === b && p.groupB === a)),
  );

function nOfGroup(pair: DunnPair | undefined, group: string): number | undefined {
  if (!pair) return undefined;
  return pair.groupA === group ? pair.nA : pair.nB;
}

function pairExpectations(stratum: string, other: 'HD' | 'SD', adjusted: PublishedValue): Expectation[] {
  const id = `image-1.${stratum}.IgG4-RD-vs-${other}`;
  const read = (o: Observed) => pairOf(o, stratum, 'IgG4-RD', other);
  return [
    publishedValue(`${id}.adjusted-p`, adjusted, (o) => read(o)?.adjustedP),
    exactValue(`${id}.adjustment-method`, IMAGE_1.adjustmentMethod as string, (o) => read(o)?.adjustmentMethod),
    exactValue(`${id}.n-${other}`, IMAGE_1.groupNs[other], (o) => nOfGroup(read(o), other)),
    exactValue(`${id}.n-IgG4-RD`, IMAGE_1.groupNs['IgG4-RD'], (o) => nOfGroup(read(o), 'IgG4-RD')),
  ];
}

function notSignificant(stratum: string, other: 'HD' | 'SD'): Expectation {
  const read = (o: Observed) => pairOf(o, stratum, 'IgG4-RD', other)?.adjustedP;
  return exactValue(`image-1.${stratum}.IgG4-RD-vs-${other}.not-significant`, true, (o) => {
    const adjusted = read(o);
    return adjusted === undefined ? undefined : adjusted >= ALPHA;
  });
}

function image1Expectations(): Expectation[] {
  const { stratum, vsHD, vsSD } = IMAGE_1.notSignificant;
  return [
    exactValue('image-1.operation', OPERATIONS.dunn as string, (o) => o.image1.operationId),
    exactValue('image-1.figure', true, (o) => o.image1.figure),
    ...IMAGE_1.significant.flatMap((s) => [
      ...pairExpectations(s.stratum, 'HD', s.adjustedP),
      ...pairExpectations(s.stratum, 'SD', s.adjustedP),
    ]),
    ...pairExpectations(stratum, 'HD', vsHD),
    notSignificant(stratum, 'HD'),
    ...pairExpectations(stratum, 'SD', vsSD),
    notSignificant(stratum, 'SD'),
  ];
}

function image2Expectations(): Expectation[] {
  return [
    exactValue('image-2.operation', OPERATIONS.kruskal as string, (o) => o.image2.operationId),
    exactValue('image-2.figure', true, (o) => o.image2.figure),
    exactValue('image-2.n', IMAGE_2.n as number, (o) => o.image2.n),
    exactValue('image-2.groups', IMAGE_2.groups as number, (o) => o.image2.groups),
    publishedValue('image-2.H', IMAGE_2.h, (o) => o.image2.h),
    publishedValue('image-2.p', IMAGE_2.p, (o) => o.image2.p),
  ];
}

function image3Expectations(): Expectation[] {
  return [
    exactValue('image-3.operation', OPERATIONS.mannWhitney as string, (o) => o.image3.operationId),
    exactValue('image-3.figure', true, (o) => o.image3.figure),
    exactValue('image-3.n-absent', IMAGE_3.nFrom as number, (o) => o.image3.nFrom),
    exactValue('image-3.n-present', IMAGE_3.nTo as number, (o) => o.image3.nTo),
    publishedValue('image-3.U', IMAGE_3.u, (o) => o.image3.u),
    publishedValue('image-3.p', IMAGE_3.p, (o) => o.image3.p),
  ];
}

const isResidual = (c: HeatmapCell) => c.reference === KNOWN_RESIDUAL.reference && c.variable === KNOWN_RESIDUAL.variable;
const cellOf = (o: Observed, c: HeatmapCell) => o.image4.cells.find((x) => x.reference === c.reference && x.variable === c.variable);

function rhoOutcome(cell: HeatmapCell, actual: number): Outcome {
  const shown = Number(actual.toFixed(2));
  if (shown === cell.rho) return 'match';
  return isResidual(cell) && shown === KNOWN_RESIDUAL.acceptedRho ? 'known-residual' : 'mismatch';
}

function rhoExpectation(cell: HeatmapCell): Expectation {
  return {
    id: `image-4.${cell.referenceLabel} x ${cell.variableLabel}.rho`,
    expected: cell.rho.toFixed(2),
    evaluate: (o) => {
      const actual = cellOf(o, cell)?.rho;
      if (actual === undefined) return { actual: ABSENT, outcome: 'mismatch' };
      return { actual: actual.toFixed(2), outcome: rhoOutcome(cell, actual) };
    },
  };
}

function starExpectation(cell: HeatmapCell): Expectation {
  const id = `image-4.${cell.referenceLabel} x ${cell.variableLabel}.star`;
  return {
    id,
    expected: cell.star ? 'star (q < 0.05)' : 'no star (q >= 0.05)',
    evaluate: (o) => {
      const q = cellOf(o, cell)?.q;
      if (q === undefined) return { actual: ABSENT, outcome: 'mismatch' };
      const star = q < ALPHA;
      return { actual: `${star ? 'star' : 'no star'} (q = ${q})`, outcome: star === cell.star ? 'match' : 'mismatch' };
    },
  };
}

/** Read off the run's recorded parameters: a run that does not serve one is still judged on every cell. */
function recordedParameter(id: string, expected: string, read: (o: Observed) => string | undefined): Expectation {
  return {
    id,
    expected,
    evaluate: (o) => {
      const actual = read(o);
      if (actual === undefined) return { actual: 'not served', outcome: 'not-served' };
      return { actual, outcome: actual === expected ? 'match' : 'mismatch' };
    },
  };
}

const starCount = (o: Observed) => o.image4.cells.filter((c) => c.q !== undefined && c.q < ALPHA).length;

function image4Expectations(): Expectation[] {
  return [
    exactValue('image-4.operation', OPERATIONS.matrix as string, (o) => o.image4.operationId),
    exactValue('image-4.figure', true, (o) => o.image4.figure),
    recordedParameter('image-4.method', IMAGE_4.method, (o) => o.image4.method),
    recordedParameter('image-4.family-scope', IMAGE_4.familyScope, (o) => o.image4.familyScope),
    exactValue('image-4.cells', IMAGE_4.cells as number, (o) => o.image4.cells.length),
    ...HEATMAP_CELLS.flatMap((c) => [rhoExpectation(c), starExpectation(c)]),
    exactValue('image-4.stars', IMAGE_4.stars as number, starCount),
  ];
}

export const EXPECTATIONS: readonly Expectation[] = [
  ...image1Expectations(),
  ...image2Expectations(),
  ...image3Expectations(),
  ...image4Expectations(),
];

/** Every value in order, stopping at the first mismatch; later values are not reported as checked. */
export function compareWithGolden(observed: Observed): Comparison {
  const results: ValueResult[] = [];
  for (const e of EXPECTATIONS) {
    const result: ValueResult = { id: e.id, expected: e.expected, ...e.evaluate(observed) };
    results.push(result);
    if (result.outcome === 'mismatch') return summary(results, result);
  }
  return summary(results, null);
}

function summary(results: ValueResult[], firstMismatch: ValueResult | null): Comparison {
  return {
    verdict: firstMismatch ? 'mismatch' : 'all-match',
    results,
    firstMismatch,
    knownResiduals: results.filter((r) => r.outcome === 'known-residual'),
  };
}
