import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AXI-2070 (epic AXI-2067 — FR12, AC6; D3, D6). Scenario doc:
 * `manual-e2e/AXI-2067-Method-R-Equivalence-Statement.md` §AXI-2070, scenarios 1-4.
 *
 * Nothing here reads a hand-made release. `beforeAll` runs the REAL one-command
 * release (`axiome-bio-compute/scripts/validation/statement/release.sh --study
 * scripts/validation/statement/studies/microbiote-igg4.json`: real parity harness →
 * real `generate --study` → real `publish --study`) on a throwaway local clone of the
 * bio-compute checkout, over the REAL docs root and the clone's REAL fixture corpus —
 * the production command, unchanged. The browser then loads the published bytes at
 * the study address under the front's origin; `page.route` serves `/r-equivalence/**`
 * from that publish root, standing in for the front's generic static `public/` serving
 * (no real release is committed to `axiome-front/public/r-equivalence/` yet — the lead
 * publishes the first one from bio-compute main), the same stand-in AXI-2071 uses.
 *
 * What each method section must say is read from the generator's own internal
 * `statement.json` of the SAME run (kept with `--work-dir`), so the page is checked
 * against the evidence, never against a list typed here. AC6 (all six methods with an
 * R comparison) is asserted as such: on a bio-compute main without AXI-2068's Dunn,
 * partial-correlation and BH fixtures it FAILS, by design, until they merge.
 *
 * Required environment (the spec FAILS, never skips, when one is missing):
 *   AXIOME_BIO_COMPUTE_DIR    an axiome-bio-compute checkout; its COMMITTED HEAD is used
 *   AXIOME_DOCS_ROOT          an axiome-docs checkout (the real MSRs, Hazard Table, VMP, Feature doc)
 *   AXIOME_BIO_COMPUTE_PYTHON interpreter with bio-compute's dependencies (default: python3)
 *
 * @SI-051 @SI-037
 */

const ARTICLE_PATH = '/help/governance-and-provenance/r-equivalence-statement';
const ARTICLE_TITLE = 'The Method R-Equivalence Statement';
const STUDY_SLUG = 'microbiote-igg4';
const STUDY_NAME = 'Microbiote IgG4 study';
const STUDY_FILE = path.join('scripts', 'validation', 'statement', 'studies', `${STUDY_SLUG}.json`);
const STUDY_TITLE = `Method R-Equivalence Statement — ${STUDY_NAME} (external)`;
const MICROBIOTE_METHODS = [
  'stats.kruskal_wallis',
  'stats.dunn_posthoc',
  'stats.correlation',
  'stats.partial_correlation',
  'stats.mann_whitney_u',
  'stats.family_adjust',
];
const RELEASE_FILES = ['external.html', 'external.md', 'manifest.json'];
const NO_COMPARISON = 'no R comparison yet';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for the AXI-2070 study fixture (see the spec header)`);
  return value;
}

/** Same rule as the generator's `exporters.method_anchor`. */
function anchor(methodId: string): string {
  return methodId.replace(/\./g, '-');
}

interface StatementMethod {
  method_id: string;
  has_r_comparison: boolean;
  fixtures_total: number;
  fixtures_agreeing: number;
  verdict: string;
}

class StudyReleaseFixture {
  readonly work = fs.mkdtempSync(path.join(os.tmpdir(), 'axi2070-e2e-'));
  readonly clone = path.join(this.work, 'bio-compute');
  readonly publishRoot = path.join(this.work, 'r-equivalence');
  readonly python = process.env.AXIOME_BIO_COMPUTE_PYTHON?.trim() || 'python3';
  private releases = 0;

  constructor(private readonly bioComputeDir: string, private readonly docsRoot: string) {}

  prepare(): void {
    this.run('git', ['clone', '--quiet', '--local', this.bioComputeDir, this.clone]);
  }

  get sha(): string {
    return this.run('git', ['-C', this.clone, 'rev-parse', 'HEAD']).trim();
  }

  get studyRoot(): string {
    return path.join(this.publishRoot, 'studies', STUDY_SLUG);
  }

  /** One real study release of the clone's HEAD; keeps the generator's tree in its own work dir. */
  release(): { status: number; output: string; workDir: string } {
    this.releases += 1;
    const workDir = path.join(this.work, `release-${this.releases}`);
    const res = spawnSync(
      path.join(this.clone, 'scripts', 'validation', 'statement', 'release.sh'),
      ['--docs-root', this.docsRoot, '--publish-root', this.publishRoot, '--study', path.join(this.clone, STUDY_FILE),
        '--work-dir', workDir],
      { cwd: this.clone, env: { ...process.env, PYTHON: this.python }, encoding: 'utf-8', timeout: 400_000 },
    );
    return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}`, workDir };
  }

  statementMethods(workDir: string): StatementMethod[] {
    const statement = JSON.parse(fs.readFileSync(path.join(workDir, 'statement', 'internal', 'statement.json'), 'utf-8'));
    return statement.methods as StatementMethod[];
  }

  digests(version: string): Record<string, string> {
    return Object.fromEntries(RELEASE_FILES.map((name) => [
      name, createHash('sha256').update(fs.readFileSync(path.join(this.studyRoot, version, name))).digest('hex'),
    ]));
  }

  /** Serve `/r-equivalence/**` from the publish root under the front's origin. */
  async serve(page: Page): Promise<void> {
    await page.route('**/r-equivalence/**', async (route) => {
      const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/r-equivalence\//, '');
      const file = path.resolve(this.publishRoot, rel);
      if (!file.startsWith(this.publishRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return route.fulfill({ status: 404, body: 'not published' });
      }
      return route.fulfill({ path: file });
    });
  }

  dispose(): void {
    fs.rmSync(this.work, { recursive: true, force: true });
  }

  private run(cmd: string, args: string[]): string {
    const res = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 120_000 });
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
    return res.stdout;
  }
}

test.describe('AXI-2070 — Help article names the study-view address (FR12)', { tag: ['@SI-037'] }, () => {
  test('FR12: the Help article gives the study address scheme and links no study page that does not exist', async ({ page, request }) => {
    await page.goto(ARTICLE_PATH);
    const article = page.locator('article, main').filter({ has: page.getByRole('heading', { name: ARTICLE_TITLE, level: 1 }) }).last();
    await expect(article.getByRole('heading', { name: ARTICLE_TITLE, level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(article).toContainText('/r-equivalence/studies/<study>/<build-sha>/external.html');
    await expect(article).toContainText(STUDY_SLUG);
    const hrefs = await article.locator('a[href*="/r-equivalence/studies/"]').evaluateAll((links) =>
      links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.ok(), `GET ${href}`).toBeTruthy();
      expect(await res.text(), `${href} is a published study statement`).toContain('Method R-Equivalence Statement — ');
    }
  });
});

test.describe('AXI-2070 — the Microbiote study view, released by the real release command', { tag: ['@SI-051', '@SI-037'] }, () => {
  test.describe.configure({ mode: 'serial' });

  let fixture: StudyReleaseFixture;
  let sha: string;
  let first: { status: number; output: string; workDir: string };
  let methods: StatementMethod[];
  let bytesBefore: Record<string, string>;
  let republish: { status: number; output: string };

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    fixture = new StudyReleaseFixture(requiredEnv('AXIOME_BIO_COMPUTE_DIR'), requiredEnv('AXIOME_DOCS_ROOT'));
    fixture.prepare();
    sha = fixture.sha;
    first = fixture.release();
    if (first.status !== 0) throw new Error(`release.sh --study exited ${first.status}:\n${first.output}`);
    methods = fixture.statementMethods(first.workDir);
    bytesBefore = fixture.digests(sha);
    republish = fixture.release();
  });

  test.afterAll(() => fixture?.dispose());

  test.beforeEach(async ({ page }) => {
    await fixture.serve(page);
  });

  test('FR12: the study page lists the six declared methods, in order, each as the evidence records it', async ({ page }) => {
    expect(methods.map((m) => m.method_id)).toEqual(MICROBIOTE_METHODS);
    await page.goto(`/r-equivalence/studies/${STUDY_SLUG}/${sha}/external.html`);
    await expect(page).toHaveTitle(STUDY_TITLE);
    const body = page.locator('body');
    await expect(body).toContainText(`study ${STUDY_NAME} (${STUDY_SLUG}): 6 declared method(s)`);
    await expect(body).toContainText(`bio-compute build ${sha}`);
    const ids = await page.locator('h2[id]').evaluateAll((hs) => hs.map((h) => h.id));
    expect(ids).toEqual(MICROBIOTE_METHODS.map(anchor));
    for (const method of methods) {
      const section = page.locator(`h2[id="${anchor(method.method_id)}"] + table`);
      await expect(page.locator(`h2[id="${anchor(method.method_id)}"]`)).toContainText(method.method_id);
      const agreement = method.has_r_comparison
        ? `${method.fixtures_agreeing} of ${method.fixtures_total} fixtures within tolerance.`
        : NO_COMPARISON;
      await expect(section.locator('tr', { hasText: 'Agreement' }), method.method_id).toContainText(agreement);
      await expect(section.locator('tr', { hasText: 'Verdict' }), method.method_id).toContainText(method.verdict);
    }
    // D1 in the served page: no internal-only material.
    await expect(body).not.toContainText('Tolerances');
    for (const id of MICROBIOTE_METHODS) await expect(body).not.toContainText(`${id}/`);
    await expect(page.locator('img')).toHaveCount(0);
  });

  test('FR12/FR11: the study release is write-once at its own address, with its own latest and index', async ({ page }) => {
    expect(republish.status, republish.output).toBe(2);
    expect(republish.output).toContain('already published');
    expect(fixture.digests(sha)).toEqual(bytesBefore);

    await page.goto(`/r-equivalence/studies/${STUDY_SLUG}/latest/external.html`);
    await expect(page).toHaveTitle(STUDY_TITLE);
    await expect(page.locator('body')).toContainText(`bio-compute build ${sha}`);
    // Fetched from the page (page.request would bypass page.route).
    const index = await page.evaluate(async (slug) => (await fetch(`/r-equivalence/studies/${slug}/index.json`)).json(), STUDY_SLUG);
    expect(index.latest).toBe(sha);
    expect(Object.keys(index.versions[sha].methods)).toEqual(expect.arrayContaining(MICROBIOTE_METHODS));
    // A study release never publishes (or occupies) the full statement's address.
    const fullStatus = await page.evaluate(async (v) => (await fetch(`/r-equivalence/${v}/external.html`)).status, sha);
    expect(fullStatus).toBe(404);
  });

  test('AC6: every one of the six Microbiote methods has an R comparison', async ({ page }) => {
    await page.goto(`/r-equivalence/studies/${STUDY_SLUG}/${sha}/external.html`);
    for (const id of MICROBIOTE_METHODS) {
      const section = page.locator(`h2[id="${anchor(id)}"] + table`);
      await expect(section.locator('tr', { hasText: 'Agreement' }), id).not.toContainText(NO_COMPARISON);
      await expect(section.locator('tr', { hasText: 'Agreement' }), id).toContainText(/\d+ of \d+ fixtures within tolerance\./);
    }
  });
});
