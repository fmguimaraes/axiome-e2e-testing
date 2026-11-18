/**
 * AXI-2648 (epic AXI-2630 — feature BACKLOG-Investigator-On-Shared-Principles §20, FR60,
 * AC38; SI-042). PURE assertion module: given the launched result of one of the four preset
 * questions, says whether it reproduces §20's platform values and figure elements. Never
 * computes a statistic itself — every number here is cited from §20, never derived or
 * guessed (scientific-calls doctrine: a platform value is taken from the feature doc, not
 * re-estimated by this harness).
 *
 * AXI-2647 calls `assertSection20(image, result)` against the real launched analysis's
 * result/chart read and reports the returned problems (empty = reproduces §20).
 */

export type Image = 1 | 2 | 3 | 4;

/** §20 row 1 — one Dunn-vs-reference-group comparison per microbiota reference. */
export interface Image1ReferenceResult {
  reference: 'ENT 059' | 'CER 229' | 'CER 215 et 234';
  significant: boolean;
  /** The single adjusted p-value §20 states for a significant reference. */
  adjustedPValue?: number;
  /** For CER 215 et 234, §20 states both reference-group comparisons explicitly. */
  vsHD?: number;
  vsSD?: number;
}

export interface Image1Result {
  byReference: Image1ReferenceResult[];
  elements: {
    panelCount: number;
    sharedYAxis: boolean;
    groupOrder: string[];
    medianBarPerGroup: boolean;
    bracketsAgainstGroup: string;
  };
}

export interface Image2Result {
  h: number;
  p: number;
  elements: { logYAxis: boolean; pointsOverBoxes: boolean; groupOrder: string[]; testBadge: boolean };
}

export interface Image3Result {
  u: number;
  p: number;
  nAbsent: number;
  nPresent: number;
  elements: { logYAxis: boolean; pointsOverBoxes: boolean; groupOrder: string[]; testBadge: boolean };
}

export interface Image4Result {
  totalCells: number;
  significantCells: number;
  elements: { annotatedHeatmap: boolean; starOnSignificantCells: boolean };
}

export type Section20Result =
  | { image: 1; result: Image1Result }
  | { image: 2; result: Image2Result }
  | { image: 3; result: Image3Result }
  | { image: 4; result: Image4Result };

const EPS = 1e-3;
const close = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps;

const SECTION_20 = {
  image1: {
    'ENT 059': { significant: true, adjustedPValue: 0.0217 },
    'CER 229': { significant: true, adjustedPValue: 0.0378 },
    'CER 215 et 234': { significant: false, vsHD: 0.437, vsSD: 0.325 },
  },
  image1Elements: { panelCount: 3, sharedYAxis: true, groupOrder: ['HD', 'IgG4-RD', 'SD'], medianBarPerGroup: true, bracketsAgainstGroup: 'IgG4-RD' },
  image2: { h: 4.871, p: 0.1815 },
  image2Elements: { logYAxis: true, pointsOverBoxes: true, groupOrder: ['Cluster 1', 'Cluster 2', 'Cluster 3', 'Cluster 4'], testBadge: true },
  image3: { u: 77.5, p: 0.3705, nAbsent: 9, nPresent: 14 },
  image3Elements: { logYAxis: true, pointsOverBoxes: true, groupOrder: ['Absent', 'Present'], testBadge: true },
  image4: { totalCells: 42, significantCells: 15 },
  image4Elements: { annotatedHeatmap: true, starOnSignificantCells: true },
} as const;

export function assertSection20(input: Section20Result): string[] {
  switch (input.image) {
    case 1:
      return assertImage1(input.result);
    case 2:
      return assertImage2(input.result);
    case 3:
      return assertImage3(input.result);
    case 4:
      return assertImage4(input.result);
  }
}

function assertImage1(result: Image1Result): string[] {
  const problems: string[] = [];
  for (const [reference, expected] of Object.entries(SECTION_20.image1)) {
    const actual = result.byReference.find((r) => r.reference === reference);
    if (!actual) {
      problems.push(`image 1: no result for reference "${reference}"`);
      continue;
    }
    problems.push(...image1ReferenceProblems(reference, expected, actual));
  }
  problems.push(...elementProblems('image 1', SECTION_20.image1Elements, result.elements));
  return problems;
}

function image1ReferenceProblems(
  reference: string,
  expected: { significant: boolean; adjustedPValue?: number; vsHD?: number; vsSD?: number },
  actual: Image1ReferenceResult,
): string[] {
  const problems: string[] = [];
  if (actual.significant !== expected.significant) {
    problems.push(`image 1 (${reference}): significance ${actual.significant} ≠ expected ${expected.significant}`);
  }
  if (expected.adjustedPValue !== undefined) {
    if (actual.adjustedPValue === undefined || !close(actual.adjustedPValue, expected.adjustedPValue)) {
      problems.push(`image 1 (${reference}): adjusted p ${actual.adjustedPValue} ≠ expected ${expected.adjustedPValue}`);
    }
  }
  if (expected.vsHD !== undefined && (actual.vsHD === undefined || !close(actual.vsHD, expected.vsHD))) {
    problems.push(`image 1 (${reference}): vs HD p ${actual.vsHD} ≠ expected ${expected.vsHD}`);
  }
  if (expected.vsSD !== undefined && (actual.vsSD === undefined || !close(actual.vsSD, expected.vsSD))) {
    problems.push(`image 1 (${reference}): vs SD p ${actual.vsSD} ≠ expected ${expected.vsSD}`);
  }
  return problems;
}

function assertImage2(result: Image2Result): string[] {
  const problems: string[] = [];
  if (!close(result.h, SECTION_20.image2.h, 1e-2)) problems.push(`image 2: H ${result.h} ≠ expected ${SECTION_20.image2.h}`);
  if (!close(result.p, SECTION_20.image2.p)) problems.push(`image 2: p ${result.p} ≠ expected ${SECTION_20.image2.p}`);
  problems.push(...elementProblems('image 2', SECTION_20.image2Elements, result.elements));
  return problems;
}

function assertImage3(result: Image3Result): string[] {
  const problems: string[] = [];
  if (!close(result.u, SECTION_20.image3.u, 1e-1)) problems.push(`image 3: U ${result.u} ≠ expected ${SECTION_20.image3.u}`);
  if (!close(result.p, SECTION_20.image3.p)) problems.push(`image 3: p ${result.p} ≠ expected ${SECTION_20.image3.p}`);
  if (result.nAbsent !== SECTION_20.image3.nAbsent) problems.push(`image 3: n(Absent) ${result.nAbsent} ≠ expected ${SECTION_20.image3.nAbsent}`);
  if (result.nPresent !== SECTION_20.image3.nPresent) problems.push(`image 3: n(Present) ${result.nPresent} ≠ expected ${SECTION_20.image3.nPresent}`);
  problems.push(...elementProblems('image 3', SECTION_20.image3Elements, result.elements));
  return problems;
}

function assertImage4(result: Image4Result): string[] {
  const problems: string[] = [];
  if (result.totalCells !== SECTION_20.image4.totalCells) {
    problems.push(`image 4: ${result.totalCells} cells ≠ expected ${SECTION_20.image4.totalCells}`);
  }
  if (result.significantCells !== SECTION_20.image4.significantCells) {
    problems.push(`image 4: ${result.significantCells} significant cells ≠ expected ${SECTION_20.image4.significantCells}`);
  }
  problems.push(...elementProblems('image 4', SECTION_20.image4Elements, result.elements));
  return problems;
}

function elementProblems(label: string, expected: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const got = actual[key];
    const equal = Array.isArray(value) ? JSON.stringify(value) === JSON.stringify(got) : got === value;
    if (!equal) problems.push(`${label}: element "${key}" is ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`);
  }
  return problems;
}
