# E2E Test Identity (AXI-1895 — FR27 / NFR3 / AC16)

**Every automated e2e test runs as `test@axiomebio.com`.** This is the single
identity the `admin` role in `config/roles.ts` resolves to by default, and the
`storageState` every spec consumes (`tests/setup/auth.setup.ts`, AXI-1264) is
minted for that account. A spec that needs a *different* identity (a
self-registering `user` role, a `staging/identities/**` cast member, an RBAC
harness identity) still creates and authenticates that identity explicitly —
this doc only fixes the **default**.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `E2E_TEST_EMAIL` | `test@axiomebio.com` | The identity every e2e test authenticates as. Overridable per run/environment; the default already matches FR27. |
| `E2E_TEST_PASSWORD` | *(none — required)* | That account's password. **Never has a default and is never committed** (NFR3) — the suite fails loudly (`login failed … is the seed applied?`) rather than silently trying a guessed value. |

The older `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` names are still read as a
fallback (`config/roles.ts`) so any script or CI secret already exporting them
keeps working; `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` are the names to use going
forward.

## Where the password comes from

On the local `make local-up` / `wt-up.sh` demo stack, `test@axiomebio.com`'s
password is an **owner-provided value**, supplied at run time via
`E2E_TEST_PASSWORD` — either exported in your shell or in a local, gitignored
`.env` (copy `.env.example`, which carries only the variable *name*, never the
value). Ask the owner for the value out of band (chat, password manager —
never a committed file, a code comment, or a Jira/Confluence page). The same
rule applies to any other environment this suite targets: the password is
always supplied through the environment or the platform secret store, never
written into this repository (NFR3).

## Creating the account on a fresh stack

A freshly seeded stack does not have `test@axiomebio.com` yet. Create it once,
as a platform admin, via the REST API (never raw SQL — see
`docs/REST-API-Guide.md` §1.2):

```
POST /api/v1/users
Authorization: Bearer <platform-admin access token>
{ "email": "test@axiomebio.com", "password": "<the owner-provided value>", "firstName": "E2E", "lastName": "Test" }
```

- `password` is accepted on create, so the account exists with a known
  credential in one call — no email round-trip (`apps/gateway/src/proxy/
  users.controller.ts`).
- Creating a user with an elevated `role` is itself admin-gated
  (`assertCanCreateUserWithRole`) — call this as an existing platform admin's
  token (e.g. the stack's seeded admin), not as an anonymous or self-registered
  user.
- There is no lookup-by-email route; if the call 409s/ fails because the
  account already exists, that is the expected steady state on a stack that
  has already been set up once.
- This creates the bare account only. Organization/workspace membership and
  any role/permission grants it needs for a given spec are provisioned
  separately (`POST /api/v1/roles`, `POST /api/v1/users/:id/roles`, workspace
  `members` routes) — see `docs/REST-API-Guide.md` §§1–2.

## Scope note — staging/capture toolkit is a separate identity concern

`staging/**` and `capture/**` (SI-044) provision demo/staging tenants through
a *bootstrap* admin (`STAGING_ADMIN_EMAIL`/`STAGING_ADMIN_PASSWORD`,
`.env.example`) used only to mint the toolkit's own service account — a
different concern from "which identity does an e2e test run as." FR27/AC16
scope this doc to the e2e auth identity (`config/roles.ts` /
`tests/setup/auth.setup.ts`); the staging toolkit's bootstrap admin is out of
scope here and unchanged by this story.
