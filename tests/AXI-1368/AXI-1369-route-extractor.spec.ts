import { test, expect } from '@playwright/test';
import { parseControllerSource, findDuplicateRoutes } from '../../staging/audit/routeExtractor';

/**
 * AXI-1369 — route-table extractor (FR15 input). Manual-E2E §AXI-1368 §5.2.
 * API-level, no browser: pure parsing against inline fixtures shaped exactly
 * like the real gateway controllers that motivated this story (the
 * two-controllers-per-file bug and the base-path-less `@Controller`s).
 *
 * @SI-044.
 */

// Mirrors apps/gateway/src/proxy/merge-run.controller.ts's shape: two
// `@Controller` classes in one file, the second's route sharing a decorator
// name with a route in the first. A naive "one controller path per file"
// extractor misattributes the second class's GET onto the first class's base
// path, producing a false "GET .../merge-runs declared twice" (the exact
// finding the dev-epic-context flags — this fixture proves the fix).
const TWO_CONTROLLERS_PER_FILE = `
import { Controller, Get, Post } from '@nestjs/common';

@Controller({ path: 'view-analyses/:viewAnalysisId/merge-runs', version: '1' })
export class MergeRunProxyController {
  @Post()
  initiate() {}

  @Get()
  listByAnalysis() {}
}

@Controller({ path: 'view-analyses/:viewAnalysisId/consolidated-node', version: '1' })
export class ConsolidatedNodeProxyController {
  @Get()
  get() {}
}
`;

// Mirrors thresholds.controller.ts / notifications.controller.ts: no `path`
// prop at all, only `version` — the two base paths the dev-epic-context
// flagged as unresolved by static analysis ("?/thresholds").
const NO_PATH_CONTROLLER = `
import { Controller, Get, Post } from '@nestjs/common';

@Controller({ version: '1' })
export class ThresholdsProxyController {
  @Get('visualization-specs/:specId/thresholds')
  findThresholds() {}

  @Post('thresholds')
  createThreshold() {}

  @Post('annotations')
  createAnnotation() {}
}
`;

test.describe('FR15 — route-table extractor scopes decorators per class, not per file', () => {
  test('FR15 — a second @Controller in the same file gets its own route, not the first controller\'s path', () => {
    const routes = parseControllerSource(TWO_CONTROLLERS_PER_FILE, 'merge-run.controller.ts');
    const consolidatedGet = routes.find((r) => r.controllerClass === 'ConsolidatedNodeProxyController');
    expect(consolidatedGet?.path).toBe('/api/v1/view-analyses/:viewAnalysisId/consolidated-node');
    expect(consolidatedGet?.path).not.toBe('/api/v1/view-analyses/:viewAnalysisId/merge-runs');
  });

  test('FR15 AC3 — the merge-runs GET is declared exactly once when scoped per class (the duplicate is a naive-extractor artifact)', () => {
    const routes = parseControllerSource(TWO_CONTROLLERS_PER_FILE, 'merge-run.controller.ts');
    const duplicates = findDuplicateRoutes(routes);
    expect(duplicates).toHaveLength(0);
    expect(routes.filter((r) => r.method === 'GET' && r.path === '/api/v1/view-analyses/:viewAnalysisId/merge-runs')).toHaveLength(1);
  });

  test('FR15 — a naive per-file extractor WOULD manufacture the duplicate (documents the bug this story fixes)', () => {
    // Simulates "last @Controller path wins for the whole file" — the naive approach.
    const routes = parseControllerSource(TWO_CONTROLLERS_PER_FILE, 'merge-run.controller.ts');
    const naiveAllOnFirstPath = routes.map((r) => ({ ...r, path: r.path.replace('consolidated-node', 'merge-runs') }));
    const naiveDuplicates = findDuplicateRoutes(naiveAllOnFirstPath);
    expect(naiveDuplicates).toContain('GET /api/v1/view-analyses/:viewAnalysisId/merge-runs');
  });

  test('FR15 — @Controller({ version }) with no path prop resolves to an empty base path', () => {
    const routes = parseControllerSource(NO_PATH_CONTROLLER, 'thresholds.controller.ts');
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/visualization-specs/:specId/thresholds',
        'POST /api/v1/thresholds',
        'POST /api/v1/annotations',
      ]),
    );
  });

  test('FR15 — @Get() with no argument resolves to the base path alone', () => {
    const routes = parseControllerSource(TWO_CONTROLLERS_PER_FILE, 'merge-run.controller.ts');
    const list = routes.find((r) => r.controllerClass === 'MergeRunProxyController' && r.method === 'GET');
    expect(list?.path).toBe('/api/v1/view-analyses/:viewAnalysisId/merge-runs');
  });
});
