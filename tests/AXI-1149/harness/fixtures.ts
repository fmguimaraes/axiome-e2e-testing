import { test as base, expect } from '@playwright/test';
import { provisionTopology, type Topology } from './tenancy';

/**
 * Worker-scoped two-tenant topology (AXI-1149-validation): provisioned once per
 * worker via the REST API, shared by every spec in the epic folder.
 */
export const test = base.extend<object, { topo: Topology }>({
  topo: [
    async ({}, use) => {
      const topo = await provisionTopology();
      await use(topo);
      await topo.dispose();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

export { expect };
