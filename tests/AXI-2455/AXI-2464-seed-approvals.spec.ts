import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AXI-2464 (epic AXI-2455 — TPL FR59, FR40, EC27, AC27; owner ruling 5): the audited seed-approval
 * script `axiome-back/scripts/approve_seeded_template_versions.sql` records the owner as approver of
 * the boot-seeded system versions (T1/T3/T4/T5 0.3), with one append-only audit row each, and a
 * re-run writes nothing.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2464
 * (A1–A3; M1 is a doc review). No API or UI exposes a version's approver, so the spec reads and runs
 * the script on the stack's Postgres container through psql (`E2E_PG_CONTAINER`, default
 * `axiome-localhost`; the `tests/AXI-1640/harness/seed.ts` precedent).
 *
 * The script is idempotent, so A1 applies it first: on a stack where it was already applied it
 * writes nothing. It writes to append-only tables, so the owner must be the real owner account:
 * `E2E_SEED_APPROVAL_OWNER_EMAIL` (default `admin@axiome.local`, the demo's platform admin).
 *
 * Run: `E2E_SEED_APPROVAL_SCRIPT=<path to the script> npx playwright test tests/AXI-2455/AXI-2464-* --project=chromium --no-deps`
 * (default script path: the sibling `axiome-back` checkout). `--no-deps`: the spec uses no browser and no login.
 */

const CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';
const PG_USER = process.env.E2E_PG_USER ?? 'axiome';
const PG_DB = process.env.E2E_PG_DB ?? 'axiome';
const OWNER_EMAIL = process.env.E2E_SEED_APPROVAL_OWNER_EMAIL ?? 'admin@axiome.local';
const SCRIPT =
  process.env.E2E_SEED_APPROVAL_SCRIPT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../axiome-back/scripts/approve_seeded_template_versions.sql');
const TARGETS = ['T1', 'T3', 'T4', 'T5'].map((templateId) => ({ templateId, templateVersion: '0.3' }));

/** The rule kernel's canonical JSON (`rule-runs/kernel/canonical-json.ts`), restated as the oracle. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .filter((key) => obj[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + stableStringify(obj[key]))
      .join(',') +
    '}'
  );
}

/** `analysisTemplateVersionCanonicalContent`: `guidedOnly` always, every other field only when present.
 * Only the TOP-level fields are dropped when null; a null nested inside a field is content. */
function canonicalContentOf(columns: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = { guidedOnly: columns.guidedOnly };
  for (const key of ['recipeKey', 'parameterSchema', 'signature', 'declaredOutputs', 'composition'])
    if (columns[key] !== null && columns[key] !== undefined) content[key] = columns[key];
  return content;
}

function rows(sql: string): string[] {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { stdio: 'pipe' },
  ).toString();
  return out.split('\n').filter((line) => line.length > 0);
}

function json<T>(sql: string): T {
  const [line] = rows(sql);
  return JSON.parse(line) as T;
}

function runScript(vars: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-v', 'ON_ERROR_STOP=1', '-At'];
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${value}`);
  const result = spawnSync('docker', args, { input: fs.readFileSync(SCRIPT, 'utf8'), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The ledger rows on the target versions only: other specs on the shared demo write template
 * approvals and audit rows of their own at any time, so a whole-table count would be flaky. */
function ledgerCounts(): { approvals: number; audits: number } {
  const targets = TARGETS.map((t) => `('${t.templateId}', '${t.templateVersion}')`).join(', ');
  const ids = `SELECT v.id FROM organization_svc.analysis_templates t
      JOIN organization_svc.analysis_template_versions v ON v.analysis_template_id = t.id
     WHERE (t.template_id, v.template_version) IN (${targets})`;
  return json(`SELECT json_build_object(
      'approvals', (SELECT count(*) FROM organization_svc.content_approval_records
                     WHERE content_kind = 'analysis_template' AND content_id IN (${ids})),
      'audits', (SELECT count(*) FROM organization_svc.analysis_template_audit_logs
                  WHERE analysis_template_version_id IN (${ids})))`);
}

interface VersionFacts {
  versionId: string;
  contentHash: string;
  /** The content columns as stored; null = absent (SQL NULL or JSON null). */
  columns: Record<string, unknown>;
  approvals: { id: string; approverId: string; contentHash: string; approvedBytes: string; authoredBy: string; scope: string; locale: string }[];
  audits: { actorId: string; scope: string; organizationId: string | null; after: { approval?: { recordId?: string } } }[];
}

function versionFacts(templateId: string, templateVersion: string, ownerId: string): VersionFacts {
  return json(`SELECT json_build_object(
      'versionId', v.id,
      'contentHash', v.content_hash,
      'columns', json_build_object('guidedOnly', v.guided_only, 'recipeKey', v.recipe_key,
                  'parameterSchema', v.parameter_schema, 'signature', v.signature,
                  'declaredOutputs', v.declared_outputs, 'composition', v.composition),
      'approvals', coalesce((SELECT json_agg(json_build_object('id', r.id, 'approverId', r.approver_id,
                  'contentHash', r.content_hash, 'approvedBytes', r.approved_bytes, 'authoredBy', r.authored_by,
                  'scope', r.scope, 'locale', r.locale))
                FROM organization_svc.content_approval_records r
               WHERE r.content_kind = 'analysis_template' AND r.content_id = v.id AND r.approver_id = '${ownerId}'), '[]'::json),
      'audits', coalesce((SELECT json_agg(json_build_object('actorId', l.actor_id, 'scope', l.scope,
                  'organizationId', l.organization_id, 'after', l.after))
                FROM organization_svc.analysis_template_audit_logs l
               WHERE l.analysis_template_version_id = v.id AND l.action = 'version_published'
                 AND l.actor_id = '${ownerId}'), '[]'::json))
    FROM organization_svc.analysis_templates t
    JOIN organization_svc.analysis_template_versions v ON v.analysis_template_id = t.id
   WHERE t.template_id = '${templateId}' AND v.template_version = '${templateVersion}'`);
}

test.describe.serial('AXI-2464 — audited approval of the boot-seeded template versions (TPL FR59, AC27, EC27)', { tag: ['@SI-069', '@SI-041'] }, () => {
  let ownerId = '';

  test.beforeAll(() => {
    expect(fs.existsSync(SCRIPT), `seed-approval script not found at ${SCRIPT} (set E2E_SEED_APPROVAL_SCRIPT)`).toBe(true);
    const [id] = rows(`SELECT id FROM user_svc.users WHERE lower(email) = lower('${OWNER_EMAIL}')`);
    expect(id, `owner ${OWNER_EMAIL} not on this stack`).toBeTruthy();
    ownerId = id;
  });

  test('AXI-2464.A1 (AC27, FR59, FR40): each seeded 0.3 shows the owner as approver, with one audit row', () => {
    const applied = runScript({ owner_email: OWNER_EMAIL });
    expect(applied.status, applied.stderr).toBe(0);
    for (const { templateId, templateVersion } of TARGETS) {
      const facts = versionFacts(templateId, templateVersion, ownerId);
      const label = `${templateId}@${templateVersion}`;
      expect(facts.approvals, label).toHaveLength(1);
      const [approval] = facts.approvals;
      expect(approval.approverId).not.toBe('system');
      expect(approval).toMatchObject({ contentHash: `sha256:${facts.contentHash}`, authoredBy: 'system', scope: 'system', locale: 'und' });
      expect(createHash('sha256').update(approval.approvedBytes, 'utf8').digest('hex'), label).toBe(facts.contentHash);
      expect(approval.approvedBytes, label).toBe(stableStringify(canonicalContentOf(facts.columns)));
      expect(facts.audits, label).toHaveLength(1);
      expect(facts.audits[0]).toMatchObject({ scope: 'system', organizationId: null });
      expect(facts.audits[0].after.approval?.recordId, label).toBe(approval.id);
    }
  });

  test('AXI-2464.A2 (EC27): a re-run writes nothing', () => {
    const before = ledgerCounts();
    const rerun = runScript({ owner_email: OWNER_EMAIL });
    expect(rerun.status, rerun.stderr).toBe(0);
    const outcome = rerun.stdout.split('\n').filter((line) => /^T\d\|/.test(line));
    expect(outcome.length).toBeGreaterThanOrEqual(TARGETS.length);
    for (const line of outcome) expect(line).toMatch(/\|already\|already$/);
    expect(ledgerCounts()).toEqual(before);
  });

  test('AXI-2464.A3 (FR40): a missing, unknown or non-admin owner is refused and nothing is written', () => {
    const [nonAdmin] = rows(`SELECT email FROM user_svc.users WHERE role::text <> 'ADMIN' AND status::text = 'ACTIVE' ORDER BY created_at LIMIT 1`);
    expect(nonAdmin, 'no non-admin user on this stack').toBeTruthy();
    const before = ledgerCounts();
    const attempts: Record<string, string>[] = [{}, { owner_email: 'nobody-axi2464@example.invalid' }, { owner_email: nonAdmin }];
    for (const vars of attempts) {
      const refused = runScript(vars);
      expect(refused.status, JSON.stringify(vars)).toBe(3);
      expect(refused.stderr).toMatch(/AXI-2464: owner_email/);
    }
    expect(ledgerCounts()).toEqual(before);
  });
});
