/**
 * AXI-2601 (epic AXI-2598 — FR2, FR3, FR4, FR31, EC20) — the handover suite's configuration,
 * read from the environment ONLY. Pure: an env map in, a config (or every missing variable) out,
 * so the same commit runs on the local stack and on prod with no constant changed (FR2).
 *
 * The run happens in a NAMED workspace (`HANDOVER_WORKSPACE_ID`) where the Investigator is a
 * member (role `…0105`) and the provisioning identity a team member — locally the "Mag4 -
 * Investigator" workspace, on prod the confined test workspace (AXI-2605/2606). Isolation inside
 * that workspace is by NEW PROJECT per run (FR32), never by touching what is already there.
 *
 * The provisioning identity is OPTIONAL at configuration time: without it every step an
 * Investigator can do alone still runs (sign-in, rights, upload, ingestion, cleanup), and the
 * provisioning step fails naming the missing variables — the chain after it is then blocked,
 * never faked.
 *
 * Credentials are read here and never written anywhere (NFR4).
 */
import { investigatorRole } from '../../../config/roles';
import { parseIdList } from '../../AXI-2309/harness/prod-suite/config';

export type HandoverMode = 'rehearsal' | 'provision' | 'verify';
export const HANDOVER_MODES: readonly HandoverMode[] = ['rehearsal', 'provision', 'verify'];

export interface ServiceCommits {
  front: string;
  back: string;
  compute: string;
}

export interface HandoverConfig {
  mode: HandoverMode;
  baseUrl: string;
  apiBaseUrl: string;
  workspaceId: string;
  /** Null ⇒ the provisioning step is blocked (see the module comment). */
  provisioner: { email: string; password: string } | null;
  investigator: { email: string; password: string };
  forbiddenOrgIds: string[];
  /** FR31 — the service commits the target serves, as stated by the caller; null ⇒ unrecorded. */
  commits: ServiceCommits | null;
  /** EC20 — false when the caller states a service is behind `main`; null ⇒ not stated. */
  commitsOnMain: boolean | null;
  targetLabel: string;
  reportRoot: string;
  runDate: string;
}

export type HandoverConfigResult = { ok: true; config: HandoverConfig } | { ok: false; missing: string[] };

const read = (env: Record<string, string | undefined>, name: string) => env[name]?.trim() ?? '';

/** `front=abc123,back=def456,compute=789abc` → commits, or null when any of the three is absent. */
export function parseCommits(raw: string): ServiceCommits | null {
  const map = new Map(
    raw
      .split(',')
      .map((kv) => kv.split('=').map((s) => s.trim()))
      .filter((kv) => kv.length === 2 && kv[0] && kv[1]) as Array<[string, string]>,
  );
  const front = map.get('front');
  const back = map.get('back');
  const compute = map.get('compute');
  const sha = /^[0-9a-f]{7,40}$/i;
  if (!front || !back || !compute || ![front, back, compute].every((c) => sha.test(c))) return null;
  return { front, back, compute };
}

export function readHandoverConfig(env: Record<string, string | undefined>, now = new Date()): HandoverConfigResult {
  const missing: string[] = [];
  const modeRaw = read(env, 'HANDOVER_MODE') || 'rehearsal';
  if (!(HANDOVER_MODES as readonly string[]).includes(modeRaw)) missing.push(`HANDOVER_MODE (one of ${HANDOVER_MODES.join('|')})`);
  const baseUrl = read(env, 'BASE_URL');
  const apiBaseUrl = read(env, 'API_BASE_URL');
  if (!baseUrl) missing.push('BASE_URL');
  if (!apiBaseUrl) missing.push('API_BASE_URL');
  const workspaceId = read(env, 'HANDOVER_WORKSPACE_ID');
  if (!workspaceId) missing.push('HANDOVER_WORKSPACE_ID');
  // FR4 — the `investigator` auth role of config/roles.ts (single source of its env names).
  const role = investigatorRole(env);
  const investigator = { email: role.email, password: role.password };
  if (!investigator.password) missing.push('E2E_INVESTIGATOR_PASSWORD');
  const pEmail = read(env, 'HANDOVER_PROVISIONER_EMAIL');
  const pPassword = read(env, 'HANDOVER_PROVISIONER_PASSWORD');
  if (missing.length > 0) return { ok: false, missing };
  const commitsRaw = read(env, 'HANDOVER_COMMITS');
  const onMain = read(env, 'HANDOVER_COMMITS_ON_MAIN');
  return {
    ok: true,
    config: {
      mode: modeRaw as HandoverMode,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
      workspaceId,
      provisioner: pEmail && pPassword ? { email: pEmail, password: pPassword } : null,
      investigator,
      forbiddenOrgIds: parseIdList(read(env, 'PROD_E2E_FORBIDDEN_ORG_IDS') || read(env, 'HANDOVER_FORBIDDEN_ORG_IDS')),
      commits: commitsRaw ? parseCommits(commitsRaw) : null,
      commitsOnMain: onMain === '' ? null : /^(1|true)$/i.test(onMain),
      targetLabel: read(env, 'HANDOVER_TARGET_LABEL') || 'local',
      reportRoot: read(env, 'HANDOVER_REPORT_ROOT') || 'reports/AXI-2598',
      runDate: now.toISOString().slice(0, 10),
    },
  };
}

/**
 * FR31 / EC20 — whether a run on this target may count as evidence, and why not. A run without
 * recorded commits, or on a stack stated to be behind `main`, still executes (its defects are
 * real) but its report says it does not count.
 */
export function evidenceVerdict(cfg: Pick<HandoverConfig, 'commits' | 'commitsOnMain'>): { counts: boolean; reason: string } {
  if (!cfg.commits) return { counts: false, reason: 'service commits not recorded (HANDOVER_COMMITS unset or malformed) — FR31' };
  if (cfg.commitsOnMain === false) return { counts: false, reason: 'a service is behind main (HANDOVER_COMMITS_ON_MAIN=false) — EC20' };
  if (cfg.commitsOnMain === null) return { counts: false, reason: 'not stated whether the commits equal main (HANDOVER_COMMITS_ON_MAIN unset) — EC20' };
  return { counts: true, reason: 'commits recorded and equal to main' };
}

/**
 * FR8 — whether the API target is this machine (localhost / 127.0.0.1 / ::1). Any other target
 * must configure the forbidden-org list: the isolation guard fails closed without it.
 */
export function isLocalTarget(apiBaseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiBaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
