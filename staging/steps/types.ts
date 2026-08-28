/**
 * The step-graph shape (AXI-1371). Dev-epic-context: "ordering is a declared
 * dependency graph, not script sequence" — a later story that reorders steps
 * gets a loud failure (unknown/cyclic dependency) instead of a silently wrong
 * tenant. AXI-1369/1370 ran as flat scripts because they had nothing to
 * order against; this is the first story with a real dependency (identities
 * before provisioning, organization before workspaces) so it introduces the
 * graph runner the rest of the epic reuses.
 */
export interface Step<TContext> {
  id: string;
  dependsOn: string[];
  run(ctx: TContext): Promise<void>;
}
