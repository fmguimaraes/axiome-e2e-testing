import { request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../../config/env';

/**
 * Shared onboarding-tour silencer for the AXI-1904 UI-driving specs (1909,
 * 1963, 1964). A fresh/first-visit actor has `useOnboardingAutostart` fire
 * on mount and `TourRunner` `navigate()`s to whichever eligible tour's first
 * step route is — away from whatever page the test just opened
 * (`axiome-front/src/hooks/useOnboardingAutostart.ts` +
 * `src/components/onboarding/TourRunner.tsx:35`, `navigate(step.route)`).
 * This is bounced-story evidence (AXI-1965): AXI-1963's AC26 case signed in
 * as admin, went to `/system/roles/:id/edit`, and was navigated to
 * `/projects/:projectId/views` — the `charts-views` tour's
 * `autostartRoute` — mid-assertion.
 *
 * `TOUR_IDS` below is the full id list from `axiome-front/src/onboarding/
 * registry.ts`'s `TOUR_SPECS` (10 tours: orientation, workspace-data,
 * comparability-gate, subjects-datasets, evidence-decisions, graph-rules,
 * help, admin, charts-views, collaboration) as of front `origin/main`
 * 1b21b6d. The two repos are separate checkouts with no shared package, so
 * this list cannot be imported from the registry at test time — it is
 * restated here ONCE (not per spec file) specifically so a future tour
 * addition only needs one file updated, and so the next person who touches
 * a UI-driving AXI-1904 spec has exactly one place to check against the
 * registry, not three.
 *
 * MUST be called with every actor's access token before that actor's FIRST
 * `page.goto`/sign-in through the UI — including an admin who signs in
 * through the UI, not just secondary/non-owner actors.
 */
export const TOUR_IDS = [
  'orientation',
  'workspace-data',
  'comparability-gate',
  'subjects-datasets',
  'evidence-decisions',
  'graph-rules',
  'charts-views',
  'help',
  'admin',
  'collaboration',
];

export async function silenceTours(accessToken: string): Promise<void> {
  const api = await apiRequest.newContext();
  try {
    for (const tourId of TOUR_IDS) {
      await api.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } finally {
    await api.dispose();
  }
}
