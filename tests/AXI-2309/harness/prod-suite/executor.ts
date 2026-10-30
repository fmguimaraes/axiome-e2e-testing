import type { CaseExecutor } from './cases';
import { createPassRuleExecutor } from './pass-rule-executor';

/**
 * AXI-2318 — the executor the DAILY run uses. AXI-2319 (FR31 pass rule)
 * replaced AXI-2318's `recordOnlyExecutor` placeholder here with the pass-rule
 * executor (pass-rule-executor.ts): Paul's methods judged on expected values
 * (slide targets + R parity), every other active rule on run SUCCEEDED +
 * default chart rendered. Nothing else in the infrastructure changed.
 */
export const dailyExecutor: CaseExecutor = createPassRuleExecutor();
