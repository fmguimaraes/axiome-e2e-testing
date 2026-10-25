import { test, expect, APIResponse } from "@playwright/test";
import { apiUrl } from "../../config/env";
import {
  Actor,
  NO_WORKSPACE_HEADER,
  PrivateProjectsWorld,
  Refusal,
  access,
  listedProjectIds,
  neverCreatedProjectId,
  refusalOf,
  uploadCsvDataset,
} from "./private-projects-fixtures";

/**
 * AXI-2268 (epic AXI-2265 — Private Projects): the access predicate on the
 * project list / pickers / findOne and the ProjectAccessGuard on every
 * /projects/:projectId/... route, driven through the gateway. API-level by
 * design (the UI is AXI-2269/AXI-2270).
 *
 * NFR2 parity: every refusal is compared to the refusal the SAME route gives a
 * never-created project id, with the per-request `path`/`timestamp` removed.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2265-Private-Projects.md
 * § "AXI-2268 — Access predicate & project-surface enforcement" (A1–A8).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const NOT_FOUND = "Project not found";
const TAGS = { tag: ["@SI-013", "@SI-010"] };

let world: PrivateProjectsWorld;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let member: Actor;
let grantee: Actor;
let outsider: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  const managerRole = await world.workspaceRole("manager", [
    "project:manage_access",
  ]);
  owner = await world.actor("owner");
  admin = await world.actor("admin");
  manager = await world.actor("manager");
  member = await world.actor("member");
  grantee = await world.actor("grantee");
  outsider = await world.actor("outsider");
  await world.addMember(owner, "editor");
  await world.addMember(admin, "admin");
  await world.addMember(manager, { roleId: managerRole });
  await world.addMember(member, "editor");
  await world.addMember(grantee, "editor");
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProject(): Promise<string> {
  const res = await owner.api.post(apiUrl("/api/v1/projects"), {
    data: {
      name: `E2E AXI-2268 ${Date.now()}`,
      workspaceId: world.workspaceId,
    },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, "private")).status()).toBe(200);
  return id;
}

/** One probe per guarded controller family (UT-GW-2268-21 proves all 71 routes). */
type Probe = {
  label: string;
  send: (a: Actor, projectId: string, opts?: object) => Promise<APIResponse>;
};

const get =
  (path: (id: string) => string): Probe["send"] =>
  (a, id, opts) =>
    a.api.get(apiUrl(path(id)), opts);

const PROBES: Probe[] = [
  { label: "GET /projects/:id", send: get((id) => `/api/v1/projects/${id}`) },
  {
    label: "PATCH /projects/:id",
    send: (a, id, opts) =>
      a.api.patch(apiUrl(`/api/v1/projects/${id}`), {
        ...opts,
        data: { name: "x" },
      }),
  },
  {
    label: "GET /projects/:id/datasets",
    send: get((id) => `/api/v1/projects/${id}/datasets`),
  },
  {
    label: "GET /projects/:id/audit-logs",
    send: get((id) => `/api/v1/projects/${id}/audit-logs`),
  },
  {
    label: "GET /projects/:id/semantic-contract",
    send: get((id) => `/api/v1/projects/${id}/semantic-contract`),
  },
  {
    label: "GET /projects/:id/access",
    send: get((id) => `/api/v1/projects/${id}/access`),
  },
  {
    label: "GET /projects/:id/rule-families",
    send: get((id) => `/api/v1/projects/${id}/rule-families`),
  },
  {
    label: "GET /projects/:id/data-explorer/queries",
    send: get((id) => `/api/v1/projects/${id}/data-explorer/queries`),
  },
  {
    label: "GET /projects/:id/client-exploration/config",
    send: get((id) => `/api/v1/projects/${id}/client-exploration/config`),
  },
  {
    label: "GET /overview/projects/:id",
    send: get((id) => `/api/v1/overview/projects/${id}`),
  },
  {
    label: "GET /discovery/projects/:id/discovery-analyses",
    send: get((id) => `/api/v1/discovery/projects/${id}/discovery-analyses`),
  },
];

/** The refusal for `projectId` and the refusal for a never-created id, on one route. */
async function parity(
  probe: Probe,
  a: Actor,
  projectId: string,
  opts?: object,
): Promise<[Refusal, Refusal]> {
  const reference = await refusalOf(
    await probe.send(a, neverCreatedProjectId(), opts),
  );
  const real = await refusalOf(await probe.send(a, projectId, opts));
  return [real, reference];
}

async function expectNotFoundParity(
  probe: Probe,
  a: Actor,
  projectId: string,
  opts?: object,
) {
  const [real, reference] = await parity(probe, a, projectId, opts);
  expect
    .soft(
      real,
      `${probe.label}: refusal must equal the never-created reference`,
    )
    .toEqual(reference);
  expect.soft(real.status, `${probe.label}: never admitted`).not.toBe(200);
  if (
    probe.label.startsWith("GET /projects/:id") ||
    probe.label.startsWith("PATCH /projects/:id")
  ) {
    expect.soft(real.status, probe.label).toBe(404);
    expect.soft(real.body.message, probe.label).toBe(NOT_FOUND);
  }
}

test.describe("AXI-2268 — access predicate & ProjectAccessGuard", TAGS, () => {
  test("AC2 — A1: a private project is hidden from the list and every picker query", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    const ws = world.workspaceId;

    // Act
    const views = await Promise.all([
      listedProjectIds(member, `?workspaceId=${ws}&limit=100`),
      listedProjectIds(
        member,
        `?workspaceId=${ws}&excludeArchived=true&limit=100`,
      ),
      listedProjectIds(member, "?limit=100"),
      listedProjectIds(outsider, `?workspaceId=${ws}&limit=100`).catch(
        () => [] as string[],
      ),
    ]);

    // Assert
    for (const ids of views) expect(ids).not.toContain(projectId);
    expect(
      await listedProjectIds(owner, `?workspaceId=${ws}&limit=100`),
    ).toContain(projectId);
  });

  test("AC3 — A2: every probed project surface answers a non-grantee member with the reference 404", async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert
    for (const probe of PROBES)
      await expectNotFoundParity(probe, member, projectId);
  });

  test("AC3 — A3: a non-member learns nothing: workspace-optional routes give the reference 404", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    const workspaceOptional = PROBES.filter((p) =>
      [
        "GET /overview/projects/:id",
        "GET /projects/:id/data-explorer/queries",
        "GET /projects/:id/client-exploration/config",
      ].includes(p.label),
    );

    // Act / Assert
    for (const probe of workspaceOptional) {
      const [real, reference] = await parity(
        probe,
        outsider,
        projectId,
        NO_WORKSPACE_HEADER,
      );
      expect.soft(real, probe.label).toEqual(reference);
      expect.soft(real.status, probe.label).toBe(404);
      expect.soft(real.body.message, probe.label).toBe(NOT_FOUND);
    }
  });

  test("AC4 — A4: a grantee sees and opens the private project", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    expect(
      (await access.grant(owner, projectId, grantee.userId)).status(),
    ).toBe(201);

    // Act
    const listed = await listedProjectIds(
      grantee,
      `?workspaceId=${world.workspaceId}&limit=100`,
    );
    const reads = await Promise.all(
      [
        `/api/v1/projects/${projectId}`,
        `/api/v1/projects/${projectId}/datasets`,
        `/api/v1/projects/${projectId}/rule-families`,
      ].map((path) => grantee.api.get(apiUrl(path))),
    );

    // Assert
    expect(listed).toContain(projectId);
    for (const res of reads) expect(res.status(), res.url()).toBe(200);
  });

  test("AC7 — A5: revocation takes effect on the very next request (no decision cache)", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    await access.grant(owner, projectId, grantee.userId);
    expect(
      (await grantee.api.get(apiUrl(`/api/v1/projects/${projectId}`))).status(),
    ).toBe(200);

    // Act
    expect(
      (await access.revoke(owner, projectId, grantee.userId)).status(),
    ).toBe(204);

    // Assert
    expect(
      await listedProjectIds(
        grantee,
        `?workspaceId=${world.workspaceId}&limit=100`,
      ),
    ).not.toContain(projectId);
    await expectNotFoundParity(PROBES[0], grantee, projectId);
  });

  test("AC8 — A6: owner, admin and a project:manage_access holder always see the private project", async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert — owner and admin, no grants
    for (const actor of [owner, admin]) {
      expect(
        await listedProjectIds(
          actor,
          `?workspaceId=${world.workspaceId}&limit=100`,
        ),
      ).toContain(projectId);
      expect(
        (await actor.api.get(apiUrl(`/api/v1/projects/${projectId}`))).status(),
      ).toBe(200);
      expect(
        (
          await actor.api.get(apiUrl(`/api/v1/projects/${projectId}/datasets`))
        ).status(),
      ).toBe(200);
    }
    // FR7 amended — the manage_access holder (not owner/admin, no grant) passes the guard
    expect(
      await listedProjectIds(
        manager,
        `?workspaceId=${world.workspaceId}&limit=100`,
      ),
    ).toContain(projectId);
    expect(
      (await manager.api.get(apiUrl(`/api/v1/projects/${projectId}`))).status(),
    ).toBe(200);
    expect((await access.list(manager, projectId)).status()).toBe(200);
  });

  test("AC9 — A7: private → public makes the project visible to every member; grants stay dormant", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    await access.grant(owner, projectId, grantee.userId);

    // Act
    expect((await access.visibility(owner, projectId, "public")).status()).toBe(
      200,
    );

    // Assert
    expect(
      await listedProjectIds(
        member,
        `?workspaceId=${world.workspaceId}&limit=100`,
      ),
    ).toContain(projectId);
    expect(
      (await member.api.get(apiUrl(`/api/v1/projects/${projectId}`))).status(),
    ).toBe(200);
    const state = await (await access.list(owner, projectId)).json();
    expect(state.grantsActive).toBe(false);
    expect(state.grants.map((g: { userId: string }) => g.userId)).toContain(
      grantee.userId,
    );
  });

  test("AC10 — A8: a dataset linked to a private project stays visible in the workspace", async () => {
    // Arrange
    const projectId = await newPrivateProject();
    const datasetId = await uploadCsvDataset(world, owner);
    const link = await owner.api.post(
      apiUrl(`/api/v1/projects/${projectId}/datasets`),
      { data: { datasetId } },
    );
    expect(link.ok(), await link.text()).toBe(true);
    const base = `/api/v1/workspaces/${world.workspaceId}/datasets`;

    // Act
    const list = await member.api.get(apiUrl(`${base}?limit=100`));
    const one = await member.api.get(apiUrl(`${base}/${datasetId}`));

    // Assert
    expect(list.status()).toBe(200);
    const listed = ((await list.json())?.data ?? []).map(
      (d: { id: string }) => d.id,
    );
    expect(listed).toContain(datasetId);
    expect(one.status()).toBe(200);
    await expectNotFoundParity(PROBES[2], member, projectId);
  });
});
