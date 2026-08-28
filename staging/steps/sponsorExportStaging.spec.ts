import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProvenanceStampLegible, isOurFictionalLogo, requiredProvenanceMarkers } from './sponsorExportStaging';

/**
 * UT-STAGE-105..110 (SI-044) — Capture Spec §14/EC11 (AXI-1379). Covers the
 * provenance-stamp legibility check (`requiredProvenanceMarkers`/
 * `assertProvenanceStampLegible` — pure, no network) against the real
 * `sponsor-report-template.service.ts` HTML shape, and the fictional-logo
 * fixture asset itself (EC11: invented, plain, no real-brand resemblance).
 * See `staging/steps/UT.md`.
 */

/** Mirrors the REAL live preview shape (dumped and inspected, this story):
 *  the "Evidence Values" table never renders (`evidenceValues` is always
 *  `[]`) — the threshold is legible via the chart title/evidence prose
 *  instead (`log2FC`/`padj`), not a dedicated table. */
const FULL_HTML = [
  '<div class="report">',
  '  <div class="shared-by">Shared by Biotech One via <strong>Axiome</strong></div>',
  '  <div class="evidence-section"><p class="evidence-text">Significant differential expression — FDR &lt; 0.05, |log2FC| &gt;= 1</p></div>',
  '  <div class="chart-grid"><div class="chart-cell"><img src="data:image/png;base64,AAA" alt="Volcano" /></div></div>',
  '  <div class="provenance"><h3 class="provenance-title">Provenance Stamp</h3></div>',
  '</div>',
].join('\n');

test('UT-STAGE-105: requiredProvenanceMarkers finds nothing missing on the real template shape (stamp + co-branding + threshold figures + chart image)', () => {
  assert.deepEqual(requiredProvenanceMarkers(FULL_HTML), []);
});

test('UT-STAGE-106: assertProvenanceStampLegible does not throw when every marker is present', () => {
  assert.doesNotThrow(() => assertProvenanceStampLegible(FULL_HTML));
});

test('UT-STAGE-107: requiredProvenanceMarkers flags a missing Provenance Stamp heading', () => {
  const html = FULL_HTML.replace('Provenance Stamp', 'Nothing here');
  assert.ok(requiredProvenanceMarkers(html).some((m) => m.includes('stamp')));
});

test('UT-STAGE-108: requiredProvenanceMarkers flags a missing co-branding "Shared by" line', () => {
  const html = FULL_HTML.replace('Shared by', 'Presented by');
  assert.ok(requiredProvenanceMarkers(html).some((m) => m.includes('co-branding')));
});

test('UT-STAGE-109: requiredProvenanceMarkers flags a report with no chart figure (<img)', () => {
  const html = FULL_HTML.replace('<img', '<span');
  assert.ok(requiredProvenanceMarkers(html).some((m) => m.includes('figure')));
});

test('UT-STAGE-109b: requiredProvenanceMarkers flags a report with neither log2FC nor padj text (no legible threshold)', () => {
  const html = FULL_HTML.replace('log2FC', 'nothing').replace(/&gt;= 1/, '');
  assert.ok(requiredProvenanceMarkers(html).some((m) => m.includes('threshold')));
});

test('UT-STAGE-109c: requiredProvenanceMarkers accepts padj alone as legible threshold content (either marker suffices)', () => {
  const html = FULL_HTML.replace('log2FC', 'padj');
  assert.deepEqual(requiredProvenanceMarkers(html), []);
});

test('UT-STAGE-109d (EC11): isOurFictionalLogo is false for a stray pre-existing logo (a live finding — the tenant already carried an unrelated .png before this story ran)', () => {
  assert.equal(isOurFictionalLogo('http://minio:9000/bucket/organizations/x/logo/b5312f48.png?X-Amz-Signature=abc'), false);
});

test('UT-STAGE-109e (EC11): isOurFictionalLogo is true once our .svg is the current logo, ignoring the presigned querystring', () => {
  assert.equal(isOurFictionalLogo('http://minio:9000/bucket/organizations/x/logo/abc123.svg?X-Amz-Signature=abc'), true);
});

test('UT-STAGE-109f: isOurFictionalLogo is false when no logo is set at all', () => {
  assert.equal(isOurFictionalLogo(null), false);
});

test('UT-STAGE-110 (EC11): the fictional sponsor logo asset exists, is a plain SVG, and names an invented sponsor — no real trademark string', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'assets', 'sponsor-logo-meridian-oncology.svg');
  assert.ok(existsSync(path), 'fictional logo asset must be committed to the repo');
  const svg = readFileSync(path, 'utf8');
  assert.match(svg, /<svg/);
  assert.match(svg, /Meridian/);
  // EC11 guard against the two obvious slip-ups: a leftover real-brand name, or a raster/photo asset masquerading as "plain".
  for (const forbidden of ['Roche', 'Pfizer', 'Novartis', 'AstraZeneca', 'Merck', 'GSK', 'Sanofi', 'Bayer', 'Amgen', 'Genentech']) {
    assert.ok(!svg.includes(forbidden), `logo asset must not reference the real pharma name "${forbidden}"`);
  }
});
