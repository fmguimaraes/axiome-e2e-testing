/**
 * Master outcome shape (AC14) — every master reports one of these, never a
 * silent skip. `captured` carries the PNG path; `blocked` carries the
 * concrete, human-readable reason a precondition did not hold (FR19: "a
 * master whose preconditions do not hold MUST fail rather than produce a
 * frame" — blocked is the honest form of that failure, distinct from a
 * fabricated/partial frame).
 */
export type MasterStatus = 'captured' | 'blocked';

export interface MasterResult {
  id: string;
  title: string;
  status: MasterStatus;
  detail: string;
  path?: string;
  widthPx?: number;
  heightPx?: number;
}

export function captured(id: string, title: string, path: string, widthPx: number, heightPx: number): MasterResult {
  return { id, title, status: 'captured', detail: `captured at ${widthPx}x${heightPx}`, path, widthPx, heightPx };
}

export function blocked(id: string, title: string, reason: string): MasterResult {
  return { id, title, status: 'blocked', detail: reason };
}
