import { recordOnlyExecutor, type CaseExecutor } from './cases';

/**
 * AXI-2318 — the executor the DAILY run uses. One line, on purpose: AXI-2319
 * (FR31 pass rule) replaces `recordOnlyExecutor` here with its own
 * {@link CaseExecutor} and adds the pass assertion to the daily spec; nothing
 * else in the infrastructure changes.
 */
export const dailyExecutor: CaseExecutor = recordOnlyExecutor;
