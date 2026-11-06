import { request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { ensureAuthTokens } from '../../../config/auth';
import { ROLES, type Role } from '../../../config/roles';

/**
 * AXI-2428 (epic AXI-2422 — story C). A thin API client for the composition dry-run routes
 * (`POST /api/v1/analysis-templates/compositions/{validate,compile}`) plus the AXI-2427 fixture
 * composition they are driven with. API-only: no `page`, no storageState. The routes persist
 * nothing, so a run leaves no data behind.
 */

export const ROUTE = 'api/v1/analysis-templates/compositions';
export const PINNED_VERSION = 'axiome-back@bf71900de6+sha256:cf185d347562';

export interface Reply {
  status: number;
  body: any;
  text: string;
}

export interface CompositionApi {
  validate(body: unknown): Promise<Reply>;
  compile(body: unknown): Promise<Reply>;
  dispose(): Promise<void>;
}

async function parse(res: APIResponse): Promise<Reply> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : undefined;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status(), body, text };
}

function client(ctx: APIRequestContext): CompositionApi {
  return {
    validate: async (body) => parse(await ctx.post(apiUrl(`${ROUTE}/validate`), { data: body as any })),
    compile: async (body) => parse(await ctx.post(apiUrl(`${ROUTE}/compile`), { data: body as any })),
    dispose: () => ctx.dispose(),
  };
}

async function tokenFor(name: Role['name']): Promise<string> {
  const role = ROLES.find((r) => r.name === name);
  if (!role) throw new Error(`role '${name}' missing from ROLES`);
  const bootstrap = await apiRequest.newContext();
  try {
    return (await ensureAuthTokens(bootstrap, role)).accessToken;
  } finally {
    await bootstrap.dispose();
  }
}

export async function compositionApiAs(name: Role['name']): Promise<CompositionApi> {
  const token = await tokenFor(name);
  return client(await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } }));
}

export async function anonymousCompositionApi(): Promise<CompositionApi> {
  return client(await apiRequest.newContext());
}

/**
 * The AXI-2427 validator fixture: s1 Mann-Whitney over slots `group` (categorical, one) and
 * `values` (numeric, many) → s2 grouped aggregate of s1's `effectSize`; one output from s2.
 * A fresh object on every call, so a test may mutate its copy.
 */
export function composition(): any {
  return {
    nodeLibraryVersion: PINNED_VERSION,
    slots: [
      { slotId: 'group', shape: 'categorical', cardinality: 'one', wording: { name: 'Group' } },
      { slotId: 'values', shape: 'numeric', cardinality: 'many', wording: { name: 'Measurements' } },
    ],
    steps: [
      {
        stepId: 's1',
        operationId: 'stats.mann_whitney_u',
        libraryPin: { library: 'pingouin', version: '0.5.5' },
        roles: [
          { role: 'groupColumn', sources: [{ kind: 'slot', slotId: 'group' }] },
          { role: 'valueColumns', sources: [{ kind: 'slot', slotId: 'values' }] },
        ],
        parameters: [
          { key: 'groupFrom', mode: 'user_settable' },
          { key: 'groupTo', mode: 'user_settable' },
          { key: 'alternative', mode: 'fixed', value: 'two_sided' },
        ],
      },
      {
        stepId: 's2',
        operationId: 'describe.grouped_aggregate',
        libraryPin: { library: 'axiome-bio-compute/describe_execution', version: '1.0.0' },
        roles: [
          { role: 'groupColumns', sources: [{ kind: 'slot', slotId: 'group' }] },
          { role: 'valueColumn', sources: [{ kind: 'step_output', stepId: 's1', column: 'effectSize' }] },
        ],
        parameters: [
          { key: 'aggregation', mode: 'defaulted', value: 'mean', bounds: { allowedValues: ['mean', 'median'] } },
        ],
      },
    ],
    outputs: [{ name: 'group_size', shape: 'numeric', cardinality: 'one', source: { stepId: 's2', column: 'n' } }],
  };
}

/** The scenario-13 compile request (template E2E-C/1.0, bindings that compile). */
export function compileRequest(base: any = composition()): any {
  return {
    template: { templateId: 'E2E-C', templateVersion: '1.0' },
    composition: base,
    bindings: {
      slots: [
        { slotId: 'group', columns: ['arm'] },
        { slotId: 'values', columns: ['il6', 'tnf'] },
      ],
      parameters: [
        { stepId: 's1', key: 'groupFrom', value: 'A' },
        { stepId: 's1', key: 'groupTo', value: 'B' },
      ],
    },
  };
}

/** `composition()` with step `stepId` replaced by `patch(step)`. */
export function withStep(stepId: string, patch: (step: any) => any, base: any = composition()): any {
  return { ...base, steps: base.steps.map((step: any) => (step.stepId === stepId ? patch(step) : step)) };
}
