import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { createHash } from 'crypto';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1899 (epic AXI-1896 — ledger, approval policy & gateway API). API-level
 * only — no UI surface exists yet (that is AXI-1903). Covers CA-1899-1..6 /
 * AC3, AC5, AC6, AC7, AC16, AC22 from
 * `axiome-docs/manual-e2e/AXI-1896-Help-Onboarding-Content-Approval.md`.
 *
 * Every actor and role is self-provisioned per run (NFR3-style isolation),
 * mirroring `tests/AXI-1762/AXI-1765-rule-review-fixtures.ts`'s `ReviewWorld`:
 * a throwaway SYSTEM role carrying exactly `content:approve`, granted to a
 * throwaway self-registered user via the same admin API the Roles UI calls.
 *
 * `contentHash` is computed locally with the FR2 help-document rule (raw
 * UTF-8 bytes, LF-normalised, sha256) using plain LF-only fixture text, so no
 * normalisation is exercised and no dependency on `libs/contracts` is needed
 * from this repo — the canonicaliser itself is proven by AXI-1897/1900's own
 * unit suites, shared via `hash-vectors.json`.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function helpDocHash(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

interface Actor {
  userId: string;
  email: string;
  api: APIRequestContext;
}

async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'get' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await api[method](apiUrl(path), body === undefined ? undefined : { data: body as any });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : {} };
}

class ContentApprovalWorld {
  admin!: APIRequestContext;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];

  static async create(): Promise<ContentApprovalWorld> {
    const world = new ContentApprovalWorld();
    world.admin = await adminApiContext();
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1899 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1899-${label}`)}@axiome.local`;
    const password = 'AXI1899-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1899',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId });
    const actor = { userId: me.json.id, email, api };
    this.actors.push(actor);
    return actor;
  }

  async dispose(): Promise<void> {
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) {
      await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    }
    await this.admin.dispose();
  }
}

let world: ContentApprovalWorld;
let holderRoleId: string;
let holder: Actor;
let nonHolder: Actor;

test.beforeAll(async () => {
  world = await ContentApprovalWorld.create();
  holderRoleId = await world.role('content-approve', ['content:approve']);
  holder = await world.actor('holder', holderRoleId);
  nonHolder = await world.actor('non-holder');
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1899 — content-approvals API (AC3, AC5, AC6, AC7, AC16, AC22)', () => {
  // CA-1899-1 / AC3
  test('AC3: a non-holder POSTing a decision gets 403 and writes nothing', async () => {
    const id = unique('doc-ac3');
    const bytes = 'Body text for AC3.\n';
    const decision = {
      kind: 'help_doc',
      id,
      locale: 'en',
      contentHash: helpDocHash(bytes),
      decision: 'approve',
      justification: 'Approving as a non-holder — must be refused.',
      approvedBytes: bytes,
      generatedBy: 'human',
      authoredBy: 'someone@axiome.bio',
    };
    const res = await send(nonHolder.api, 'post', '/api/v1/content-approvals', { decisions: [decision] });
    expect(res.status).toBe(403);

    const history = await send(holder.api, 'get', `/api/v1/content-approvals/history?kind=help_doc&id=${id}&locale=en`);
    expect(history.status).toBe(200);
    expect(history.json.records).toEqual([]);
  });

  // CA-1899-2 / AC5
  test('AC5: an author approving their own French tour is refused (D6), writing nothing', async () => {
    const id = unique('tour-ac5');
    const bytes = 'French tour canonical bytes for AC5.\n';
    const decision = {
      kind: 'tour',
      id,
      locale: 'fr',
      contentHash: helpDocHash(bytes),
      decision: 'approve',
      justification: 'Approving my own French tour.',
      approvedBytes: bytes,
      generatedBy: 'human',
      authoredBy: holder.email,
    };
    const res = await send(holder.api, 'post', '/api/v1/content-approvals', { decisions: [decision] });
    expect(res.status).toBe(403);

    const history = await send(holder.api, 'get', `/api/v1/content-approvals/history?kind=tour&id=${id}&locale=fr`);
    expect(history.json.records).toEqual([]);
  });

  // CA-1899-3 / AC6
  test('AC6: an author approving their own ENGLISH help doc succeeds, recorded selfApproved', async () => {
    const id = unique('doc-ac6');
    const bytes = 'English help doc body for AC6.\n';
    const decision = {
      kind: 'help_doc',
      id,
      locale: 'en',
      contentHash: helpDocHash(bytes),
      decision: 'approve',
      justification: 'Approving my own English help document.',
      approvedBytes: bytes,
      generatedBy: 'human',
      authoredBy: holder.email,
    };
    const res = await send(holder.api, 'post', '/api/v1/content-approvals', { decisions: [decision] });
    expect(res.status).toBeLessThan(300);

    const history = await send(holder.api, 'get', `/api/v1/content-approvals/history?kind=help_doc&id=${id}&locale=en`);
    expect(history.json.records).toHaveLength(1);
    expect(history.json.records[0].selfApproved).toBe(true);

    const status = await send(holder.api, 'get', '/api/v1/content-approvals/status');
    expect(status.json.approved).toEqual(
      expect.arrayContaining([{ kind: 'help_doc', id, locale: 'en', contentHash: decision.contentHash }]),
    );
  });

  // CA-1899-4 / AC7
  test('AC7: approvedBytes that do not hash to contentHash are refused, writing nothing', async () => {
    const id = unique('doc-ac7');
    const decision = {
      kind: 'help_doc',
      id,
      locale: 'en',
      contentHash: helpDocHash('what the hash is claimed to be for.\n'),
      decision: 'approve',
      justification: 'Mismatched bytes.',
      approvedBytes: 'completely different bytes.\n',
      generatedBy: 'human',
      authoredBy: 'someone@axiome.bio',
    };
    const res = await send(holder.api, 'post', '/api/v1/content-approvals', { decisions: [decision] });
    expect(res.status).toBe(400);

    const history = await send(holder.api, 'get', `/api/v1/content-approvals/history?kind=help_doc&id=${id}&locale=en`);
    expect(history.json.records).toEqual([]);
  });

  // CA-1899-5 / AC22
  test('AC22: a blank justification is refused for approve, reject and revoke, writing nothing', async () => {
    for (const decisionKind of ['approve', 'reject', 'revoke'] as const) {
      const id = unique(`doc-ac22-${decisionKind}`);
      const bytes = 'Body text for AC22.\n';
      const decision: Record<string, unknown> = {
        kind: 'help_doc',
        id,
        locale: 'en',
        contentHash: helpDocHash(bytes),
        decision: decisionKind,
        justification: '',
        generatedBy: 'human',
        authoredBy: 'someone@axiome.bio',
      };
      if (decisionKind === 'approve') decision.approvedBytes = bytes;
      const res = await send(holder.api, 'post', '/api/v1/content-approvals', { decisions: [decision] });
      expect(res.status, `${decisionKind} with blank justification`).toBe(400);

      const history = await send(holder.api, 'get', `/api/v1/content-approvals/history?kind=help_doc&id=${id}&locale=en`);
      expect(history.json.records).toEqual([]);
    }
  });

  // CA-1899-6 / AC16
  test('AC16: enforce is refused while a manifest item is pending, named by count; override switches it', async () => {
    const pendingId = unique('doc-ac16');
    const pendingHash = helpDocHash('Never approved body for AC16.\n');
    const manifestItems = [{ kind: 'help_doc', id: pendingId, locale: 'en', contentHash: pendingHash }];

    const refused = await send(holder.api, 'put', '/api/v1/content-approvals/mode', {
      mode: 'enforce',
      justification: 'Switching to enforce.',
      manifestItems,
    });
    expect(refused.status).toBe(409);

    const statusAfterRefusal = await send(holder.api, 'get', '/api/v1/content-approvals/status');
    expect(statusAfterRefusal.json.mode).toBe('report');

    const overridden = await send(holder.api, 'put', '/api/v1/content-approvals/mode', {
      mode: 'enforce',
      override: true,
      justification: 'Switching to enforce despite pending items.',
      manifestItems,
    });
    expect(overridden.status).toBeLessThan(300);
    expect(overridden.json.mode).toBe('enforce');

    const statusAfterSwitch = await send(holder.api, 'get', '/api/v1/content-approvals/status');
    expect(statusAfterSwitch.json.mode).toBe('enforce');

    // Restore report mode so this spec never leaks `enforce` into a later run.
    await send(holder.api, 'put', '/api/v1/content-approvals/mode', {
      mode: 'report',
      justification: 'Restoring report mode after the AC16 scenario.',
      manifestItems: [],
    });
  });
});
