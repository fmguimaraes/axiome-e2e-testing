/**
 * AXI-2663 (epic AXI-2630, FR74; SI-042). PURE: turns the four result pages a run served
 * (`GET /projects/:p/runs/:r/result-page`, `ResultPageResponse`) into the values `compare.ts`
 * judges. A value the page does not carry stays undefined: it is never defaulted or derived.
 */
import { OPERATIONS } from './golden';
import type { DunnPair, Observed, ObservedCell } from './compare';

export interface ServedResult {
  operationId?: string;
  chart?: unknown;
  chartWithheld?: string | null;
  rows?: Array<Record<string, unknown>>;
  run?: { operationParams?: unknown };
}

export interface ServedPage {
  results?: ServedResult[];
}

export type ImageKey = 'image-1' | 'image-2' | 'image-3' | 'image-4';
export type ServedPages = Record<ImageKey, ServedPage>;

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const resultOf = (page: ServedPage, operationId: string) => page.results?.find((r) => r.operationId === operationId);
const figureOf = (page: ServedPage) => (page.results ?? []).some((r) => Boolean(r.chart) && !r.chartWithheld);

/** A one-row test result: several rows would mean the question was not the one planned. */
function onlyRow(result: ServedResult | undefined): Record<string, unknown> {
  return result?.rows?.length === 1 ? result.rows[0] : {};
}

function paramOf(result: ServedResult | undefined, key: string): string | undefined {
  const params = result?.run?.operationParams;
  return params && typeof params === 'object' ? text((params as Record<string, unknown>)[key]) : undefined;
}

function dunnPair(row: Record<string, unknown>): DunnPair {
  return {
    stratum: String(row.feature ?? ''),
    groupA: String(row.groupA ?? ''),
    groupB: String(row.groupB ?? ''),
    nA: num(row.nGroupA),
    nB: num(row.nGroupB),
    adjustedP: num(row.adjustedPValue),
    adjustmentMethod: text(row.adjustmentMethod),
  };
}

function matrixCell(row: Record<string, unknown>): ObservedCell {
  return { reference: String(row.reference ?? ''), variable: String(row.variable ?? ''), rho: num(row.rho), q: num(row.qValue) };
}

function image1Of(page: ServedPage): Observed['image1'] {
  const result = resultOf(page, OPERATIONS.dunn);
  return { operationId: result?.operationId, figure: figureOf(page), pairs: (result?.rows ?? []).map(dunnPair) };
}

function image2Of(page: ServedPage): Observed['image2'] {
  const result = resultOf(page, OPERATIONS.kruskal);
  const row = onlyRow(result);
  return {
    operationId: result?.operationId, figure: figureOf(page),
    n: num(row.n), groups: num(row.nGroups), h: num(row.hStatistic), p: num(row.pValue),
  };
}

function image3Of(page: ServedPage): Observed['image3'] {
  const result = resultOf(page, OPERATIONS.mannWhitney);
  const row = onlyRow(result);
  return {
    operationId: result?.operationId, figure: figureOf(page),
    nFrom: num(row.nGroupFrom), nTo: num(row.nGroupTo), u: num(row.uStatistic), p: num(row.pValue),
  };
}

function image4Of(page: ServedPage): Observed['image4'] {
  const result = resultOf(page, OPERATIONS.matrix);
  return {
    operationId: result?.operationId, figure: figureOf(page),
    method: paramOf(result, 'method'), familyScope: paramOf(result, 'familyScope'),
    cells: (result?.rows ?? []).map(matrixCell),
  };
}

export function observedFrom(pages: ServedPages): Observed {
  return {
    image1: image1Of(pages['image-1']),
    image2: image2Of(pages['image-2']),
    image3: image3Of(pages['image-3']),
    image4: image4Of(pages['image-4']),
  };
}
