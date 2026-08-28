import { ensureProject } from './projectProvisioning';
import { retireProject } from './projectRetirement';
import { ensureWorkspace } from './workspaceProvisioning';
import type { ProvisioningContext } from './context';
import type { WorkspaceFixture } from '../fixtures/types';
import type { Step } from './types';

/** FR5/EC1 — provision every workspace, its kept projects and its retired
 *  (deleted) projects, in fixture order. Depends on `ensure-organization`
 *  for `ctx.orgId`. */
export const ensureWorkspacesStep: Step<ProvisioningContext> = {
  id: 'ensure-workspaces',
  dependsOn: ['ensure-organization'],
  async run(ctx) {
    for (const workspaceFixture of ctx.fixture.workspaces) {
      await provisionOneWorkspace(ctx, workspaceFixture);
    }
  },
};

async function provisionOneWorkspace(ctx: ProvisioningContext, fixture: WorkspaceFixture): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx, fixture);
  ctx.workspaceIdByFixtureName.set(fixture.name, workspaceId);
  for (const project of fixture.projects) await ensureProject(ctx, workspaceId, project);
  for (const retired of fixture.retiredProjects) await retireProject(ctx, workspaceId, retired);
}
