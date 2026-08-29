import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { loginAsUi } from './login';
import { captureM1 } from './m1QuestionAssumptionsCharts';
import { captureM2 } from './m2ExploreFilteredTable';
import { captureM3 } from './m3VolcanoPublication';
import { captureM4 } from './m4DiscussionMentions';
import { captureM5 } from './m5InterpretationRecord';
import { captureM6 } from './m6ProvenanceGraph';
import { captureM7 } from './m7EvidenceListing';
import { captureM8 } from './m8StakeholderView';
import { captureM9 } from './m9SponsorExport';
import { captureM10 } from './m10SubjectDelta';
import { captureM11 } from './m11DatasetSchemaBadge';
import { captureM12 } from './m12FlowCytometry';
import type { MasterResult } from './types';

/**
 * The master registry (FR19/AC14: "masters M1-M12 exist ... each with its
 * preconditions asserted in code"). One entry per master, ordered — every
 * `run` signature is identical (`page`, `baseUrl`, `ctx`) except M8, which
 * needs its own UI login (a different identity), and M12, which never
 * touches a browser at all (a REST-only precondition check that already
 * determines the outcome — see `m12FlowCytometry.ts`). `runCapture.ts`
 * treats every entry uniformly: call it, catch whatever it throws, report.
 */
export interface MasterDefinition {
  id: string;
  needsDefaultLogin: boolean;
  run: (page: Page, baseUrl: string, ctx: CaptureContext) => Promise<MasterResult>;
}

export const MASTERS: MasterDefinition[] = [
  { id: 'M1', needsDefaultLogin: true, run: captureM1 },
  { id: 'M2', needsDefaultLogin: true, run: captureM2 },
  { id: 'M3', needsDefaultLogin: true, run: captureM3 },
  { id: 'M4', needsDefaultLogin: true, run: captureM4 },
  { id: 'M5', needsDefaultLogin: true, run: captureM5 },
  { id: 'M6', needsDefaultLogin: true, run: captureM6 },
  { id: 'M7', needsDefaultLogin: true, run: captureM7 },
  { id: 'M8', needsDefaultLogin: false, run: captureM8 }, // logs in as external-stakeholder itself
  { id: 'M9', needsDefaultLogin: true, run: captureM9 },
  { id: 'M10', needsDefaultLogin: true, run: captureM10 }, // AXI-1368 FIX 3: now a real browser capture
  { id: 'M11', needsDefaultLogin: true, run: captureM11 },
  { id: 'M12', needsDefaultLogin: false, run: async () => captureM12() }, // REST-only, no browser
];

/** The identity every `needsDefaultLogin` master authenticates as — the
 *  same `service` actor `stage`/`verify` use, which the workspace-
 *  provisioning step grants an `admin` workspace role (workspaceMembership.ts). */
export const DEFAULT_LOGIN_HANDLE = 'service' as const;

export async function ensureDefaultLogin(page: Page, baseUrl: string): Promise<void> {
  await loginAsUi(page, baseUrl, DEFAULT_LOGIN_HANDLE);
}
