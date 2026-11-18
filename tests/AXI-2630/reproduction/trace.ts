/**
 * AXI-2663 (epic AXI-2630, FR74; SI-042). The run's trace of ids and values, written under
 * `reports/AXI-2630/<date-slug>/`. It holds no token and no credential: the text is scanned with the
 * prod suite's own `findSecretShapes` before anything reaches the disk. Never a Playwright trace.zip.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSecretShapes } from '../../AXI-2309/harness/prod-suite/publish';
import type { Comparison, ValueResult } from './compare';

export interface TraceStep {
  step: string;
  facts: Record<string, unknown>;
}

export interface RunEnding {
  exitCode: number;
  verdict: string;
  message: string;
}

export class Trace {
  readonly steps: TraceStep[] = [];
  comparison: Comparison | null = null;

  record(step: string, facts: Record<string, unknown>): void {
    this.steps.push({ step, facts });
  }
}

const row = (r: ValueResult) => `| ${r.id} | ${r.expected} | ${r.actual} | ${r.outcome} |`;

export function renderReport(trace: Trace, ending: RunEnding): string {
  const results = trace.comparison?.results ?? [];
  return [
    '# MAG4 reproduction via API (AXI-2663)',
    '',
    `Verdict: **${ending.verdict}** (exit ${ending.exitCode})`,
    '',
    ending.message,
    '',
    '## Steps',
    '',
    ...trace.steps.map((s) => `- ${s.step}: \`${JSON.stringify(s.facts)}\``),
    '',
    '## Known residuals',
    '',
    ...(trace.comparison?.knownResiduals ?? []).map((r) => `- ${r.id}: reads ${r.actual}, slide ${r.expected}`),
    '',
    '## Values compared',
    '',
    '| Value | Expected | Actual | Outcome |',
    '|---|---|---|---|',
    ...results.map(row),
    '',
  ].join('\n');
}

export function writeTrace(reportRoot: string, slug: string, trace: Trace, ending: RunEnding): string {
  const dir = path.join(reportRoot, slug);
  const json = JSON.stringify({ ending, steps: trace.steps, comparison: trace.comparison }, null, 2);
  const markdown = renderReport(trace, ending);
  const shapes = [...findSecretShapes(json), ...findSecretShapes(markdown)];
  if (shapes.length > 0) throw new Error(`trace refused: it holds secret-shaped text (${shapes.join(', ')})`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'trace.json'), json);
  writeFileSync(path.join(dir, 'REPORT.md'), markdown);
  return dir;
}
