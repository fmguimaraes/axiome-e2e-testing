/**
 * AXI-2663 (epic AXI-2630, FR74, AC55; SI-042). PURE: decides whether this run may start. Every
 * credential comes from the environment and none has a default (docs/TEST-IDENTITY.md). No file is
 * read here, and no `.env` file is ever loaded by this script.
 */
import { readHandoverConfig, type HandoverConfig } from '../../AXI-2598/harness/config';

export const REPORT_ROOT = 'reports/AXI-2630';
/** The shared demo stack's ports: this script never targets them. */
export const REFUSED_PORTS: readonly string[] = ['3000', '5173'];

export type ReproductionConfig = HandoverConfig & { provisioner: { email: string; password: string } };
export type ConfigResult = { ok: true; config: ReproductionConfig } | { ok: false; problems: string[] };

function portOf(url: string): string | null {
  try {
    return new URL(url).port;
  } catch {
    return null;
  }
}

function portProblems(env: Record<string, string | undefined>): string[] {
  return ['API_BASE_URL', 'BASE_URL'].flatMap((name) => {
    const port = portOf(env[name]?.trim() ?? '');
    return port !== null && REFUSED_PORTS.includes(port) ? [`${name} targets port ${port}, the shared demo stack: use an isolated stack`] : [];
  });
}

function transportProblems(env: Record<string, string | undefined>): string[] {
  if (env.GUIDED_ANALYSIS_LLM_TRANSPORT?.trim() === 'recorded') return [];
  return ['GUIDED_ANALYSIS_LLM_TRANSPORT must be "recorded": this run makes no paid LLM call'];
}

function provisionerProblems(env: Record<string, string | undefined>): string[] {
  return ['HANDOVER_PROVISIONER_EMAIL', 'HANDOVER_PROVISIONER_PASSWORD'].filter((name) => !env[name]?.trim()).map((name) => `${name} is not set`);
}

export function readReproductionConfig(env: Record<string, string | undefined>, now = new Date()): ConfigResult {
  const handover = readHandoverConfig({ ...env, HANDOVER_REPORT_ROOT: REPORT_ROOT }, now);
  const missing = handover.ok ? [] : handover.missing.map((name) => `${name} is not set`);
  const problems = [...missing, ...provisionerProblems(env), ...transportProblems(env), ...portProblems(env)];
  if (!handover.ok || problems.length > 0) return { ok: false, problems };
  return { ok: true, config: handover.config as ReproductionConfig };
}
