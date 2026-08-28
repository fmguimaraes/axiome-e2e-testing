import type { Step } from './types';

/**
 * Topological execution of a step graph (Kahn's algorithm). Throws loudly on
 * an unknown or cyclic dependency rather than guessing an order — the
 * dev-epic-context's explicit goal for encoding ordering as data.
 */
export async function runSteps<TContext>(steps: Step<TContext>[], ctx: TContext): Promise<string[]> {
  const order = topologicalOrder(steps);
  const executed: string[] = [];
  for (const step of order) {
    await step.run(ctx);
    executed.push(step.id);
  }
  return executed;
}

function topologicalOrder<TContext>(steps: Step<TContext>[]): Step<TContext>[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  assertDependenciesKnown(steps, byId);
  const result: Step<TContext>[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  for (const step of steps) visit(step, byId, visited, visiting, result);
  return result;
}

function assertDependenciesKnown<TContext>(steps: Step<TContext>[], byId: Map<string, Step<TContext>>): void {
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) throw new Error(`step "${step.id}" depends on unknown step "${dep}"`);
    }
  }
}

function visit<TContext>(
  step: Step<TContext>,
  byId: Map<string, Step<TContext>>,
  visited: Set<string>,
  visiting: Set<string>,
  result: Step<TContext>[],
): void {
  if (visited.has(step.id)) return;
  if (visiting.has(step.id)) throw new Error(`step graph has a cycle at "${step.id}"`);
  visiting.add(step.id);
  for (const depId of step.dependsOn) visit(byId.get(depId)!, byId, visited, visiting, result);
  visiting.delete(step.id);
  visited.add(step.id);
  result.push(step);
}
