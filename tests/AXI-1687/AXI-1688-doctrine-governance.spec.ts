import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  BACK_ROOT,
  CODEOWNERS,
  DOCTRINE_DOC,
  DOCTRINE_TS,
  HOOK_SCRIPT,
  RULINGS_JSON,
  missingRepos,
} from './harness/sibling-repos';

/**
 * AXI-1688 — Doctrine, rulings and prompt discipline (epic AXI-1687, area A).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`
 * §4.1–4.4, §5.1–5.2.
 *
 * HARD RULE FOR THIS FILE (NFR1, zero LLM spend): no scenario opens the planner,
 * calls the API, or reaches any endpoint that could touch the platform's Anthropic
 * key. The story has no browser surface; its observable facts are FILES (the
 * doctrine's owning doc, its code carrier, the rulings JSON, CODEOWNERS), a
 * SUBPROCESS (the PreToolUse hook script driven by synthetic payloads) and the
 * offline Jest drift suites run headless from the axiome-back checkout.
 * `E2E_LIVE_LLM` is never read here.
 */

const DOCTRINE_MARKERS = {
  begin: '<!-- ANSWER_AS_ASKED_DOCTRINE:begin -->',
  end: '<!-- ANSWER_AS_ASKED_DOCTRINE:end -->',
} as const;

const JEST_DRIFT_SUITES = [
  'libs/contracts/src/guided-analysis/answer-as-asked-doctrine.spec.ts',
  'apps/organization-service/src/guided-analysis/plan/compiled-planner.prompt.spec.ts',
  'apps/organization-service/src/guided-analysis/plan/compile/hints.spec.ts',
  'apps/organization-service/src/guided-analysis/plan/compile/gate-rulings.spec.ts',
];

function requireRepos(needed: readonly ('back' | 'docs' | 'global')[]): void {
  const missing = missingRepos(needed);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')} — set AXIOME_*_ROOT`);
}

/** The doc's marked quote, blockquote prefixes stripped, whitespace normalised. */
function doctrineQuotedInDoc(markdown: string): string {
  const start = markdown.indexOf(DOCTRINE_MARKERS.begin);
  const stop = markdown.indexOf(DOCTRINE_MARKERS.end);
  expect(start, 'begin marker present in the owning doc').toBeGreaterThan(-1);
  expect(stop, 'end marker after the begin marker').toBeGreaterThan(start);
  return markdown
    .slice(start + DOCTRINE_MARKERS.begin.length, stop)
    .split('\n')
    .map((l) => l.replace(/^\s*>\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
}

/** The constant's string literal, read off the TS source (the carrier is a single quoted literal). */
function doctrineConstantInSource(source: string): string {
  const m = source.match(/export const ANSWER_AS_ASKED_DOCTRINE =\s*'((?:[^'\\]|\\.)*)';/);
  expect(m, 'ANSWER_AS_ASKED_DOCTRINE is one single-quoted literal').not.toBeNull();
  return (m as RegExpMatchArray)[1].replace(/\\'/g, "'").replace(/\s+/g, ' ').trim();
}

type HookRun = { status: number | null; stderr: string; logLines: string[] };

/** Drive the hook exactly as Claude Code does: JSON on stdin, decision by exit code. */
function runHook(payload: unknown, projectDir: string): HookRun {
  const r = spawnSync('python3', [HOOK_SCRIPT as string], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, GATE_RULINGS_HOOK_OFF: '' },
    encoding: 'utf8',
  });
  const log = path.join(projectDir, 'status', 'gate-rulings-hook.log');
  const logLines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { status: r.status, stderr: r.stderr, logLines };
}

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test.describe('AXI-1688 §4.1 — doctrine carriers agree (AC1, AC6, AC7)', { tag: ['@SI-002', '@SI-045'] }, () => {
  test('the owning doc quote, the contracts constant and the offline drift suites agree — zero LLM calls', async () => {
    requireRepos(['back', 'docs']);
    test.setTimeout(6 * 60_000); // ts-jest cold compile of four suites

    const quoted = doctrineQuotedInDoc(readFileSync(DOCTRINE_DOC as string, 'utf8'));
    const constant = doctrineConstantInSource(readFileSync(DOCTRINE_TS as string, 'utf8'));
    expect(quoted).toBe(constant);
    expect(constant).not.toMatch(/recast/i);
    expect(constant).toMatch(/`none`.*ends the exchange/);

    const jest = spawnSync('npx', ['jest', ...JEST_DRIFT_SUITES, '--silent'], {
      cwd: BACK_ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', E2E_LIVE_LLM: '' },
      timeout: 5 * 60_000,
    });
    const summary = `${jest.stdout}\n${jest.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''); // jest colours its counts
    expect(jest.status, summary.split('\n').filter((l) => /Tests:|Suites:|✕|●/.test(l)).join('\n')).toBe(0);
    expect(summary).toMatch(/Test Suites: 4 passed, 4 total/);
    expect(summary).not.toMatch(/Tests:.*\bfailed\b/);
  });
});

test.describe('AXI-1688 §4.2 — the rulings file carries the grain rulings as rows (AC4, AC2)', { tag: ['@SI-045'] }, () => {
  test('51 assumed-default decisions, four grain tags, an empty bank, and no row for an unknown bank id', async () => {
    requireRepos(['back']);
    const file = JSON.parse(readFileSync(RULINGS_JSON as string, 'utf8'));

    expect(file.version).toBe(1);
    expect(file.sessionHeld).toBe(false);
    expect(file.decisions.map((d: { id: number }) => d.id)).toEqual(Array.from({ length: 51 }, (_, i) => i + 1));
    for (const d of file.decisions) {
      expect(d.status, `decision ${d.id}`).toBe('assumed_default');
      expect(d.ruling, `decision ${d.id}`).toBeNull();
      expect(d.ruledBy, `decision ${d.id}`).toBeNull();
    }
    const grains = Object.fromEntries(
      file.decisions.filter((d: { grain?: string }) => d.grain).map((d: { id: number; grain: string }) => [d.id, d.grain]),
    );
    expect(grains).toEqual({ 9: 'unit', 13: 'timepoint', 14: 'representation_level', 15: 'referent_population', 20: 'referent_population' });
    expect(file.bank).toEqual([]);
    expect(file.bank.find((b: { bankId: string }) => b.bankId === 'Q07')).toBeUndefined(); // → `unsigned` in the gate
  });
});

test.describe('AXI-1688 §4.3 / §5.1 — the PreToolUse hook is the signature procedure (AC3, AC127)', { tag: ['@SI-041'] }, () => {
  test('Edit/Write on a protected basename exits 2 with a reason and a log line; an unrelated file passes', async () => {
    requireRepos(['global']);
    const projectDir = mkdtempSync(path.join(tmpdir(), 'axi-1688-hook-'));

    const edit = runHook({ tool_name: 'Edit', tool_input: { file_path: '/repo/x/grados-gate-rulings.json' } }, projectDir);
    expect(edit.status).toBe(2);
    expect(edit.stderr).toMatch(/OWNER-SIGNED gate input/);
    expect(edit.stderr).toMatch(/scores it `unsigned`/);

    const write = runHook({ tool_name: 'Write', tool_input: { file_path: '/repo/grados-gate-truth.json' } }, projectDir);
    expect(write.status).toBe(2);

    const other = runHook({ tool_name: 'Edit', tool_input: { file_path: '/repo/x/hints.ts' } }, projectDir);
    expect(other.status).toBe(0);
    expect(other.stderr).toBe('');

    const decisions = other.logLines.map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.decision)).toEqual(['blocked', 'blocked']); // the unrelated edit is not logged
    expect(decisions[0]).toMatchObject({ hook: 'protect-gate-rulings', tool: 'Edit', target: '/repo/x/grados-gate-rulings.json' });
  });

  test('§5.1 — a Bash write (sed -i, redirect) on a protected basename is blocked; a read (cat) is allowed and logged as such', async () => {
    requireRepos(['global']);
    const projectDir = mkdtempSync(path.join(tmpdir(), 'axi-1688-hook-bash-'));

    const sed = runHook({ tool_name: 'Bash', tool_input: { command: "sed -i 's/null/\"x\"/' apps/x/grados-gate-rulings.json" } }, projectDir);
    expect(sed.status).toBe(2);
    const redirect = runHook({ tool_name: 'Bash', tool_input: { command: 'echo {} > apps/x/grados-gate-truth.json' } }, projectDir);
    expect(redirect.status).toBe(2);

    const cat = runHook({ tool_name: 'Bash', tool_input: { command: 'cat apps/x/grados-gate-rulings.json | jq .decisions' } }, projectDir);
    expect(cat.status).toBe(0);
    expect(cat.stderr).toBe('');

    const decisions = cat.logLines.map((l) => JSON.parse(l).decision);
    expect(decisions).toEqual(['blocked', 'blocked', 'allowed-read']);
  });
});

test.describe('AXI-1688 §4.4 — CODEOWNERS routes every protected file to the owner (AC3, AC127)', { tag: ['@SI-041'] }, () => {
  test('the four gate inputs each have a CODEOWNERS line naming an owner handle', async () => {
    requireRepos(['back']);
    const text = readFileSync(CODEOWNERS as string, 'utf8');
    for (const name of ['grados-gate-rulings.json', 'grados-gate-truth.json', 'grados-gate-ledger.json', 'grados-golden-intents.ts']) {
      expect(text, name).toMatch(new RegExp(`^\\*\\*/${name.replace('.', '\\.')}\\s+@[A-Za-z0-9-]+`, 'm'));
    }
  });
});

test.describe('AXI-1688 §5.2 — the rulings hash moves only when the file does (EC33)', { tag: ['@SI-045'] }, () => {
  test('two reads hash identically; an edited copy hashes differently', async () => {
    requireRepos(['back']);
    const bytes = readFileSync(RULINGS_JSON as string);
    expect(sha256(bytes)).toBe(sha256(readFileSync(RULINGS_JSON as string)));
    const edited = Buffer.from(bytes.toString('utf8').replace('"sessionHeld": false', '"sessionHeld": true'));
    expect(edited.equals(bytes)).toBe(false);
    expect(sha256(edited)).not.toBe(sha256(bytes));
  });
});
