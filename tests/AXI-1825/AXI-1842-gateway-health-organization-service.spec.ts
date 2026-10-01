import { test, expect, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1842 (epic AXI-1825) — Gateway `/health` genuinely checks
 * organization-service (manual-e2e §3.1).
 *
 * Before this story, `GET /api/v1/health` never pinged organization-service
 * at all, and `catchError(() => of(null))` swallowed every RPC failure into
 * a resolved success — a dead/unreachable organization-service still
 * reported `healthy`. This spec pins the POSITIVE path against the running
 * local stack: organization-service is now an actual checked dependency and
 * surfaces in the response.
 *
 * `body.status` is asserted as `'degraded'`, not `'ok'` — honestly, not as a
 * defect of this story. user-service and event-service have never
 * implemented a `.health` RPC handler either (the exact same gap
 * organization-service had before this story), so the gateway's
 * `allHealthy` AND over all three checks can never be `true` until a
 * follow-up story adds matching handlers there. See the "Known residual
 * gap" note in AXI-1825's manual-e2e §3.1.
 *
 * The NEGATIVE path (organization-service genuinely unreachable flips the
 * check to `unhealthy` and the overall `status` to `degraded`, never
 * silently swallowed) is `manual` residue — it needs the operator to stop
 * the organization-service container mid-run, which this headless suite
 * cannot do against the shared local stack without breaking other specs'
 * dependencies — and is pinned instead by unit tests (`UT-GW-1842-002..005`,
 * mocked `ClientProxy`, `apps/gateway/src/health/health.controller.spec.ts`).
 */
test.describe('AXI-1842 — gateway /health checks organization-service', () => {
  test(
    'organization-service is reported as a healthy, checked dependency',
    { tag: ['@SI-010'] },
    async () => {
      // Arrange
      const api = await request.newContext();

      // Act
      const res = await api.get(apiUrl('/api/v1/health'));
      const body = await res.json();

      // Assert
      expect(res.ok()).toBeTruthy();
      expect(body.checks).toHaveProperty('organization-service');
      // organization-service is THIS story's scope — it must report healthy.
      expect(body.checks['organization-service']).toBe('healthy');
      // The overall `status` is honestly 'degraded', not 'ok', in every
      // environment today: user-service and event-service have never
      // implemented a `.health` RPC message-pattern handler (same gap
      // organization-service had before this story — see the gateway
      // HealthController's `allHealthy` check, which is a logical AND over
      // all three services). Asserting 'ok' here would require fixing those
      // two services too, which is explicitly out of this story's scope (see
      // the "Known residual gap" note in AXI-1825's manual-e2e §3.1). Pinning
      // 'degraded' here — instead of ignoring `status` — makes sure this spec
      // would catch a regression where organization-service's own check
      // silently passed while being folded into a falsely-'ok' overall status.
      expect(body.status).toBe('degraded');

      await api.dispose();
    },
  );
});
