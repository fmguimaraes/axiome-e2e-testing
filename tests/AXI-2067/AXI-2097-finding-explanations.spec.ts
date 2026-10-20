import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AXI-2097 (epic AXI-2067 — FR16, AC9, FR4; EC1, EC2; D7.1, D7.2). Scenario doc:
 * `manual-e2e/AXI-2067-Method-R-Equivalence-Statement.md` §AXI-2097, scenarios 1-3.
 *
 * Nothing here reads a hand-made release. `beforeAll` runs the REAL one-command
 * release for the FULL statement (`axiome-bio-compute/scripts/validation/statement/release.sh`:
 * real parity harness → real `generate` → real `publish`) on a throwaway local clone of
 * the bio-compute checkout, over the REAL docs root, the clone's REAL fixture corpus and
 * its REAL known-findings ledger. The browser then loads the published bytes at
 * `/r-equivalence/<sha>/external.html` under the front's origin; `page.route` serves
 * `/r-equivalence/**` from that publish root (the AXI-2071/AXI-2070 stand-in for the
 * front's static `public/` serving, so the page under test is exactly this run's output).
 *
 * What the page must say is read from the evidence of the SAME run, never typed here:
 * the clone's `tests/validation/parity/known_findings.json` (each entry's `category` and
 * `public_explanation`) and the generator's internal `statement.json` (kept with
 * `--work-dir`). The three category labels and the two R function names are the
 * contract this story ships (FR16's categories; FR4's per-field references from the
 * Dunn fixtures' `field_sources`), so they are asserted as such.
 *
 * Required environment (the spec FAILS, never skips, when one is missing):
 *   AXIOME_BIO_COMPUTE_DIR    an axiome-bio-compute checkout; its COMMITTED HEAD is used
 *   AXIOME_DOCS_ROOT          an axiome-docs checkout (the real MSRs, Hazard Table, VMP, Feature doc)
 *   AXIOME_BIO_COMPUTE_PYTHON interpreter with bio-compute's dependencies (default: python3)
 *
 * @SI-051 @SI-050 @SI-037
 */

const MAXSTAT = 'stats.cutoff_maxstat';
const DUNN = 'stats.dunn_posthoc';
const FINDINGS_HEADING = 'Open findings';
const CATEGORY_LABELS: Record<string, string> = {
  reference_departure: 'R reference departure',
  convention_difference: 'convention difference',
  axiome_discrepancy: 'Axiome discrepancy under investigation',
};
const FINDING_LINE = new RegExp(
  `^(\\d+) open finding\\(s\\) — (${Object.values(CATEGORY_LABELS).join('|')}): (\\S.*)$`,
);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for the AXI-2097 release fixture (see the spec header)`);
  return value;
}

/** Same rule as the generator's `exporters.method_anchor`. */
function anchor(methodId: string): string {
  return methodId.replace(/\./g, '-');
}

interface LedgerEntry {
  fixture_id: string;
  owner: string;
  reason: string;
  category: string;
  public_explanation: string;
}

interface StatementMethod {
  method_id: string;
  verdict: string;
  fixtures_total: number;
  fixtures_agreeing: number;
  findings: { fixture_id: string; category: string }[];
  field_references: { function: string; fields: string[] }[];
}

class FullReleaseFixture {
  readonly work = fs.mkdtempSync(path.join(os.tmpdir(), 'axi2097-e2e-'));
  readonly clone = path.join(this.work, 'bio-compute');
  readonly publishRoot = path.join(this.work, 'r-equivalence');
  readonly workDir = path.join(this.work, 'release');
  readonly python = process.env.AXIOME_BIO_COMPUTE_PYTHON?.trim() || 'python3';

  constructor(private readonly bioComputeDir: string, private readonly docsRoot: string) {}

  prepare(): void {
    this.run('git', ['clone', '--quiet', '--local', this.bioComputeDir, this.clone]);
  }

  get sha(): string {
    return this.run('git', ['-C', this.clone, 'rev-parse', 'HEAD']).trim();
  }

  /** One real release of the full statement for the clone's HEAD. */
  release(): { status: number; output: string } {
    const res = spawnSync(
      path.join(this.clone, 'scripts', 'validation', 'statement', 'release.sh'),
      ['--docs-root', this.docsRoot, '--publish-root', this.publishRoot, '--work-dir', this.workDir],
      { cwd: this.clone, env: { ...process.env, PYTHON: this.python }, encoding: 'utf-8', timeout: 800_000 },
    );
    return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}` };
  }

  ledger(): LedgerEntry[] {
    const file = path.join(this.clone, 'tests', 'validation', 'parity', 'known_findings.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).known_findings as LedgerEntry[];
  }

  statementMethods(): StatementMethod[] {
    const file = path.join(this.workDir, 'statement', 'internal', 'statement.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8')).methods as StatementMethod[];
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

/** The rows of a method's table and the items of its "Open findings" list. */
function section(page: Page, methodId: string) {
  const h2 = `h2[id="${anchor(methodId)}"]`;
  return {
    heading: page.locator(h2),
    row: (label: string) => page.locator(`${h2} + table tr`, { hasText: label }),
    findingsHeading: page.locator(`${h2} + table + h3`, { hasText: FINDINGS_HEADING }),
    findings: page.locator(`${h2} + table + h3 + ul > li`),
  };
}

test.describe('AXI-2097 — open findings carry a category and an explanation (full statement, real release)', { tag: ['@SI-051', '@SI-050', '@SI-037'] }, () => {
  test.describe.configure({ mode: 'serial' });

  let fixture: FullReleaseFixture;
  let sha: string;
  let ledger: LedgerEntry[];
  let methods: StatementMethod[];

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    fixture = new FullReleaseFixture(requiredEnv('AXIOME_BIO_COMPUTE_DIR'), requiredEnv('AXIOME_DOCS_ROOT'));
    fixture.prepare();
    sha = fixture.sha;
    const release = fixture.release();
    if (release.status !== 0) throw new Error(`release.sh exited ${release.status}:\n${release.output}`);
    ledger = fixture.ledger();
    methods = fixture.statementMethods();
  });

  test.afterAll(() => fixture?.dispose());

  test.beforeEach(async ({ page }) => {
    await fixture.serve(page);
    await page.goto(`/r-equivalence/${sha}/external.html`);
    await expect(page.locator('body')).toContainText(`bio-compute build ${sha}`, { timeout: 30_000 });
  });

  test('AC9/FR16/EC2: maxstat\'s open findings read as a convention difference, with their explanation', async ({ page }) => {
    const entries = ledger.filter((e) => e.fixture_id.startsWith(`${MAXSTAT}/`));
    expect(entries.length, 'maxstat ledger entries').toBe(3);
    expect(new Set(entries.map((e) => e.category))).toEqual(new Set(['convention_difference']));
    const explanation = entries[0].public_explanation;
    expect(entries.every((e) => e.public_explanation === explanation)).toBe(true);

    const maxstat = section(page, MAXSTAT);
    await expect(maxstat.heading).toContainText(MAXSTAT);
    await expect(maxstat.row('Verdict')).toContainText('open_finding');
    await expect(maxstat.findingsHeading).toHaveCount(1);
    await expect(maxstat.findings).toHaveCount(1);
    await expect(maxstat.findings.first()).toHaveText(`3 open finding(s) — convention difference: ${explanation}`);

    // D1 / NFR2 in the served page: no fixture ID, owner key or internal reason.
    const body = page.locator('body');
    for (const entry of entries) {
      await expect(body).not.toContainText(entry.fixture_id);
      await expect(body).not.toContainText(entry.reason);
    }
    await expect(body).not.toContainText(/\bAXI-\d+\b/);
  });

  test('AC9/FR16/EC1: every open finding on the page has a category and an explanation, with the counts kept', async ({ page }) => {
    const withFindings = methods.filter((m) => m.verdict === 'open_finding');
    expect(withFindings.length, 'methods with an open finding').toBeGreaterThan(0);
    for (const method of withFindings) {
      const s = section(page, method.method_id);
      await expect(s.findingsHeading, method.method_id).toHaveCount(1);
      const items = await s.findings.allTextContents();
      expect(items.length, method.method_id).toBeGreaterThan(0);
      let total = 0;
      for (const item of items) {
        const match = FINDING_LINE.exec(item.trim());
        expect(match, `${method.method_id}: "${item}"`).not.toBeNull();
        total += Number(match![1]);
      }
      expect(total, `${method.method_id} finding count`).toBe(method.findings.length);
    }
    // Every ledger explanation shown, under its own category label.
    const body = page.locator('body');
    for (const entry of ledger) {
      await expect(body, entry.fixture_id).toContainText(`${CATEGORY_LABELS[entry.category]}: ${entry.public_explanation}`);
    }
    await expect(body).not.toContainText('under review');
  });

  test('FR4/D7.1: Dunn agrees 5 of 5 and names both R functions it is compared against', async ({ page }) => {
    const dunn = methods.find((m) => m.method_id === DUNN);
    expect(dunn, 'Dunn in statement.json').toBeDefined();
    expect([dunn!.verdict, dunn!.fixtures_agreeing, dunn!.fixtures_total]).toEqual(['agree', 5, 5]);
    expect(dunn!.field_references.map((r) => r.function)).toEqual(['FSA::dunnTest', 'stats::p.adjust']);

    const s = section(page, DUNN);
    await expect(s.row('Verdict')).toContainText('agree');
    await expect(s.row('Agreement')).toContainText('5 of 5 fixtures within tolerance.');
    await expect(s.findingsHeading).toHaveCount(0);
    const byField = s.row('R reference by field');
    await expect(byField).toHaveCount(1);
    for (const ref of dunn!.field_references) {
      await expect(byField).toContainText(`${ref.function}: ${ref.fields.join(', ')}`);
    }
    await expect(byField).toContainText('FSA::dunnTest');
    await expect(byField).toContainText('stats::p.adjust');
  });
});
