import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { NewModelPreset, PresetFile } from '../../tests/AXI-2630/harness/new-model-preset';
import {
  EXIT_BLOCKED, EXIT_MISMATCH, StopRun, addData, declareFileFields, questionDataStop, type Procedure,
} from '../../tests/AXI-2630/reproduction/procedure';
import { Trace } from '../../tests/AXI-2630/reproduction/trace';

/**
 * UT-REPRO-2665-001 .. UT-REPRO-2665-010 (epic AXI-2630, AXI-2665, FR76, AC57; SI-042). The step of
 * the reproduction that declares each extension field's column, over a recording client. No network.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const PRESET: NewModelPreset = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/handover/mag4-new-model-preset.json'), 'utf8'));
const WIDE = PRESET.files.find((f) => f.key === 'T2') as PresetFile;
const LONG = PRESET.files.find((f) => f.key === 'T1_LONG') as PresetFile;
const URL_T2 = '/api/v1/discovery/datasets/ds-t2/semantic-declaration';

type Answer = { status: number; body: any };
interface Call { actor: string; method: string; url: string; data?: any }

/** The PUT answers with what it received unless a test sets its own answer. */
function world(answers: { get?: Answer; put?: Answer } = {}) {
  const calls: Call[] = [];
  const client = (actor: string) => {
    const on = (method: string) => async (url: string, data?: any): Promise<Answer> => {
      calls.push({ actor, method, url, data });
      if (url.includes('semantic-declaration')) {
        if (method === 'GET') return answers.get ?? { status: 200, body: {} };
        return answers.put ?? { status: 200, body: { record: { revision: 1, declaration: data.declaration }, mintedNewRevision: true } };
      }
      if (url.endsWith('/datasets') && url.includes('/workspaces/')) {
        return { status: 201, body: { dataset: { id: data.originalFilename.includes('tableau2') ? 'ds-t2' : 'ds-t1' }, presignedUrl: 'http://storage.test/put' } };
      }
      if (url.endsWith('/question-data')) return { status: 200, body: { questions: [{ resolution: { kind: 'resolved' } }] } };
      if (/\/datasets\/ds-t[12]$/.test(url)) return { status: 200, body: { latestIngestion: { status: 'ready' } } };
      return { status: 200, body: {} };
    };
    return { label: actor, get: on('GET'), post: on('POST'), put: on('PUT'), patch: on('PATCH') };
  };
  const procedure = {
    actors: { investigator: client('investigator'), provisioner: client('provisioner'), workspaceId: 'ws', organizationId: 'org' },
    trace: new Trace(), preset: PRESET, repoRoot: ROOT, token: 't', projectId: 'p-1', sapId: 's', sapVersionId: 'v', revision: 1,
    fieldIdByName: new Map(), questionIdByKey: new Map(), runIdByKey: new Map(),
  } as unknown as Procedure;
  return { calls, procedure };
}

const sentBody = (calls: Call[]) => calls.find((c) => c.method === 'PUT')?.data;
const refusal = (exitCode: number, pattern: RegExp) => (e: unknown) =>
  e instanceof StopRun && e.exitCode === exitCode && pattern.test(e.message);

test('UT-REPRO-2665-001 the provisioning identity reads the declaration, then sends the nine aliases', async () => {
  const { calls, procedure } = world();

  await declareFileFields(procedure, WIDE, 'ds-t2');

  assert.deepEqual(calls.map((c) => [c.actor, c.method, c.url]), [['provisioner', 'GET', URL_T2], ['provisioner', 'PUT', URL_T2]]);
  const { aliases, scopeRoles } = sentBody(calls).declaration;
  assert.deepEqual(scopeRoles, []);
  assert.equal(aliases.length, 9);
  assert.ok(aliases.every((a: any) => a.term.startsWith('project.p-1.')));
});

test('UT-REPRO-2665-002 an existing declaration keeps its other members and other terms', async () => {
  const other = { term: 'project.another.x', column: 'eosinophils' };
  const bindings = [{ column: 'age', role: 'covariate' }];
  const current = { scopeRoles: [{ kind: 'site', column: 'sexe' }], templateColumnBindings: bindings, aliases: [other] };
  const { calls, procedure } = world({ get: { status: 200, body: { revision: 4, declaration: current } } });

  await declareFileFields(procedure, WIDE, 'ds-t2');

  const { declaration } = sentBody(calls);
  assert.deepEqual(declaration.scopeRoles, current.scopeRoles);
  assert.deepEqual(declaration.templateColumnBindings, bindings);
  assert.deepEqual(declaration.aliases[0], other);
  assert.equal(declaration.aliases.length, 10);
});

test('UT-REPRO-2665-003 a term already declared is replaced, never duplicated', async () => {
  const term = 'project.p-1.cell_count_eosinophils';
  const current = { scopeRoles: [], aliases: [{ term, column: 'igg4_hpf' }] };
  const { calls, procedure } = world({ get: { status: 200, body: { declaration: current } } });

  await declareFileFields(procedure, WIDE, 'ds-t2');

  const held = sentBody(calls).declaration.aliases.filter((a: any) => a.term === term);
  assert.deepEqual(held, [{ term, column: 'eosinophils' }]);
});

test('UT-REPRO-2665-004 a file with no extension field sends nothing', async () => {
  const { calls, procedure } = world();

  await declareFileFields(procedure, LONG, 'ds-t1');

  assert.deepEqual(calls, []);
});

test('UT-REPRO-2665-005 a 403 on the PUT stops the run as blocked and names the permission', async () => {
  const { procedure } = world({ put: { status: 403, body: { message: 'Forbidden' } } });

  await assert.rejects(declareFileFields(procedure, WIDE, 'ds-t2'), refusal(EXIT_BLOCKED, /7 declaration T2.*403.*governs_analysis_parameters/));
});

test('UT-REPRO-2665-006 a 403 on the read stops the run before anything is sent', async () => {
  const { calls, procedure } = world({ get: { status: 403, body: { message: 'This endpoint is not available to the Investigator role' } } });

  await assert.rejects(declareFileFields(procedure, WIDE, 'ds-t2'), refusal(EXIT_BLOCKED, /Investigator/));
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('UT-REPRO-2665-007 a 400 on the PUT stops the run and carries the server refusal', async () => {
  const { procedure } = world({ put: { status: 400, body: { code: 'DECL_COLUMN_UNKNOWN' } } });

  await assert.rejects(declareFileFields(procedure, WIDE, 'ds-t2'), refusal(EXIT_MISMATCH, /400.*DECL_COLUMN_UNKNOWN/));
});

test('UT-REPRO-2665-008 a response that does not hold the aliases stops the run', async () => {
  const { procedure } = world({ put: { status: 200, body: { record: { declaration: { scopeRoles: [] } } } } });

  await assert.rejects(declareFileFields(procedure, WIDE, 'ds-t2'), refusal(EXIT_MISMATCH, /alias project\.p-1\..* held/));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('UT-REPRO-2665-009 step 7 declares after the wide file is ready and before reading question data', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const { calls, procedure } = world();

  await addData(procedure);

  const index = (match: (c: Call) => boolean) => calls.findIndex(match);
  const ready = index((c) => c.method === 'GET' && c.url.endsWith('/datasets/ds-t2'));
  const put = index((c) => c.method === 'PUT' && c.url === URL_T2);
  const data = index((c) => c.url.endsWith('/question-data'));
  assert.ok(ready >= 0 && ready < put && put < data, JSON.stringify({ ready, put, data }));
});

test('UT-REPRO-2665-010 a question still without data after the declaration is a mismatch, not a blocked step', () => {
  const stop = questionDataStop({ questions: [{ questionId: 'q-2', resolution: { kind: 'none', missing: ['f'] } }] });

  assert.equal(stop.exitCode, EXIT_MISMATCH);
  assert.match(stop.message, /7 question data: questions without data.*q-2/);
});
