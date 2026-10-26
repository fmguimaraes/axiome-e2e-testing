import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2263 (epic AXI-2073, "Audit report also delivered as PDF") — FR25,
 * EC20, AC31–AC38 of
 * `axiome-docs/05 - product/features/IN-PROGRESS-Evidence-Audit-Report.md`.
 *
 * READ-ONLY and REST-only: every scenario downloads the audit bundle of an
 * evidence that already exists in the demo data (same three Mag4 targets as
 * AXI-2257) and asserts facts about the new `report.pdf` entry. Nothing is
 * created, so it can run against a sidecar that shares the demo database.
 * Point it at a stack with API_BASE_URL.
 *
 * Text-extraction uses the Poppler `pdftotext` CLI (confirmed present at
 * /usr/bin/pdftotext in this environment) — the same "shell out to a system
 * binary already relied on elsewhere" pattern as `unzip` in the sibling
 * AXI-2257/AXI-2073-redesign specs.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface EvidenceRef { id: string; version: number; workspaceId: string }

const MAG4_WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const C700: EvidenceRef = { id: 'c700a6bd-e4e6-419d-b506-34190cc7fb0e', version: 1, workspaceId: MAG4_WS };
const B305: EvidenceRef = { id: 'b305a9bf-19b4-4cb7-be72-dc866562346a', version: 1, workspaceId: MAG4_WS };
const S949: EvidenceRef = { id: '949d5bcf-926d-43ec-bfeb-aeae93b3faf2', version: 3, workspaceId: MAG4_WS };

let token: string;

interface ManifestFile { filename: string; sha256: string | null; sizeBytes?: number }
interface Manifest { includeSource: boolean; reportSha256: string; files: ManifestFile[]; pdfNotProduced?: string }
interface Bundle { files: string[]; md: string; manifest: Manifest; pdfPath: string | null; dir: string }

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
  const dir = mkdtempSync(join(tmpdir(), 'axi-2263-'));
  const zip = join(dir, 'bundle.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-q', zip, '-d', join(dir, 'x')]);
  const files = execFileSync('unzip', ['-Z1', zip]).toString('utf8').split('\n').filter(Boolean);
  const read = (name: string) => readFileSync(join(dir, 'x', name), 'utf8');
  const manifest = JSON.parse(read('manifest.json')) as Manifest;
  const pdfPath = files.includes('report.pdf') ? join(dir, 'x', 'report.pdf') : null;
  return { files, md: read('report.md'), manifest, pdfPath, dir };
}

/**
 * Plain text extracted from a PDF, via the Poppler `pdftotext` CLI.
 *
 * Deliberately NOT `-layout`: that mode prints each table in column-aligned
 * form, one PHYSICAL LINE per wrapped fragment ACROSS ALL COLUMNS at once
 * (column 1's 2nd wrapped line sits on the same physical output line as
 * column 4's 2nd wrapped line) — correct for a human skimming the page, but
 * it interleaves unrelated columns' fragments when flattened to a flat word
 * stream, which made a multi-column Appendix A row's long filename
 * unreconstructable in document order. Default (reading-order) mode keeps
 * one table CELL's wrapped text contiguous instead, which is what
 * `wordFoundFrom`'s fragment-reconstruction fallback needs.
 */
function pdfText(pdfPath: string): string {
  return execFileSync('pdftotext', [pdfPath, '-']).toString('utf8');
}

/** `report.md`'s own words, Markdown syntax stripped, reading order within
 * the chunk of text handed in (used per-SECTION, see `sectionWordLists`). */
function markdownWords(md: string): string[] {
  return md
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    // `[text](url)` renders as an <a> showing only its link text (same as
    // `inlineMarkdown` in the renderer) — the raw `[…](…)` syntax, including
    // the href, is never on the rendered page.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\*\*/g, '')
    .split(/\s+/)
    .filter(Boolean)
    // Markdown pipe-table separator rows (`| --- | --- |`) are syntax, not
    // content — the renderer turns the table into a real HTML table and
    // never emits the `---` cells as text, so they must not be expected in
    // the PDF's extracted text either (same reasoning as stripping headings
    // / bullets / blockquote markers above).
    .filter((w) => !/^-+$/.test(w));
}

/**
 * Poppler's `pdftotext` de-hyphenates a word that happened to line-wrap at a
 * `-` (e.g. "data-protection" wrapped at the hyphen renders as
 * "dataprotection", no hyphen, one token) — a normal Poppler artifact for any
 * wrapped hyphenated compound, not a content-loss bug in the renderer.
 * Stripping every `-` before comparing makes the match hyphen-wrap-insensitive
 * on both sides.
 */
function dehyphenate(word: string): string {
  return word.replace(/-/g, '');
}

/**
 * A single long token with NO internal space or hyphen (a filename, hash or
 * UUID — e.g. `final_tableau1_long_synthetic.csv`) has no break opportunity
 * for the CSS to prefer, so AC6's `overflow-wrap: anywhere` legitimately
 * force-wraps it mid-character with no joining mark at all (unlike a
 * hyphenated compound, which at least leaves a `-` or a de-hyphenation
 * Poppler can undo) — `pdftotext` then emits the fragments as separate,
 * un-joined tokens. This is the wrap AC6/AC36 exists to require (no
 * truncation), not content loss, so word lookup below tries reconstructing
 * such a word from consecutive haystack tokens before giving up on it.
 */
const MAX_WRAP_FRAGMENTS = 8;

/** Finds `target` starting at or after `from` (bounded by `upTo`, exclusive),
 * by scanning position by position and trying spans 1..MAX_WRAP_FRAGMENTS at
 * each — span 1 is the ordinary exact-token match, a larger span is the AC6
 * force-wrap reconstruction. Returns the end index (exclusive) just past the
 * match, or -1. */
function wordFoundFrom(haystackNorm: string[], from: number, upTo: number, target: string): number {
  for (let start = from; start < upTo; start++) {
    let acc = '';
    for (let span = 1; span <= MAX_WRAP_FRAGMENTS && start + span <= haystackNorm.length; span++) {
      acc += haystackNorm[start + span - 1];
      if (acc === target) return start + span;
      if (acc.length > target.length) break;
    }
  }
  return -1;
}

/**
 * report.md split into its top-level (`## `) sections, each as its own
 * Markdown-syntax-stripped word list (one list per section, in document
 * order; a leading preamble before the first `## ` heading is its own
 * "section" too).
 *
 * Section granularity, not whole-document or per-line: Poppler's
 * `pdftotext` reading-order heuristic can, rarely, swap a SHORT isolated
 * block relative to an immediate neighbour — observed live on b305a9bf's
 * report.pdf, where a one-row table's own heading was extracted right AFTER
 * that table instead of before it, though both are correctly ordered on the
 * actual rendered page (confirmed by hand). A whole-document strict
 * word-by-word order check breaks on exactly this kind of micro-reorder,
 * even though nothing is missing or meaningfully out of place. Checking
 * "every word of this SECTION is present, each section strictly after the
 * previous one" is still a real, meaningful order+completeness proof (a
 * dropped section, a reordered section, or missing content inside one all
 * fail it) without being hostage to a text-extraction tool's internal
 * micro-layout heuristics for tiny blocks within a section.
 */
function sectionWordLists(md: string): string[][] {
  const lines = md.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line.trim()) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections
    .map((section) => markdownWords(section).filter((w) => !w.startsWith('Generated:')))
    .filter((words) => words.length > 0);
}

/** Asserts every section of `report.md` (see `sectionWordLists`) is fully
 * present in the PDF's extracted text, each section strictly after the
 * previous one. */
function expectSectionsInOrder(haystack: string[], sections: string[][], label: string): void {
  const haystackNorm = haystack.map(dehyphenate);
  let cursor = 0;
  for (const words of sections) {
    let furthest = cursor;
    for (const word of words) {
      const target = dehyphenate(word);
      const end = wordFoundFrom(haystackNorm, cursor, haystackNorm.length, target);
      expect(end, `${label}: expected "${word}" at/after position ${cursor} (section starting "${words[0]}")`).toBeGreaterThanOrEqual(0);
      if (end > furthest) furthest = end;
    }
    cursor = furthest;
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test.beforeAll(async () => {
  token = await login();
});

test.describe('AXI-2263 audit report PDF — read-only on the demo data', () => {
  let c700: Bundle;
  let b305: Bundle;
  let s949: Bundle;

  test.beforeAll(async () => {
    c700 = await download(C700);
    b305 = await download(B305);
    s949 = await download(S949);
  });

  test('@SI-016 AC31 report.pdf is present next to report.md in every bundle', async () => {
    for (const bundle of [c700, b305, s949]) {
      expect(bundle.files).toContain('report.pdf');
      expect(bundle.files).toContain('report.md');
    }
  });

  test('@SI-016 AC31 manifest lists report.pdf with sha256 and sizeBytes matching the actual bytes', async () => {
    for (const bundle of [c700, b305, s949]) {
      expect(bundle.pdfPath, 'report.pdf extracted').not.toBeNull();
      const entry = bundle.manifest.files.find((f) => f.filename === 'report.pdf');
      expect(entry, 'manifest has a report.pdf entry').toBeDefined();
      expect(entry!.sha256).toBe(`sha256:${sha256File(bundle.pdfPath!)}`);
      expect(entry!.sizeBytes).toBe(statSync(bundle.pdfPath!).size);
      expect(bundle.manifest.pdfNotProduced).toBeUndefined();
    }
  });

  test('@SI-016 AC32 report.pdf text carries every word of report.md, in order (c700a6bd)', async () => {
    const haystack = pdfText(c700.pdfPath!).split(/\s+/).filter(Boolean);
    // sectionWordLists already drops the "Generated:" line's own real
    // timestamp (report.md's native generation-time line, GENERATED_PREFIX)
    // — a word-for-word match would be hostage to wall-clock time, so it is
    // excluded from this completeness/order check the same way AC33's own
    // determinism test excludes it. (Review fix B5: an earlier draft
    // attributed this exclusion to a PDF-only banner that has since been
    // removed — there never was one; this line is report.md's own.)
    expectSectionsInOrder(haystack, sectionWordLists(c700.md), 'report.pdf text vs report.md (c700a6bd)');
  });

  test('@SI-016 AC32 report.pdf text carries report.md text (b305a9bf, 949d5bcf)', async () => {
    for (const bundle of [b305, s949]) {
      const haystack = pdfText(bundle.pdfPath!).split(/\s+/).filter(Boolean);
      expectSectionsInOrder(haystack, sectionWordLists(bundle.md), `report.pdf text vs report.md (${bundle.manifest.reportSha256})`);
    }
  });

  test('@SI-016 AC34 report.md stays authoritative — its own Report SHA-256 line is still present and recomputable', async () => {
    for (const bundle of [c700, b305, s949]) {
      expect(bundle.md).toContain('Report SHA-256: ');
      expect(bundle.manifest.reportSha256).toContain('sha256:');
    }
  });

  test('@SI-016 AC33/NFR2 two downloads of the same version give byte-identical-apart-from-nothing-live report.pdf', async () => {
    const again = await download(C700);
    expect(again.files).toContain('report.pdf');
    // manifest.reportSha256 is computed from report.md, never report.pdf —
    // it must be identical across downloads regardless of the PDF's own
    // metadata.
    expect(again.manifest.reportSha256).toBe(c700.manifest.reportSha256);
    const sizeA = statSync(c700.pdfPath!).size;
    const sizeB = statSync(again.pdfPath!).size;
    expect(Math.abs(sizeA - sizeB)).toBeLessThanOrEqual(64); // metadata-string-length only
    // Review fix B4: a byte-size delta and an equal reportSha256 are NOT
    // proof the PDF's own CreationDate/ModDate were actually stamped to the
    // fixed sentinel — they would pass identically whether the stamping
    // happened or not. Assert directly, via Poppler `pdfinfo`, that BOTH
    // downloads carry the SAME fixed sentinel dates (never the real
    // wall-clock download time, which would differ between the two
    // sequential downloads if stamping were broken).
    // `pdfinfo`'s own CreationDate/ModDate lines are rendered in the LOCAL
    // timezone of whatever host runs the assertion (confirmed live: the raw
    // UTC sentinel `D:19700101000000` prints as "01/01/1970 00:00:00 +00'00'"
    // on a UTC host but "Thu Jan 1 01:00:00 1970 CET" on a UTC+1 host),
    // so comparing its formatted text is not timezone-portable. Assert
    // directly on the PDF's own raw Info-dictionary bytes instead — exactly
    // the sentinel `stampDeterministicPdfMetadata` (audit-report-pdf.renderer.ts)
    // writes, independent of any locale/timezone rendering.
    const SENTINEL_RAW = 'D:19700101000000';
    const rawA = readFileSync(c700.pdfPath!, 'latin1');
    const rawB = readFileSync(again.pdfPath!, 'latin1');
    expect(rawA).toMatch(new RegExp(`/CreationDate \\(${SENTINEL_RAW}`));
    expect(rawA).toMatch(new RegExp(`/ModDate \\(${SENTINEL_RAW}`));
    expect(rawB).toMatch(new RegExp(`/CreationDate \\(${SENTINEL_RAW}`));
    expect(rawB).toMatch(new RegExp(`/ModDate \\(${SENTINEL_RAW}`));
    // Still confirm `pdfinfo` can read a well-formed date out of it at all
    // (a malformed Info dictionary would make it silently omit the field).
    const infoA = execFileSync('pdfinfo', [c700.pdfPath!]).toString('utf8');
    const infoB = execFileSync('pdfinfo', [again.pdfPath!]).toString('utf8');
    expect(infoA).toMatch(/^CreationDate:\s*.+$/m);
    expect(infoA).toMatch(/^ModDate:\s*.+$/m);
    expect(infoB).toMatch(/^CreationDate:\s*.+$/m);
    expect(infoB).toMatch(/^ModDate:\s*.+$/m);
    // `Producer` is Chromium's own build string — fixed per running
    // deployment but NOT independently stamped (it changes across a
    // Chromium/Puppeteer upgrade), so this test deliberately does not assert
    // on it; see NFR2's corrected wording (review fix B4).
    //
    // pdftotext of the two PDFs must be identical except for the one
    // "Generated:" line (the only wall-clock content FR25 allows).
    const textA = pdfText(c700.pdfPath!)
      .split('\n')
      .filter((line) => !line.startsWith('Generated:'));
    const textB = pdfText(again.pdfPath!)
      .split('\n')
      .filter((line) => !line.startsWith('Generated:'));
    expect(textB).toEqual(textA);
  });

  test('@SI-016 AC36 wide Appendix A tables render without truncated cells in the PDF text', async () => {
    const text = pdfText(c700.pdfPath!);
    // A truncated cell would show a mid-word ellipsis/cut; assert the longest
    // recorded long-form id/hash substrings from report.md's Appendix A
    // reappear whole in the PDF text (wrap, not cut).
    const appendixStart = c700.md.indexOf('## Appendix A');
    expect(appendixStart).toBeGreaterThanOrEqual(0);
    const appendix = c700.md.slice(appendixStart);
    const longTokens = Array.from(appendix.matchAll(/\b[0-9a-f]{8,}\b/g)).map((m) => m[0]).slice(0, 5);
    for (const token of longTokens) {
      expect(text, `Appendix A token "${token}" present whole in report.pdf text`).toContain(token);
    }
  });

  test('@SI-016 EC20/AC34/AC5 includeSource=false still ships report.pdf, withholds chart images, and the PDF itself embeds none (c700a6bd)', async () => {
    const noSource = await download(C700, '?includeSource=false');
    expect(noSource.manifest.includeSource).toBe(false);
    expect(noSource.files.some((f) => f.startsWith('charts/'))).toBe(false);
    // report.pdf itself must still be produced — FR25/EC20 only drops images,
    // never the PDF rendering as a whole, when source is merely withheld.
    expect(noSource.files).toContain('report.pdf');
    expect(noSource.manifest.pdfNotProduced).toBeUndefined();
    // Review fix B3: a prior draft only checked `charts/*.png` was absent
    // from the ZIP — it never checked the PDF's OWN rendering of the
    // withholding. `imageText` (shows.section.ts) emits the literal
    // "Chart image withheld" line in report.md whenever a chart is cited but
    // its source data was excluded; that line must survive into the PDF's
    // extracted text, and `pdfimages -list` (Poppler) must show NO embedded
    // image at all — a text-only mention that merely NAMES withholding is
    // not the same fact as an image that was actually never embedded.
    const text = pdfText(noSource.pdfPath!);
    expect(text).toContain('Chart image withheld');
    const imagesList = execFileSync('pdfimages', ['-list', noSource.pdfPath!]).toString('utf8');
    const imageDataRows = imagesList
      .split('\n')
      .slice(2) // Poppler's two header lines (column names + a `---` separator)
      .filter((line) => line.trim().length > 0);
    expect(imageDataRows, `pdfimages -list output:\n${imagesList}`).toHaveLength(0);
  });

  test('@SI-016 AC35 no storage keys or hostnames leak into report.pdf text', async () => {
    for (const bundle of [c700, b305, s949]) {
      const text = pdfText(bundle.pdfPath!);
      expect(text).not.toMatch(/https?:\/\/[^\s)]+/);
      expect(text).not.toMatch(/\bs3:\/\//);
      expect(text).not.toMatch(/\b[\w.-]+\.(internal|vpc|amazonaws\.com)\b/);
    }
  });
});
