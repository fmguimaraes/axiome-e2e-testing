import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2257 (epic AXI-2073, round 2 audit fixes F1–F7) — FR4, FR5, FR18,
 * FR20–FR24, EC14–EC19, AC23–AC30 of
 * `axiome-docs/05 - product/features/IN-PROGRESS-Evidence-Audit-Report.md`.
 *
 * READ-ONLY and REST-only: every scenario downloads the audit bundle of an
 * evidence that already exists in the demo data (the Microbiote IgG4 final
 * reference set and its siblings) and asserts what the report says about it.
 * Nothing is created, so it can run against a sidecar that shares the demo
 * database. Point it at a stack with API_BASE_URL (the AXI-2257 sidecar is
 * http://localhost:3012).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface EvidenceRef { id: string; version: number; workspaceId: string }

const MAG4_WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const C700: EvidenceRef = { id: 'c700a6bd-e4e6-419d-b506-34190cc7fb0e', version: 1, workspaceId: MAG4_WS };
const B305: EvidenceRef = { id: 'b305a9bf-19b4-4cb7-be72-dc866562346a', version: 1, workspaceId: MAG4_WS };
const S949: EvidenceRef = { id: '949d5bcf-926d-43ec-bfeb-aeae93b3faf2', version: 3, workspaceId: MAG4_WS };
const FACETS = ['ENT 059', 'CER 229', 'CER 215 et 234'];
const HEADLINES = ['Not traceable', 'Traceable — with warnings', 'Traceable — some facts not recorded', 'Complete'];
const SEVERITY_RANK: Record<string, number> = { error: 0, 'error (deleted)': 0, warning: 1, 'not recorded': 2, 'not yet done': 2 };

let token: string;

interface Bundle { files: string[]; md: string; manifest: { includeSource: boolean; reportSha256: string; files: Array<{ filename: string }> } }

async function login(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.E2E_ADMIN_EMAIL ?? 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin' }),
  });
  expect(res.status, 'admin login').toBeLessThan(300);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function download(ev: EvidenceRef, query = ''): Promise<Bundle> {
  const res = await fetch(apiUrl(`/api/v1/view-analyses/evidences/${ev.id}/versions/${ev.version}/audit-report${query}`), {
    headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ev.workspaceId },
  });
  expect(res.status, `audit-report ${ev.id} v${ev.version}${query}`).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2257-'));
  const zip = join(dir, 'bundle.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-q', zip, '-d', join(dir, 'x')]);
  const files = execFileSync('unzip', ['-Z1', zip]).toString('utf8').split('\n').filter(Boolean);
  const read = (name: string) => readFileSync(join(dir, 'x', name), 'utf8');
  return { files, md: read('report.md'), manifest: JSON.parse(read('manifest.json')) };
}

function section(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

function headline(md: string): string {
  return /## Verdict\n\n\*\*(.+?)\*\*/.exec(md)?.[1] ?? '';
}

/** The verdict's groups: heading → table rows [severity, where, what]. */
function verdictGroups(md: string): Array<{ heading: string; rows: string[][] }> {
  const verdict = section(md, 'Verdict');
  return verdict.split('\n### ').slice(1).map((chunk) => {
    const [heading, ...lines] = chunk.split('\n');
    const rows = lines
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Severity') && !l.startsWith('| ---'))
      .map((l) => l.slice(2, -2).split(' | '));
    return { heading, rows };
  });
}

function hashBody(md: string): string {
  return md.split(/(?<=\n)/).filter((l) => !l.startsWith('Generated: ') && !l.startsWith('Report SHA-256: ')).join('');
}

test.beforeAll(async () => {
  token = await login();
});

test.describe('AXI-2257 round 2 audit report — read-only on the demo data', () => {
  let c700: Bundle;

  test.beforeAll(async () => {
    c700 = await download(C700);
  });

  test('@SI-016 R2-1 c700 headline is "Traceable — with warnings" (FR18, AC23)', async () => {
    expect(headline(c700.md)).toBe('Traceable — with warnings');
  });

  test('@SI-016 R2-2 verdict grouped: evidence first, then one group per facet run in facet order (FR18, FR24)', async () => {
    const groups = verdictGroups(c700.md);
    expect(groups.map((g) => g.heading)).toEqual([
      'Evidence',
      "Dunn's post-hoc test — facet ENT 059 (run 3a4d494d…)",
      "Dunn's post-hoc test — facet CER 229 (run 3debaa8f…)",
      "Dunn's post-hoc test — facet CER 215 et 234 (run 5bca31b5…)",
    ]);
  });

  test('@SI-016 R2-2b Methods run headings carry the verdict group label + run link (owner fix, FR5)', async () => {
    const runGroups = verdictGroups(c700.md).slice(1).map((g) => g.heading);
    const methodsHeadings = section(c700.md, 'Methods').split('\n').filter((l) => l.startsWith('### '));
    expect(methodsHeadings).toEqual(runGroups.map((h) => `### ${h} — linked to the cited chart`));
    expect(methodsHeadings[0]).toBe("### Dunn's post-hoc test — facet ENT 059 (run 3a4d494d…) — linked to the cited chart");
  });

  test('@SI-016 R2-3 rows inside every group are ordered error → warning → not recorded (FR18, AC25)', async () => {
    for (const group of verdictGroups(c700.md)) {
      const ranks = group.rows.map((r) => SEVERITY_RANK[r[0]]);
      expect(ranks.every((r) => r !== undefined), `${group.heading}: ${JSON.stringify(group.rows)}`).toBe(true);
      expect(ranks, group.heading).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  test('@SI-016 R2-4 evidence group names the scope mismatch on both sides (F3, FR22, EC17)', async () => {
    const evidence = verdictGroups(c700.md)[0].rows.map((r) => r[2]);
    const mismatch = evidence.find((w) => w.startsWith('Scope mismatch:'));
    expect(mismatch).toBe(
      'Scope mismatch: the cited data (snapshot v2) keeps rows where group is one of HD, IgG4-RD, SD and reference = ENT 059; '
      + 'the cited chart keeps rows where group is one of HD, IgG4-RD, SD and reference is one of ENT 059, CER 229, CER 215 et 234.',
    );
  });

  test('@SI-017 R2-5 per-facet Holm warning over 3 facets; Methods states the family size per facet (F1, FR5, FR20, AC27)', async () => {
    const evidence = verdictGroups(c700.md)[0].rows.map((r) => r[2]);
    expect(evidence).toContain('Adjustment is per facet: Holm was applied within each run; no correction across the 3 facets cited by this evidence.');
    const methods = section(c700.md, 'Methods');
    for (const facet of FACETS) {
      expect(methods).toContain(`- Multiple-comparison adjustment: Holm over 3 comparisons within facet ${facet} (this run's pairwise rows)`);
    }
    expect(methods).not.toContain('family size — not recorded');
  });

  test('@SI-017 R2-6 no omnibus line while the runs cite STAT-DUNN-POSTHOC v2 (no declaration ⇒ silent; F2, FR21, EC16)', async () => {
    expect(c700.md).toContain('Rule: STAT-DUNN-POSTHOC — Dunn\'s post-hoc test (rule version 2)');
    expect(c700.md).not.toContain('Omnibus test:');
    expect(c700.md).not.toContain('without a linked omnibus test');
  });

  test('@SI-015 R2-7 attribution: interpretation self-approval warns; evidence approver from the audit log (F4, FR23, AC28)', async () => {
    const evidence = verdictGroups(c700.md)[0].rows.map((r) => r[2]);
    expect(evidence.some((w) => /^Interpretation ".+" was approved by its author \(Local Admin\)\.$/.test(w))).toBe(true);
    expect(evidence.some((w) => w.startsWith('The evidence was approved by the author'))).toBe(false);
    const review = section(c700.md, 'Review & publication');
    expect(review).toMatch(/- Evidence approved by Felipe Machado Guimaraes on \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} UTC/);
    expect(c700.md).toContain('by service: ingestion');
  });

  test('@SI-016 R2-8 evidence approved by its own author warns (b305a9bf v1; F4, FR23)', async () => {
    const b305 = await download(B305, '?includeSource=false');
    expect(headline(b305.md)).toBe('Traceable — with warnings');
    const evidence = verdictGroups(b305.md)[0].rows.map((r) => r[2]);
    expect(evidence).toContain('The evidence was approved by the author of this version (Local Admin).');
  });

  test('@SI-016 R2-9 data-view snapshot: producing run "not applicable", read-by run, data-view wording (F3, F5, FR4, FR24, EC14)', async () => {
    const population = section(c700.md, 'Population');
    expect(population).toContain('- Cited data: a saved data view (origin: filter), not a computed result');
    expect(population).toContain('- Producing run: not applicable — snapshot is a data view, results come from runs linked via chart 2aefc664-0111-441e-aa51-5a528c00c7c9');
    expect(population).toContain("- Read by: Dunn's post-hoc test — facet ENT 059 (run 3a4d494d…)");
    expect(c700.md).not.toMatch(/producing run — not recorded/);
  });

  test('@SI-016 R2-10 "not applicable" never reaches the verdict; Appendix A lists it (F5, FR4, AC24)', async () => {
    const verdict = section(c700.md, 'Verdict');
    expect(verdict).not.toMatch(/not applicable|random seed|per-column filter combinators|producing run/i);
    const appendix = section(c700.md, 'Appendix A — Technical chain');
    expect(appendix).toContain('| Not applicable |');
    expect(appendix).toContain('| per-column filter combinators, producing run |');
    expect((appendix.match(/\| random seed \|/g) ?? []).length).toBe(3);
    expect((section(c700.md, 'Methods').match(/- Random seed: not applicable — this test uses no randomness/g) ?? []).length).toBe(3);
  });

  test('@SI-016 R2-11 Population: one line per run in facet_order with facet, rows, cohort and n (F3, F7, FR24, AC29)', async () => {
    const population = section(c700.md, 'Population');
    const runLines = population.split('\n').filter((l) => l.startsWith("- Dunn's post-hoc test — facet "));
    expect(runLines.map((l) => /facet (.+?) \(run/.exec(l)?.[1])).toEqual(FACETS);
    FACETS.forEach((facet, i) => {
      expect(runLines[i]).toContain(`rows where group is one of HD, IgG4-RD, SD and reference = ${facet}; cohort: Cohort v1`);
      expect(runLines[i]).toContain('n per group: HD: 10, IgG4-RD: 26, SD: 10');
    });
  });

  test('@SI-016 R2-12 raw cohort JSON only in Appendix A; units "not recorded" (F7, FR5, FR24)', async () => {
    const appendixStart = c700.md.indexOf('\n## Appendix A');
    expect(c700.md.slice(0, appendixStart)).not.toContain('{"');
    expect(c700.md.slice(0, appendixStart)).not.toContain('"filters"');
    expect(c700.md.slice(appendixStart)).toContain('| filters {"filterColumnCombinators": null, "filterCombinator": "AND", "filters": [');
    expect((section(c700.md, 'Methods').match(/- Units: pct: unit — not recorded/g) ?? []).length).toBe(3);
  });

  test('@SI-016 R2-13 broken run link is "Not traceable" (949d5bcf v3; FR18, AC12 amended)', async () => {
    const s949 = await download(S949, '?includeSource=false');
    expect(headline(s949.md)).toBe('Not traceable');
    const first = verdictGroups(s949.md)[0];
    expect(first.heading).toBe('Evidence');
    expect(first.rows[0][0]).toBe('error');
  });

  test('@SI-016 R2-14 every headline is one of the four (FR18)', async () => {
    for (const md of [c700.md]) expect(HEADLINES).toContain(headline(md));
  });

  test('@SI-016 R2-15 determinism: two downloads give the same report hash, and the hash verifies (FR13, NFR2, AC30)', async () => {
    const again = await download(C700);
    expect(hashBody(again.md)).toBe(hashBody(c700.md));
    expect(again.manifest.reportSha256).toBe(c700.manifest.reportSha256);
    const recorded = /Report SHA-256: sha256:([0-9a-f]{64})/.exec(c700.md)?.[1];
    expect(createHash('sha256').update(hashBody(c700.md), 'utf8').digest('hex')).toBe(recorded);
  });

  test('@SI-016 R2-16 includeSource=false: same verdict, no chart image, image withheld line (FR12, AC20)', async () => {
    const lean = await download(C700, '?includeSource=false');
    expect(section(lean.md, 'Verdict')).toBe(section(c700.md, 'Verdict'));
    expect(lean.files.some((f) => f.endsWith('.png'))).toBe(false);
    expect(lean.files.some((f) => f.startsWith('data/source/'))).toBe(false);
    expect(lean.md).toContain('Chart image withheld — source data excluded from this bundle (chart 2aefc664, template strip_v1 v1.0.0)');
    expect(lean.manifest.includeSource).toBe(false);
  });
});
