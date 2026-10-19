import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-2071 (epic AXI-2067 — FR11, FR13, AC5, AC7). Scenario doc:
 * `manual-e2e/AXI-2067-Method-R-Equivalence-Statement.md` §AXI-2071, scenarios 1-4.
 *
 * Nothing here reads a hand-made release. Two kinds of test:
 *
 * 1. The Help article, against the real running front (no stubs): it states the
 *    address scheme, and every `/r-equivalence/…` link it carries opens a real
 *    published statement — the AXI-2071 review B1 defect was a link to a page
 *    only a hand seed made exist.
 *
 * 2. Version addressing (AC5) and the FR13 resolver (AC7), against a publish
 *    root that `beforeAll` builds with the REAL one-command release
 *    (`axiome-bio-compute/scripts/validation/statement/release.sh`: real parity
 *    harness → real `generate` → real `publish`) over a minimal REAL corpus
 *    (the repo's own `MSR-stats.correlation.md` + its recorded fixtures, the
 *    same slice UT-BC-DOC-370 uses). The two versions are two REAL commits of a
 *    throwaway local clone of the bio-compute checkout (HEAD, then an empty
 *    commit on top), because the generator refuses (`stale_results`) a release
 *    named after any commit other than the one the parity harness ran at.
 *    The browser loads those bytes at their version addresses under the
 *    front's origin; `page.route` serves `/r-equivalence/**` from that publish
 *    root, standing in for the front's generic static `public/` serving (no
 *    real release is committed to `axiome-front/public/r-equivalence/` yet —
 *    the first one is published by the lead from bio-compute main).
 *
 * Required environment (the spec FAILS, never skips, when one is missing):
 *   AXIOME_BIO_COMPUTE_DIR    an axiome-bio-compute checkout; its COMMITTED HEAD is used
 *   AXIOME_DOCS_ROOT          an axiome-docs checkout (the real MSR, Hazard Table, VMP, Feature doc)
 *   AXIOME_BIO_COMPUTE_PYTHON interpreter with bio-compute's dependencies (default: python3)
 * Signs in as the `chromium` project's `admin` role (`config/roles.ts`; on the
 * local stack run with E2E_TEST_EMAIL=admin@cro-one.com E2E_TEST_PASSWORD=admin).
 *
 * @SI-037 @SI-051
 */

const ARTICLE_PATH = '/help/governance-and-provenance/r-equivalence-statement';
const ARTICLE_TITLE = 'The Method R-Equivalence Statement';
const METHOD_ID = 'stats.correlation';
const METHOD_ANCHOR = 'stats-correlation';
const STATEMENT_TITLE = 'Method R-Equivalence Statement (external)';
const RELEASE_FILES = ['external.html', 'external.md', 'manifest.json'];
const MV = path.join('04 - architecture', 'qualification', 'method-validation');
const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for the AXI-2071 publish fixture (see the spec header)`);
  return value;
}

/** A fresh user's onboarding tour navigate()s away from any page — skip every tour. */
async function skipTours(api: APIRequestContext): Promise<void> {
  for (const tourId of TOUR_IDS) {
    const res = await api.put(apiUrl('/api/v1/onboarding-state'), {
      data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
    });
    if (!res.ok()) throw new Error(`skip tour ${tourId} -> ${res.status()}: ${await res.text()}`);
  }
}

test.beforeAll(async () => {
  const api = await adminApiContext();
  try {
    await skipTours(api);
  } finally {
    await api.dispose();
  }
});

test.describe('AXI-2071 — Help article for the R-equivalence statement (AC5)', { tag: ['@SI-037'] }, () => {
  test('AC5: the Help article gives the version address scheme and links no page that does not exist', async ({ page, request }) => {
    await page.goto(ARTICLE_PATH);
    const article = page.locator('article, main').filter({ has: page.getByRole('heading', { name: ARTICLE_TITLE, level: 1 }) }).last();
    await expect(article.getByRole('heading', { name: ARTICLE_TITLE, level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(article).toContainText('/r-equivalence/<build-sha>/external.html');
    await expect(article).toContainText('Publishing a new release never replaces or changes an earlier one');

    // Every statement link the article carries must open a REAL published
    // statement. The SPA answers an unknown path with its own index.html, so
    // "200" alone proves nothing: the body must be the generator's document.
    const hrefs = await article.locator('a[href*="/r-equivalence/"]').evaluateAll((links) =>
      links.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''),
    );
    for (const href of hrefs) {
      const res = await request.get(href);
      expect(res.ok(), `GET ${href}`).toBeTruthy();
      const body = await res.text();
      expect(body, `${href} is a published statement`).toContain(STATEMENT_TITLE);
      expect(body, `${href} names its release`).toMatch(/bio-compute build [0-9a-f]{7,64}/);
    }
  });
});

interface Release {
  sha: string;
  bytes: Record<string, string>;
}

class PublishFixture {
  readonly work = fs.mkdtempSync(path.join(os.tmpdir(), 'axi2071-e2e-'));
  readonly clone = path.join(this.work, 'bio-compute');
  readonly docs = path.join(this.work, 'docs');
  readonly fixtures = path.join(this.work, 'fixtures');
  readonly publishRoot = path.join(this.work, 'r-equivalence');
  readonly python = process.env.AXIOME_BIO_COMPUTE_PYTHON?.trim() || 'python3';

  constructor(private readonly bioComputeDir: string, private readonly docsRoot: string) {}

  /** The minimal real corpus: the real stats.correlation MSR + its recorded fixtures, plus the
   *  method-independent Hazard Table, VMP and Feature doc the traceability matrix needs. */
  prepare(): void {
    this.run('git', ['clone', '--quiet', '--local', this.bioComputeDir, this.clone]);
    fs.mkdirSync(path.join(this.docs, MV, 'msr'), { recursive: true });
    fs.copyFileSync(path.join(this.docsRoot, MV, 'msr', `MSR-${METHOD_ID}.md`), path.join(this.docs, MV, 'msr', `MSR-${METHOD_ID}.md`));
    for (const name of ['Hazard-Table.md', 'VMP.md']) {
      fs.copyFileSync(path.join(this.docsRoot, MV, name), path.join(this.docs, MV, name));
    }
    const features = path.join('05 - product', 'features');
    fs.mkdirSync(path.join(this.docs, features), { recursive: true });
    const featureDoc = 'IN-PROGRESS-Bioinformatics-Method-Validation.md';
    fs.copyFileSync(path.join(this.docsRoot, features, featureDoc), path.join(this.docs, features, featureDoc));
    fs.cpSync(path.join(this.clone, 'tests', 'fixtures', 'validation', METHOD_ID), path.join(this.fixtures, METHOD_ID), { recursive: true });
  }

  /** One real release of the clone's current HEAD; returns the CLI's exit status and output. */
  release(): { status: number; output: string } {
    const res = spawnSync(
      path.join(this.clone, 'scripts', 'validation', 'statement', 'release.sh'),
      ['--docs-root', this.docs, '--fixtures-dir', this.fixtures, '--publish-root', this.publishRoot],
      { cwd: this.clone, env: { ...process.env, PYTHON: this.python }, encoding: 'utf-8', timeout: 240_000 },
    );
    return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}` };
  }

  publishHead(): Release {
    const { status, output } = this.release();
    if (status !== 0) throw new Error(`release.sh exited ${status}:\n${output}`);
    const sha = this.run('git', ['-C', this.clone, 'rev-parse', 'HEAD']).trim();
    return { sha, bytes: this.digests(sha) };
  }

  /** A second REAL commit (same tree) so the next release is a distinct, genuine build SHA. */
  commitAgain(): void {
    this.run('git', ['-C', this.clone, '-c', 'user.name=AXI-2071 e2e', '-c', 'user.email=e2e@axiome.local',
      'commit', '--quiet', '--allow-empty', '-m', 'AXI-2071 - e2e: second release of the same tree']);
  }

  resolve(version: string): { version: string; path: string; anchor: string; url: string } | null {
    const out = this.run(this.python, ['-m', 'scripts.validation.statement', 'resolve',
      '--publish-root', this.publishRoot, '--operation-id', METHOD_ID, '--version', version], this.clone);
    return JSON.parse(out);
  }

  digests(version: string): Record<string, string> {
    return Object.fromEntries(RELEASE_FILES.map((name) => [
      name, createHash('sha256').update(fs.readFileSync(path.join(this.publishRoot, version, name))).digest('hex'),
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

  private run(cmd: string, args: string[], cwd?: string): string {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: 120_000 });
    if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}:\n${res.stdout}\n${res.stderr}`);
    return res.stdout;
  }
}

test.describe('AXI-2071 — statements published per bio-compute version by the real release command', { tag: ['@SI-051', '@SI-037'] }, () => {
  test.describe.configure({ mode: 'serial' });

  let fixture: PublishFixture;
  let earlier: Release;
  let later: Release;
  let earlierBytesAfterLaterPublish: Record<string, string>;
  let republish: { status: number; output: string };

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    fixture = new PublishFixture(requiredEnv('AXIOME_BIO_COMPUTE_DIR'), requiredEnv('AXIOME_DOCS_ROOT'));
    fixture.prepare();
    earlier = fixture.publishHead();
    fixture.commitAgain();
    later = fixture.publishHead();
    earlierBytesAfterLaterPublish = fixture.digests(earlier.sha);
    republish = fixture.release();
  });

  test.afterAll(() => fixture?.dispose());

  test.beforeEach(async ({ page }) => {
    await fixture.serve(page);
  });

  test('AC5: a release is published at its own build-SHA address, and latest is the newest', async ({ page }) => {
    expect(later.sha).not.toBe(earlier.sha);
    await page.goto(`/r-equivalence/${later.sha}/external.html`);
    await expect(page).toHaveTitle(STATEMENT_TITLE);
    await expect(page.locator('body')).toContainText(`bio-compute build ${later.sha}`);
    await expect(page.locator(`h2#${METHOD_ANCHOR}`)).toContainText(METHOD_ID);
    // D1 in the served page: no internal-only material.
    await expect(page.locator('body')).not.toContainText('Tolerances');
    await expect(page.locator('body')).not.toContainText(`${METHOD_ID}/`);
    await expect(page.locator('img')).toHaveCount(0);

    await page.goto('/r-equivalence/latest/external.html');
    await expect(page.locator('body')).toContainText(`bio-compute build ${later.sha}`);
    // Fetched from the page (page.request would bypass page.route).
    const index = await page.evaluate(async () => (await fetch('/r-equivalence/index.json')).json());
    expect(index.latest).toBe(later.sha);
    expect(Object.keys(index.versions).sort()).toEqual([earlier.sha, later.sha].sort());
  });

  test('AC5: the earlier release stays reachable and byte-identical after a later one, and is never republished', async ({ page }) => {
    expect(earlierBytesAfterLaterPublish).toEqual(earlier.bytes);
    expect(republish.status, republish.output).toBe(2);
    expect(republish.output).toContain('already published');
    expect(fixture.digests(later.sha)).toEqual(later.bytes);

    await page.goto(`/r-equivalence/${earlier.sha}/external.html`);
    await expect(page.locator('body')).toContainText(`bio-compute build ${earlier.sha}`);
    await expect(page.locator('body')).not.toContainText(`bio-compute build ${later.sha}`);
    await expect(page.locator(`h2#${METHOD_ANCHOR}`)).toBeVisible();
  });

  test('AC7: the FR13 resolver address opens the method section of the right release', async ({ page }) => {
    const address = fixture.resolve(earlier.sha);
    expect(address).not.toBeNull();
    expect(address!.version).toBe(earlier.sha);
    await page.goto(address!.url);
    expect(new URL(page.url()).pathname).toBe(`/r-equivalence/${earlier.sha}/external.html`);
    await expect(page.locator(`[id="${address!.anchor}"]`)).toContainText(METHOD_ID);
    await expect(page.locator('body')).toContainText(`bio-compute build ${earlier.sha}`);

    const latest = fixture.resolve('latest');
    expect(latest!.version).toBe(later.sha);
    expect(fixture.resolve('0'.repeat(40))).toBeNull();
  });
});
