import { assertNoForbiddenNames } from '../checks/forbiddenNames';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/** AC4 gate — runs last, over every entity `ensure-workspaces` touched.
 *  Throws (stopping `stage`) rather than reporting, matching the
 *  dev-epic-context's "`verify` is a gate, not a report" rule. */
export const verifyNoForbiddenNamesStep: Step<ProvisioningContext> = {
  id: 'verify-no-forbidden-names',
  dependsOn: ['ensure-workspaces'],
  async run(ctx) {
    // 'retired' entries record the forbidden name of an entity this run just
    // removed (EC1) — they are evidence the name is gone, not evidence it is
    // still present, so they are excluded from the "still in the tenant" scan.
    const present = ctx.touched.filter((t) => t.action !== 'retired');
    assertNoForbiddenNames(present.map((t) => ({ kind: t.kind, name: t.name })));
  },
};
