# AXI-2804 seed fixtures

Config directories merged over the shipped `semantic-profiles/config` and passed to the seed CLI
(`npm run semantic-profiles:seed -- --config-dir <dir>`) by `AXI-2804-profile-db-store.spec.ts`.
Every key starts with `e2e_2804_`. They are only ever seeded into the throwaway story database.

| Dir | Used by | What it is |
|-----|---------|------------|
| `bumped/v1`, `bumped/v2` | 4.6 (AC17, AC20) | one profile at 1.0.0, then 1.1.0 with an extra pack and field |
| `unbumped/v1`, `unbumped/edited` | 5.1 (AC16, EC1) | one profile, then the same version with a changed display name |
| `first-claimant` | 4.2 (AC6, FR14) | two fields claiming one alias token, declared zeta-first |
| `invalid` | 5.3 (AC19, EC3) | a valid 1.0.0; the spec then stores a broken 1.1.0 by SQL |
