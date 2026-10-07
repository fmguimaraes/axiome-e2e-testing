import { test } from '@playwright/test';
import { adminApi } from './harness/api';
test('rule', async () => {
  const api = await adminApi();
  for (const id of ['a4f98adc-63db-41f3-9223-f3da997ba844','61a7b417-6169-4611-892c-b86ec958debf','252863c9-e785-4557-89a9-a4f8a7077d88']) {
    const r = await api.get(`/api/v1/rules/${id}`);
    const b = r.body;
    console.log('RULE', JSON.stringify({code:b.code,status:b.status,checks:b.checks,servedVersion:b.servedVersion,keys:Object.keys(b)}).slice(0,1500));
  }
});
