/**
 * AXI-2601 (epic AXI-2598 — FR5, FR6, FR7, NFR4) — the rehearsal's dated report.
 *
 * One ledger per run: every step (status, elapsed time, observed facts), every product defect
 * found (endpoint, request shape, response excerpt, suspected code location), every object the
 * run created and whether it could be removed. `REPORT.md` is rendered from `run.json` only.
 * Both are scanned for token/credential shapes (the prod-suite `findSecretShapes`) before they are
 * written; a hit refuses the write (NFR4). Downloads are kept beside them as evidence.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSecretShapes } from '../../AXI-2309/harness/prod-suite/publish';

export type StepStatus = 'pass' | 'fail' | 'blocked' | 'known-defect';

export interface StepRecord {
  id: string;
  title: string;
  status: StepStatus;
  elapsedMs: number;
  facts: string[];
  defectIds: string[];
}

export type DefectSeverity = 'blocker' | 'major' | 'minor';

export interface DefectRecord {
  id: string;
  step: string;
  /** Stable signature, matched against the known-defect registry (`known-defects.ts`). */
  code: string;
  title: string;
  endpoint: string;
  request: string;
  observed: string;
  expected: string;
  suspectedLocation: string;
  severity: DefectSeverity;
}

export interface ResidueRecord {
  kind: string;
  id: string;
  removed: boolean;
  note: string;
}

export interface Download {
  questionKey: string;
  kind: string;
  file: string | null;
  status: number;
  contentType: string;
  bytes: number;
  valid: boolean;
  note: string;
}

export interface RunReport {
  schemaVersion: 1;
  suite: 'axiome-handover';
  story: 'AXI-2601';
  mode: string;
  runToken: string;
  startedAt: string;
  finishedAt: string | null;
  target: { label: string; baseUrl: string; apiBaseUrl: string; workspaceId: string };
  commits: { front: string; back: string; compute: string } | null;
  evidence: { counts: boolean; reason: string };
  preset: { presetId: string; presetVersion: string; dataFileSha256: string } | null;
  identities: string[];
  notes: string[];
  steps: StepRecord[];
  defects: DefectRecord[];
  residue: ResidueRecord[];
  downloads: Download[];
  timings: Record<string, number | null>;
}

export class Ledger {
  readonly report: RunReport;
  private defectSeq = 0;

  constructor(init: Omit<RunReport, 'schemaVersion' | 'suite' | 'story' | 'finishedAt' | 'steps' | 'defects' | 'residue' | 'downloads' | 'timings' | 'notes' | 'identities'>) {
    this.report = {
      schemaVersion: 1, suite: 'axiome-handover', story: 'AXI-2601', finishedAt: null,
      identities: [], notes: [], steps: [], defects: [], residue: [], downloads: [], timings: {}, ...init,
    };
  }

  step(id: string, title: string): StepRecord {
    const existing = this.report.steps.find((s) => s.id === id);
    if (existing) return existing;
    const rec: StepRecord = { id, title, status: 'pass', elapsedMs: 0, facts: [], defectIds: [] };
    this.report.steps.push(rec);
    return rec;
  }

  /** Record a product defect against a step and return its run-local id (D1, D2, …). */
  defect(step: StepRecord, d: Omit<DefectRecord, 'id' | 'step'>): DefectRecord {
    const rec: DefectRecord = { id: `D${++this.defectSeq}`, step: step.id, ...d };
    this.report.defects.push(rec);
    step.defectIds.push(rec.id);
    return rec;
  }

  residue(r: ResidueRecord): void {
    const existing = this.report.residue.find((x) => x.kind === r.kind && x.id === r.id);
    if (existing) Object.assign(existing, r);
    else this.report.residue.push(r);
  }

  timing(name: string, ms: number | null): void {
    this.report.timings[name] = ms;
  }

  dir(): string {
    const { reportRoot, slug } = this.paths;
    return path.join(reportRoot, slug);
  }

  paths = { reportRoot: 'reports/AXI-2598', slug: 'unnamed' };

  /** Write a downloaded file beside the report (bytes are product output, never a token). */
  saveDownload(name: string, bytes: Buffer): string {
    const dir = path.join(this.dir(), 'downloads');
    mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
    writeFileSync(path.join(dir, safe), bytes);
    return `downloads/${safe}`;
  }

  /** Render and write `run.json` + `REPORT.md`; refuse if either carries a secret shape (NFR4). */
  write(): string {
    this.report.finishedAt = new Date().toISOString();
    const json = JSON.stringify(this.report, null, 2);
    const md = renderMarkdown(this.report);
    for (const [name, text] of [['run.json', json], ['REPORT.md', md]] as const) {
      const shapes = findSecretShapes(text);
      if (shapes.length > 0) throw new Error(`refusing to write ${name}: it carries ${shapes.join(', ')} (NFR4)`);
    }
    mkdirSync(this.dir(), { recursive: true });
    writeFileSync(path.join(this.dir(), `run-${this.report.runToken}.json`), `${json}\n`);
    writeFileSync(path.join(this.dir(), `REPORT-${this.report.runToken}.md`), md);
    return this.dir();
  }
}

const fmtMs = (ms: number | null | undefined) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown rendered from the JSON only (deterministic for one run). */
export function renderMarkdown(r: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Handover suite — ${r.mode} — run ${r.runToken}`, '');
  lines.push(`- **Story:** AXI-2601 (epic AXI-2598)`);
  lines.push(`- **Started / finished:** ${r.startedAt} / ${r.finishedAt ?? '—'}`);
  lines.push(`- **Target:** ${r.target.label} — front \`${r.target.baseUrl}\`, gateway \`${r.target.apiBaseUrl}\`, workspace \`${r.target.workspaceId}\``);
  lines.push(
    `- **Service commits:** ${r.commits ? `front \`${r.commits.front}\` · back \`${r.commits.back}\` · compute \`${r.commits.compute}\`` : 'NOT RECORDED'}`,
  );
  lines.push(`- **Counts as evidence:** ${r.evidence.counts ? 'yes' : 'NO'} — ${r.evidence.reason}`);
  if (r.preset) lines.push(`- **Preset:** \`${r.preset.presetId}\` v${r.preset.presetVersion}, data file sha256 \`${r.preset.dataFileSha256.slice(0, 16)}…\``);
  for (const i of r.identities) lines.push(`- **Identity:** ${i}`);
  lines.push('- No Playwright trace or video is recorded; no LLM call is made on this path.', '');
  if (r.notes.length) {
    lines.push('## Notes', '', ...r.notes.map((n) => `- ${n}`), '');
  }
  const counts = r.steps.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.status]: (acc[s.status] ?? 0) + 1 }), {});
  lines.push('## Steps', '');
  lines.push(`Summary: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'}`, '');
  lines.push('| Step | Status | Elapsed | Defects | Facts |', '|---|---|---|---|---|');
  for (const s of r.steps) {
    lines.push(`| ${cell(`${s.id} ${s.title}`)} | ${s.status} | ${fmtMs(s.elapsedMs)} | ${s.defectIds.join(', ') || '—'} | ${cell(s.facts.join('; ')) || '—'} |`);
  }
  lines.push('', '## Timings', '', '| Measure | Value |', '|---|---|');
  for (const [k, v] of Object.entries(r.timings)) lines.push(`| ${cell(k)} | ${fmtMs(v)} |`);
  lines.push('', '## Defects found', '');
  if (r.defects.length === 0) lines.push('None.');
  for (const d of r.defects) {
    lines.push(`### ${d.id} — ${d.title} (${d.severity}, \`${d.code}\`)`, '');
    lines.push(`- **Step:** ${d.step}`);
    lines.push(`- **Endpoint:** \`${d.endpoint}\``);
    lines.push(`- **Request:** ${d.request}`);
    lines.push(`- **Observed:** ${d.observed}`);
    lines.push(`- **Expected:** ${d.expected}`);
    lines.push(`- **Suspected code location:** ${d.suspectedLocation}`, '');
  }
  lines.push('## Downloads', '');
  if (r.downloads.length === 0) lines.push('None.');
  else {
    lines.push('| Question | Kind | Status | Type | Bytes | Valid | File | Note |', '|---|---|---|---|---|---|---|---|');
    for (const d of r.downloads) {
      lines.push(`| ${d.questionKey} | ${d.kind} | ${d.status} | ${cell(d.contentType)} | ${d.bytes} | ${d.valid ? 'yes' : 'NO'} | ${d.file ?? '—'} | ${cell(d.note)} |`);
    }
  }
  lines.push('', '## Objects created and cleanup (FR6)', '');
  if (r.residue.length === 0) lines.push('None.');
  else {
    lines.push('| Kind | Id | Removed | Note |', '|---|---|---|---|');
    for (const x of r.residue) lines.push(`| ${x.kind} | \`${x.id}\` | ${x.removed ? 'yes' : 'NO'} | ${cell(x.note)} |`);
  }
  lines.push('');
  return lines.join('\n');
}
