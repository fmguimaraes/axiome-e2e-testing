import { test, expect } from '@playwright/test';
import { seedLiveWorkbench } from './harness/live-workbench';

test('AXI-1862 diagnosis: discovery step resolver bindings for Screen step', async ({ request }) => {
  const s = await seedLiveWorkbench(`AXI-1862-diagB-${Date.now()}`, `AXI-1862-diagB-${Date.now()}`);
  const plan = await s.api.get(`/api/v1/discovery/analyses/${s.viewAnalysisId}/plan`, s.t.headers);
  const screenNode = (plan.body.nodes ?? []).find((n: any) => n.stepId === 'screen' || /screen/i.test(n.nodeId));
  console.log('nodes:', JSON.stringify((plan.body.nodes ?? []).map((n: any) => ({ nodeId: n.nodeId, stepId: n.stepId })), null, 2));
  const nodeRef = screenNode?.nodeId ?? 'screen';
  const res = await s.api.get(`/api/v1/discovery/analyses/${s.viewAnalysisId}/steps/${nodeRef}/resolve`, s.t.headers);
  console.log('status', res.status);
  console.log(JSON.stringify(res.body, null, 2).slice(0, 4000));
});
