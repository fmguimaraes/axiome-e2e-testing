import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  BACK_ROOT,
  CODEOWNERS,
  DOCTRINE_DOC,
  DOCTRINE_TS,
  HOOK_DIFF_SCRIPT,
  HOOK_SCRIPT,
  RULINGS_JSON,
  missingRepos,
} from './harness/sibling-repos';

/**
 * AXI-1688 — Doctrine, rulings and prompt discipline (epic AXI-1687, area A).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`
 * §4.1–4.4, §5.1–5.3.
 *
 * HARD RULE FOR THIS FILE (NFR1, zero LLM spend): no scenario opens the planner,
 * calls the API, or reaches any endpoint that could touch the platform's Anthropic
 * key. The story has no browser surface; its observable facts are FILES (the
 * doctrine's owning doc, its code carrier, the rulings JSON, CODEOWNERS), two
 * SUBPROCESSES (the PreToolUse hook script driven by synthetic payloads, and the
 * PostToolUse/Stop diff guard driven against a throwaway git repo) and the offline
 * Jest drift suites run headless from the axiome-back checkout. `E2E_LIVE_LLM` is
 * never read here.
 *
 * The rulings file is asserted by INVARIANT only — never by its present values — so
 * the owner's first real ruling PR leaves this spec green (review bounce #1, B1).
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

function readLog(projectDir: string): string[] {
  const log = path.join(projectDir, 'status', 'gate-rulings-hook.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/** Drive the PreToolUse hook exactly as Claude Code does: JSON on stdin, decision by exit code. */
function runHook(payload: unknown, projectDir: string): HookRun {
  const r = spawnSync('python3', [HOOK_SCRIPT as string], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, GATE_RULINGS_HOOK_OFF: '' },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, logLines: readLog(projectDir) };
}

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });

/** Drive the PostToolUse/Stop diff guard against an explicit checkout list, with the payload Claude Code would send. */
function runDiffGuard(roots: string[], projectDir: string, payload: unknown = {}): HookRun {
  const r = spawnSync('python3', [HOOK_DIFF_SCRIPT as string], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, GATE_RULINGS_HOOK_OFF: '', GATE_RULINGS_DIFF_ROOTS: roots.join(':') },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, logLines: readLog(projectDir) };
}

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' } });

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test.describe('AXI-1688 §4.1 — doctrine carriers agree (AC1, AC6, AC7)', { tag: ['@SI-002', '@SI-045'] }, () => {
  test('the owning doc quote, the contracts constant and the offline drift suites agree — zero LLM calls', async () => {
    requireRepos(['back', 'docs']);
    test.setTimeout(6 * 60_000); // ts-jest cold compile of four suites
    expect(DOCTRINE_DOC, 'exactly one owning doc (BACKLOG-/IN-PROGRESS-/bare prefix) under "05 - product/features"').toBeDefined();

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
    expect(summary).not.toMatch(/Tests:.*\b(failed|skipped)\b/);
  });
});

test.describe('AXI-1688 §4.2 — the rulings file carries the grain rulings as rows, well-formed in either status (AC4, AC2)', { tag: ['@SI-045'] }, () => {
  test('decision ids contiguous from 1, every row well-formed in either status, four grain tags, well-formed bank rows, no row for an impossible bank id — invariants only', async () => {
    requireRepos(['back']);
    const file = JSON.parse(readFileSync(RULINGS_JSON as string, 'utf8'));

    expect(file.version).toBe(1);
    expect(typeof file.sessionHeld).toBe('boolean');
    const ids: number[] = [...file.decisions.map((d: { id: number }) => d.id)].sort((a, b) => a - b);
    const maxId = ids[ids.length - 1];
    expect(maxId).toBeGreaterThan(0);
    expect(ids).toEqual(Array.from({ length: maxId }, (_, i) => i + 1)); // contiguous from 1, length = max id — never a literal
    for (const d of file.decisions) {
      expect(['assumed_default', 'ruled'], `decision ${d.id} status`).toContain(d.status);
      expect(d.story, `decision ${d.id} story`).toMatch(/^AXI-\d+$/);
      expect(d.date, `decision ${d.id} date`).toMatch(ISO_DATE);
      expect(typeof d.default, `decision ${d.id} default`).toBe('string');
      if (d.status === 'assumed_default') {
        expect(d.ruling, `decision ${d.id} ruling`).toBeNull();
        expect(d.ruledBy, `decision ${d.id} ruledBy`).toBeNull();
      } else {
        expect(d.ruling, `decision ${d.id} ruling`).not.toBeNull();
        expect(d.ruledBy, `decision ${d.id} ruledBy`).not.toBeNull();
      }
    }
    const grains = Object.fromEntries(
      file.decisions.filter((d: { grain?: string }) => d.grain).map((d: { id: number; grain: string }) => [d.id, d.grain]),
    );
    expect(grains).toEqual({ 9: 'unit', 13: 'timepoint', 14: 'representation_level', 15: 'referent_population', 20: 'referent_population' });

    const bankIds: string[] = file.bank.map((b: { bankId: string }) => b.bankId);
    expect(new Set(bankIds).size).toBe(bankIds.length);
    for (const b of file.bank) {
      expect(b.ruling, `bank ${b.bankId} ruling`).toMatch(/\S/);
      expect(b.ruledBy, `bank ${b.bankId} ruledBy`).toMatch(/\S/);
      expect(b.date, `bank ${b.bankId} date`).toMatch(ISO_DATE);
    }
    expect(file.bank.find((b: { bankId: string }) => b.bankId === '__no-such-bank-row__')).toBeUndefined(); // → `unsigned` in the gate
  });
});

test.describe('AXI-1688 §4.3 / §5.1 — the PreToolUse hook is the signature procedure (AC3, AC127)', { tag: ['@SI-041'] }, () => {
  test('Edit/Write on a protected basename — or a symlink resolving to one — exits 2 with a reason and a log line; an unrelated file passes', async () => {
    requireRepos(['global']);
    const projectDir = mkdtempSync(path.join(tmpdir(), 'axi-1688-hook-'));

    const edit = runHook({ tool_name: 'Edit', tool_input: { file_path: '/repo/x/grados-gate-rulings.json' } }, projectDir);
    expect(edit.status).toBe(2);
    expect(edit.stderr).toMatch(/OWNER-SIGNED gate input/);
    expect(edit.stderr).toMatch(/scores it `unsigned`/);

    const write = runHook({ tool_name: 'Write', tool_input: { file_path: '/repo/grados-gate-truth.json' } }, projectDir);
    expect(write.status).toBe(2);

    // A symlink whose own basename is innocent but which resolves to a protected file.
    const target = path.join(projectDir, 'fixtures', 'grados-gate-rulings.json');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '{}');
    const link = path.join(projectDir, 'innocent-name.json');
    symlinkSync(target, link);
    const viaLink = runHook({ tool_name: 'Edit', tool_input: { file_path: link } }, projectDir);
    expect(viaLink.status).toBe(2);

    const other = runHook({ tool_name: 'Edit', tool_input: { file_path: '/repo/x/hints.ts' } }, projectDir);
    expect(other.status).toBe(0);
    expect(other.stderr).toBe('');

    const decisions = other.logLines.map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.decision)).toEqual(['blocked', 'blocked', 'blocked']); // the unrelated edit is not logged
    expect(decisions[0]).toMatchObject({ hook: 'protect-gate-rulings', tool: 'Edit', target: '/repo/x/grados-gate-rulings.json' });
    expect(decisions[2].target).toBe(target); // logged as the RESOLVED path, not the symlink
  });

  test('§5.1 — every Bash write indicator on a protected basename, and an opaque glob/variable target, is blocked; a read (cat) is allowed and logged as such', async () => {
    requireRepos(['global']);
    const projectDir = mkdtempSync(path.join(tmpdir(), 'axi-1688-hook-bash-'));

    const blocked = [
      "sed -i 's/null/\"x\"/' apps/x/grados-gate-rulings.json",
      'echo {} > apps/x/grados-gate-truth.json',
      "perl -pi -e 's/null/1/' apps/x/grados-gate-truth.json",
      `python3 -c "open('apps/x/grados-gate-rulings.json','w').write('{}')"`,
      'git checkout -- apps/x/grados-gate-rulings.json',
      'git stash pop # restores apps/x/grados-gate-rulings.json',
      'cp new.json apps/x/__fixtures__/grados-gate-*.json', // glob on the protected stem
      'cp new.json apps/x/__fixtures__/${f}', // shell variable under the fixtures dir
    ];
    for (const command of blocked) {
      const r = runHook(bash(command), projectDir);
      expect(r.status, command).toBe(2);
      expect(r.stderr, command).toMatch(/OWNER-SIGNED gate input/);
    }

    const cat = runHook(bash('cat apps/x/grados-gate-rulings.json | jq .decisions'), projectDir);
    expect(cat.status).toBe(0);
    expect(cat.stderr).toBe('');

    const decisions = cat.logLines.map((l) => JSON.parse(l).decision);
    expect(decisions).toEqual([...blocked.map(() => 'blocked'), 'allowed-read']);
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
  test('two reads hash identically; one appended byte hashes differently', async () => {
    requireRepos(['back']);
    const bytes = readFileSync(RULINGS_JSON as string);
    expect(sha256(bytes)).toBe(sha256(readFileSync(RULINGS_JSON as string)));
    const appended = Buffer.concat([bytes, Buffer.from('\n')]);
    expect(appended.equals(bytes)).toBe(false);
    expect(sha256(appended)).not.toBe(sha256(bytes));
  });
});

test.describe('AXI-1688 §5.3 — the diff guard catches a protected-file change no indicator saw (AC3, AC127)', { tag: ['@SI-041'] }, () => {
  test('clean tree exits 0; a modified protected file exits 2 naming repo and file; an untracked copy exits 2 too; a re-invoked Stop (stop_hook_active) exits 0 — block once', async () => {
    requireRepos(['global']);
    const projectDir = mkdtempSync(path.join(tmpdir(), 'axi-1688-diff-'));
    const repo = path.join(projectDir, 'repo');
    mkdirSync(path.join(repo, 'x', '__fixtures__'), { recursive: true });
    const rulings = path.join(repo, 'x', '__fixtures__', 'grados-gate-rulings.json');
    writeFileSync(rulings, '{"version":1}\n');
    expect(git(repo, 'init', '-q').status).toBe(0);
    expect(git(repo, 'add', '.').status).toBe(0);
    expect(git(repo, 'commit', '-q', '-m', 'seed').status).toBe(0);

    expect(runDiffGuard([repo], projectDir).status).toBe(0);

    writeFileSync(rulings, '{"version":1,"sessionHeld":true}\n'); // a plain write — no tool, no indicator
    const modified = runDiffGuard([repo], projectDir);
    expect(modified.status).toBe(2);
    expect(modified.stderr).toMatch(/OWNER-SIGNED gate input has changed/);
    expect(modified.stderr).toContain('x/__fixtures__/grados-gate-rulings.json');

    expect(git(repo, 'checkout', '--', '.').status).toBe(0);
    expect(runDiffGuard([repo], projectDir).status).toBe(0);

    writeFileSync(path.join(repo, 'x', 'grados-gate-truth.json'), '{}\n'); // untracked copy
    const untracked = runDiffGuard([repo], projectDir);
    expect(untracked.status).toBe(2);
    expect(untracked.stderr).toContain('x/grados-gate-truth.json');

    const decisions = untracked.logLines.map((l) => JSON.parse(l));
    expect(decisions.map((d) => d.hook)).toEqual(['guard-gate-rulings-diff', 'guard-gate-rulings-diff']);

    // Same dirty tree, but Claude Code re-invoking Stop after a block: exit 0 so the session can end.
    const reinvoked = runDiffGuard([repo], projectDir, { hook_event_name: 'Stop', stop_hook_active: true });
    expect(reinvoked.status).toBe(0);
    expect(reinvoked.stderr).toBe('');
    expect(readLog(projectDir)).toHaveLength(2); // nothing new logged
    // A PostToolUse payload never carries the flag → still blocked.
    expect(runDiffGuard([repo], projectDir, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }).status).toBe(2);
  });
});
