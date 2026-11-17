import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { evidenceVerdict, isLocalTarget, parseCommits, readHandoverConfig, type HandoverConfig } from '../../tests/AXI-2598/harness/config';
import { checkFile, pngDpi } from '../../tests/AXI-2598/harness/files';
import { classifyDefects, KNOWN_DEFECTS, knownDefect, stepVerdict } from '../../tests/AXI-2598/harness/known-defects';
import { pollUntil, PollTimeoutError } from '../../tests/AXI-2598/harness/poll';
import { cellCount, csvFacts, expectedMapping, presetProblems, questionBody, sha256Hex, type Preset } from '../../tests/AXI-2598/harness/preset';
import { saltedVariant } from '../../tests/AXI-2598/harness/rehearsal';
import { Ledger, renderMarkdown } from '../../tests/AXI-2598/harness/report';
import { setUpWorld } from '../../tests/AXI-2598/harness/world';

/**
 * UT-HANDOVER-2601-1 .. UT-HANDOVER-2601-24 (epic AXI-2598 — AXI-2601, SI-042, SI-044).
 * Pure unit coverage of the handover suite harness: the preset check against the data file
 * (FR12, EC6, EC7), env-only configuration and the evidence verdict (FR2, FR31, EC20), the bounded
 * poll, file-type checks (FR5, FR25), the known-defect registry and the secret-refusing report
 * (FR7, NFR4). No network. Run via `npm run harness:unit`. See `UT.md`.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const PRESET = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/handover/mag4-preset.json'), 'utf8')) as Preset;
const CSV = readFileSync(path.join(ROOT, PRESET.dataFile.path));
const clone = (): Preset => JSON.parse(JSON.stringify(PRESET));

// ── preset (FR12, EC6, EC7) ───────────────────────────────────────────────

test('UT-HANDOVER-2601-1 the committed preset matches the committed data file with no problem', () => {
  assert.deepEqual(presetProblems(PRESET, csvFacts(CSV.toString('utf8')), sha256Hex(CSV)), []);
});

test('UT-HANDOVER-2601-2 a field whose name differs by case is refused, naming the near column (EC2)', () => {
  const p = clone();
  p.dataSpecification.fields[0].name = p.dataSpecification.fields[0].name.toUpperCase();
  for (const q of p.questions) for (const b of q.bindings) if (b.field === PRESET.dataSpecification.fields[0].name) b.field = p.dataSpecification.fields[0].name;
  const problems = presetProblems(p, csvFacts(CSV.toString('utf8')));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not a column of the data file \(the file has "microbiote/);
});

test('UT-HANDOVER-2601-3 a grouping level not equal to the file values is refused (FR12)', () => {
  const p = clone();
  const g = p.dataSpecification.fields.find((f) => f.semanticRole === 'grouping_three_plus_levels')!;
  g.levels = ['C1', 'C2', 'C3', 'c4'];
  assert.ok(presetProblems(p, csvFacts(CSV.toString('utf8'))).some((x) => x.includes('declares levels [C1, C2, C3, c4]')));
});

test('UT-HANDOVER-2601-4 T5 or T3 pinned at 0.4 is refused whatever the role (EC6)', () => {
  const p = clone();
  p.questions[0].template.templateVersion = '0.4';
  assert.ok(presetProblems(p, csvFacts(CSV.toString('utf8'))).some((x) => /T5@0.4.*EC6/.test(x)));
});

test('UT-HANDOVER-2601-5 a multi-cell correlation at 0.3 that is not exploratory is refused (EC7)', () => {
  const p = clone();
  p.questions[0].role = 'secondary';
  assert.ok(presetProblems(p, csvFacts(CSV.toString('utf8'))).some((x) => /42-cell correlation at 0.3 and must be exploratory/.test(x)));
});

test('UT-HANDOVER-2601-6 a binding to an undeclared field, a duplicate key and a wrong sha are all refused at once', () => {
  const p = clone();
  p.questions[1].bindings[0].field = 'nope';
  p.questions[2].key = p.questions[1].key;
  const problems = presetProblems(p, csvFacts(CSV.toString('utf8')), 'deadbeef');
  assert.ok(problems.some((x) => x.includes('undeclared field "nope"')));
  assert.ok(problems.some((x) => x.includes('is used twice')));
  assert.ok(problems.some((x) => x.startsWith('data file sha256 deadbeef')));
});

test('UT-HANDOVER-2601-7 csvFacts reads quoted cells, CRLF and per-column blanks', () => {
  const f = csvFacts('a,"b,c",d\r\n1,"x ""y""",\r\n2,,z\r\n');
  assert.deepEqual(f.header, ['a', 'b,c', 'd']);
  assert.equal(f.rows, 2);
  assert.deepEqual(f.values['b,c'], ['x "y"']);
  assert.deepEqual(f.blanks, { a: 0, 'b,c': 1, d: 1 });
});

test('UT-HANDOVER-2601-8 the data file blanks are the ones the report states (EC4)', () => {
  const b = csvFacts(CSV.toString('utf8')).blanks;
  assert.deepEqual(Object.fromEntries(Object.entries(b).filter(([, n]) => n > 0)), {
    score_histo: 2, eosinophils: 3, plasmablasts_cd19_cd38_cd27_mm3: 2, tfh_cxcr5_pd1_cd4: 1,
  });
});

test('UT-HANDOVER-2601-9 cellCount multiplies the many-slots; the heatmap question is 7 × 6', () => {
  assert.equal(cellCount(PRESET.questions[0]), 42);
  assert.equal(cellCount(PRESET.questions[1]), 1);
});

test('UT-HANDOVER-2601-10 questionBody binds by server fieldId and refuses an unknown name', () => {
  const ids = new Map(PRESET.dataSpecification.fields.map((f, i) => [f.name, `F${i}`]));
  const body = questionBody(PRESET.questions[1], ids);
  assert.ok(body.bindings.every((b) => /^F\d+$/.test(b.field)));
  assert.deepEqual(body.sensitivityAnalyses, []);
  assert.throws(() => questionBody(PRESET.questions[1], new Map()), /no server fieldId/);
  assert.deepEqual(expectedMapping(PRESET, ids)[0], { fieldId: 'F0', column: PRESET.dataSpecification.fields[0].name });
});

test('UT-HANDOVER-2601-11 the salted fallback keeps every preset column and value and changes the hash', () => {
  const salted = saltedVariant(CSV, 'tok1');
  const a = csvFacts(CSV.toString('utf8'));
  const b = csvFacts(salted.toString('utf8'));
  assert.deepEqual(b.header, [...a.header, 'axi2601_rehearsal_run']);
  for (const col of a.header) assert.deepEqual(b.values[col], a.values[col]);
  assert.deepEqual(b.values.axi2601_rehearsal_run, ['tok1']);
  assert.notEqual(sha256Hex(salted), sha256Hex(CSV));
});

// ── configuration (FR2, FR4, FR31, EC20) ──────────────────────────────────

const ENV = { BASE_URL: 'http://f/', API_BASE_URL: 'http://g/', HANDOVER_WORKSPACE_ID: 'w', E2E_INVESTIGATOR_PASSWORD: 'x' };

test('UT-HANDOVER-2601-12 every missing variable is named at once, a credential never echoed', () => {
  const r = readHandoverConfig({});
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.missing, ['BASE_URL', 'API_BASE_URL', 'HANDOVER_WORKSPACE_ID', 'E2E_INVESTIGATOR_PASSWORD']);
});

test('UT-HANDOVER-2601-13 the investigator role defaults its email; the provisioner is null unless both halves are set', () => {
  const r = readHandoverConfig({ ...ENV, HANDOVER_PROVISIONER_EMAIL: 'p@x' });
  assert.ok(r.ok);
  assert.equal(r.ok && r.config.investigator.email, 'investigator@axiomebio.com');
  assert.equal(r.ok && r.config.provisioner, null);
  assert.equal(r.ok && r.config.apiBaseUrl, 'http://g');
});

test('UT-HANDOVER-2601-14 parseCommits needs all three services as short or full shas', () => {
  assert.deepEqual(parseCommits('front=abc1234,back=def5678,compute=0123abc'), { front: 'abc1234', back: 'def5678', compute: '0123abc' });
  assert.equal(parseCommits('front=abc1234,back=def5678'), null);
  assert.equal(parseCommits('front=main,back=def5678,compute=0123abc'), null);
});

test('UT-HANDOVER-2601-15 a run counts as evidence only with commits recorded AND stated equal to main (FR31, EC20)', () => {
  const c = { front: 'a1b2c3d', back: 'a1b2c3d', compute: 'a1b2c3d' };
  assert.equal(evidenceVerdict({ commits: null, commitsOnMain: true }).counts, false);
  assert.match(evidenceVerdict({ commits: c, commitsOnMain: false }).reason, /EC20/);
  assert.equal(evidenceVerdict({ commits: c, commitsOnMain: null }).counts, false);
  assert.equal(evidenceVerdict({ commits: c, commitsOnMain: true }).counts, true);
});

// ── poll ──────────────────────────────────────────────────────────────────

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test('UT-HANDOVER-2601-16 pollUntil returns the settled value with elapsed time and observation count', async () => {
  const c = clock();
  let n = 0;
  const out = await pollUntil({ what: 'x', timeoutMs: 10_000, intervalMs: 1_000, read: async () => ++n, done: (v) => v === 3, ...c });
  assert.deepEqual(out, { value: 3, elapsedMs: 2_000, observations: 3 });
});

test('UT-HANDOVER-2601-17 pollUntil stops at the deadline with the last observation', async () => {
  const c = clock();
  await assert.rejects(
    pollUntil({ what: 'ingestion', timeoutMs: 3_000, intervalMs: 1_000, read: async () => 'pending', done: () => false, ...c }),
    (e: unknown) => e instanceof PollTimeoutError && e.last === 'pending' && /ingestion: not settled after 3000 ms/.test(e.message),
  );
});

test('UT-HANDOVER-2601-18 pollUntil fails fast on a fatal observation', async () => {
  const c = clock();
  await assert.rejects(
    pollUntil({ what: 'ingestion', timeoutMs: 60_000, intervalMs: 1_000, read: async () => 'failed', done: () => false, fatal: (v) => (v === 'failed' ? 'ingestion failed' : null), ...c }),
    (e: unknown) => e instanceof PollTimeoutError && e.elapsedMs === 0,
  );
});

// ── files (FR5, FR25) ─────────────────────────────────────────────────────

function png(dpi: number | null): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = chunk('IHDR', Buffer.alloc(13));
  const phys = dpi === null ? Buffer.alloc(0) : (() => {
    const d = Buffer.alloc(9);
    const ppm = Math.round(dpi / 0.0254);
    d.writeUInt32BE(ppm, 0);
    d.writeUInt32BE(ppm, 4);
    d.writeUInt8(1, 8);
    return chunk('pHYs', d);
  })();
  return Buffer.concat([magic, ihdr, phys, chunk('IDAT', Buffer.alloc(1)), chunk('IEND', Buffer.alloc(0))]);
}

test('UT-HANDOVER-2601-19 pngDpi reads pHYs; a PNG is valid only at 300 dpi (FR25)', () => {
  assert.equal(pngDpi(png(300)), 300);
  assert.equal(pngDpi(png(null)), null);
  assert.equal(checkFile('png', png(300)).valid, true);
  assert.match(checkFile('png', png(72)).note, /72 dpi/);
  assert.match(checkFile('png', png(null)).note, /no pHYs/);
});

test('UT-HANDOVER-2601-20 checkFile trusts bytes, not the content type: PDF, ZIP, SVG, CSV, MD, empty', () => {
  assert.equal(checkFile('pdf', Buffer.from('%PDF-1.7 ...')).valid, true);
  assert.equal(checkFile('pdf', Buffer.from('{"message":"x"}')).valid, false);
  assert.equal(checkFile('zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])).valid, true);
  assert.equal(checkFile('svg', Buffer.from('<?xml?><svg xmlns="x">')).valid, true);
  assert.equal(checkFile('csv', Buffer.from('a,b\n1,2\n')).valid, true);
  assert.equal(checkFile('csv', Buffer.from('a,b\n')).valid, false);
  assert.equal(checkFile('md', Buffer.from('# Report')).valid, true);
  assert.equal(checkFile('md', Buffer.from('{"error":1}')).valid, false);
  assert.deepEqual(checkFile('svg', Buffer.alloc(0)), { valid: false, note: 'empty body' });
});

// ── known defects (FR7, NFR3) ─────────────────────────────────────────────

test('UT-HANDOVER-2601-21 a step is an expected failure only when every defect is registered', () => {
  const reg = { a: { step: 'S1', note: 'a' }, 'fam-*': { step: 'S1', note: 'f' } };
  assert.deepEqual(classifyDefects([], false, reg), { outcome: 'none', unknown: [] });
  assert.equal(classifyDefects(['a', 'fam-Q1'], false, reg).outcome, 'known');
  assert.deepEqual(classifyDefects(['a', 'b'], false, reg), { outcome: 'new', unknown: ['b'] });
  assert.equal(classifyDefects(['b'], true, reg).outcome, 'known');
  assert.equal(knownDefect('fam-', reg)?.note, 'f');
  assert.equal(knownDefect('fa', reg), null);
});

test('UT-HANDOVER-2601-25 step verdict: registered defects all still observed → expected failure; nothing → pass', () => {
  const reg = { a: { step: 'S8', note: 'a' }, b: { step: 'S8', note: 'b' }, c: { step: 'S9', note: 'c' } };
  const v = stepVerdict('S8', ['a', 'b', 'a'], false, reg);
  assert.equal(v.outcome, 'expected-fail');
  assert.deepEqual([v.stillPresent, v.fixed, v.unknown], [['a', 'b'], [], []]);
  assert.match(v.message, /known product defect\(s\): a — a; b — b/);
  assert.equal(stepVerdict('S1', [], false, reg).outcome, 'pass');
});

test('UT-HANDOVER-2601-26 step verdict: a registered defect no longer observed is red, even when another registered one remains', () => {
  const reg = { a: { step: 'S8', note: 'a' }, b: { step: 'S8', note: 'b' } };
  const partial = stepVerdict('S8', ['b'], false, reg);
  assert.equal(partial.outcome, 'fail');
  assert.deepEqual([partial.stillPresent, partial.fixed, partial.unknown], [['b'], ['a'], []]);
  assert.match(partial.message, /NO LONGER OBSERVED.*: a$/);
  const allFixed = stepVerdict('S8', [], false, reg);
  assert.equal(allFixed.outcome, 'fail');
  assert.deepEqual(allFixed.fixed, ['a', 'b']);
});

test('UT-HANDOVER-2601-27 step verdict: an unregistered code (or one registered for ANOTHER step) is red; continue mode expects all', () => {
  const reg = { a: { step: 'S8', note: 'a' }, c: { step: 'S9', note: 'c' } };
  const v = stepVerdict('S8', ['a', 'x'], false, reg);
  assert.equal(v.outcome, 'fail');
  assert.deepEqual([v.stillPresent, v.fixed, v.unknown], [['a'], [], ['x']]);
  assert.match(v.message, /NEW defect\(s\).*S8: x/);
  assert.deepEqual(stepVerdict('S8', ['a', 'c'], false, reg).unknown, ['c']);
  const both = stepVerdict('S8', ['x'], false, reg);
  assert.match(both.message, /NO LONGER OBSERVED.*a \| NEW.*x/);
  assert.equal(stepVerdict('S8', ['x'], true, reg).outcome, 'expected-fail');
  assert.equal(stepVerdict('S8', [], true, reg).outcome, 'pass');
});

test('UT-HANDOVER-2601-28 step verdict: a wildcard entry is present while any code of its family is observed', () => {
  const reg = { 'fam-*': { step: 'S9', note: 'f' } };
  assert.equal(stepVerdict('S9', ['fam-Q1', 'fam-Q2'], false, reg).outcome, 'expected-fail');
  assert.deepEqual(stepVerdict('S9', [], false, reg).fixed, ['fam-*']);
  assert.deepEqual(stepVerdict('S9', ['fam-Q1', 'other'], false, reg).unknown, ['other']);
});

test('UT-HANDOVER-2601-29 the shipped registry pins every entry to a step S0..S12', () => {
  for (const [code, d] of Object.entries(KNOWN_DEFECTS)) assert.match(d.step, /^S([0-9]|1[0-2])$/, code);
});

test('UT-HANDOVER-2601-30 FR8 fail closed: a non-local target without a forbidden-org list is refused before any request', async () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:8080/api', 'http://[::1]:3000']) assert.equal(isLocalTarget(url), true, url);
  for (const url of ['https://app.example.com', 'http://localhost.example.com', 'not a url', '']) assert.equal(isLocalTarget(url), false, url);
  const cfg = { apiBaseUrl: 'https://app.example.com', forbiddenOrgIds: [] } as unknown as HandoverConfig;
  await assert.rejects(setUpWorld(cfg), /FR8: target https:\/\/app\.example\.com is not local and no forbidden-org list/);
});

// ── report (FR6, FR7, NFR4) ───────────────────────────────────────────────

function ledger(dir: string): Ledger {
  const l = new Ledger({
    mode: 'rehearsal', runToken: 't1', startedAt: '2026-11-17T00:00:00Z',
    target: { label: 'local', baseUrl: 'f', apiBaseUrl: 'g', workspaceId: 'w' },
    commits: null, evidence: { counts: false, reason: 'r' }, preset: null,
  });
  l.paths = { reportRoot: dir, slug: '2026-11-17-bare-api-rehearsal' };
  return l;
}

test('UT-HANDOVER-2601-22 defects get run-local ids and land on their step; a step is reused by id', () => {
  const l = ledger('/nowhere');
  const s = l.step('S5', 'Upload');
  assert.equal(l.step('S5', 'other'), s);
  const d = l.defect(s, { code: 'c', title: 't', endpoint: 'e', request: 'r', observed: 'o', expected: 'x', suspectedLocation: 'l', severity: 'minor' });
  assert.equal(d.id, 'D1');
  assert.deepEqual(s.defectIds, ['D1']);
  l.residue({ kind: 'dataset', id: 'x', removed: false, note: 'n' });
  l.residue({ kind: 'dataset', id: 'x', removed: true, note: 'deleted' });
  assert.equal(l.report.residue.length, 1);
  const md = renderMarkdown(l.report);
  assert.match(md, /### D1 — t \(minor, `c`\)/);
  assert.match(md, /Service commits:\*\* NOT RECORDED/);
  assert.match(md, /\| dataset \| `x` \| yes \| deleted \|/);
});

test('UT-HANDOVER-2601-23 the report is written as run-<token>.json + REPORT-<token>.md under the dated slug', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'axi2601-'));
  try {
    const out = ledger(dir).write();
    assert.equal(out, path.join(dir, '2026-11-17-bare-api-rehearsal'));
    assert.deepEqual(readdirSync(out).sort(), ['REPORT-t1.md', 'run-t1.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UT-HANDOVER-2601-24 a report carrying a bearer token is refused, nothing written (NFR4, AC20)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'axi2601-'));
  try {
    const l = ledger(dir);
    l.step('S2', 'Sign-in').facts.push('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop');
    assert.throws(() => l.write(), /refusing to write run\.json/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
