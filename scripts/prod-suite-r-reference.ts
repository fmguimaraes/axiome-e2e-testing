import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES_DIR } from '../tests/AXI-2309/harness/prod-suite/fixtures';
import {
  currentInputHashes,
  PAUL_PROBES_FILE,
  PAUL_R_REFERENCE_FILE,
  PAUL_R_SCRIPT_FILE,
  PAUL_REFERENCE_DIR,
  type RReference,
} from '../tests/AXI-2309/harness/prod-suite/paul-reference';

/**
 * AXI-2319 (FR31, SI-053) — regenerate `paul-r-reference.json`, the
 * independent R computation every Paul-method check is compared to.
 *
 * Runs `paul-r-reference.R` in a pinned R image (R 4.4.2, packages from the
 * Posit Package Manager snapshot of 2024-10-20: FSA 0.9.5, ppcor 1.1 — the
 * versions the bio-compute parity fixtures were generated with), the fixture
 * directory mounted READ-ONLY, then stamps the output with the image, the R and
 * package versions and the sha256 of every input. The suite refuses a stale
 * stamp (`assertReferenceFresh`). Needs Docker; never run by CI or the daily
 * suite — the committed JSON is what they read.
 *
 *   npx tsx scripts/prod-suite-r-reference.ts
 */

export const R_IMAGE = 'rocker/r-ver:4.4.2';
export const R_REPO_SNAPSHOT = 'https://p3m.dev/cran/__linux__/noble/2024-10-20';
export const PINNED_PACKAGES: Readonly<Record<string, string>> = { FSA: '0.9.5', ppcor: '1.1' };

function runR(): Omit<RReference, 'generator'> & { meta: { rVersion: string; packages: Record<string, string> } } {
  const install = `options(repos = c(CRAN = "${R_REPO_SNAPSHOT}")); install.packages(c("FSA", "ppcor", "jsonlite"), quiet = TRUE)`;
  const script = `/work/paul-reference/${PAUL_R_SCRIPT_FILE}`;
  const cmd = `Rscript -e '${install}' >/dev/null 2>&1 && Rscript ${script} /work/paul-reference/${PAUL_PROBES_FILE} /work`;
  const out = execFileSync('docker', ['run', '--rm', '-v', `${FIXTURES_DIR}:/work:ro`, R_IMAGE, 'bash', '-c', cmd], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out);
}

function main(): void {
  const result = runR();
  for (const [pkg, version] of Object.entries(PINNED_PACKAGES)) {
    if (result.meta.packages[pkg] !== version) {
      throw new Error(`R package ${pkg} is ${result.meta.packages[pkg]}, pinned ${version} — the snapshot drifted`);
    }
  }
  const reference: RReference = {
    generator: {
      image: R_IMAGE,
      rVersion: result.meta.rVersion,
      packages: result.meta.packages,
      ...currentInputHashes(),
    },
    probes: result.probes,
  };
  const file = path.join(PAUL_REFERENCE_DIR, PAUL_R_REFERENCE_FILE);
  writeFileSync(file, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${reference.probes.length} probes, ${reference.generator.rVersion})`);
}

try {
  main();
} catch (err) {
  console.error(`prod-suite-r-reference: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
