import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader, sleep } from '../../AXI-1435/harness/api';
import type { GradosQuestion } from '../../AXI-1458/fixtures/gradosQuestions';
import type { AnchoredDataset } from '../../AXI-1604/harness/anchor-dataset';
import { LIVE_LLM, LIVE_LLM_SKIP_REASON } from '../../../config/env';

/**
 * AXI-1473 — Grados-corpus governed-path harness (@SI-047).
 *
 * The governed path the corpus E2E drives (feature FR21 / AC6):
 *   guided plan  (POST /guided-analysis/plan)
 *     -> governed run  (POST /governed-execution/submit)
 *       -> reconciler drains  (GOVERNED_EXECUTION_RECONCILER=on)
 *         -> queryable state  (GET /governed-execution/status)
 *
 * This is the industrialized AXI-1458 spike path: a planner-produced AnalysisPlan
 * submitted to the event-sourced governed engine, not the in-unit compute route.
 * All delays live here (a harness, not a `*.spec.ts`), so the poll loops are
 * condition waits, not fixed sleeps the spec linter (AXI-1265/NFR4) forbids.
 */

/**
 * The Grados 2017 IgG4-RD question bank — the corpus AC6 refers to. Defined once
 * in tests/AXI-1458/fixtures/grados-questions.json (46 questions). Loaded via fs
 * (not a JSON `import`) so the Playwright runtime needs no import attribute, and
 * so this reuses the exact fixture the spike authored rather than re-inventing it.
 */
export function loadGradosBank(): GradosQuestion[] {
  const path = join(process.cwd(), 'tests', 'AXI-1458', 'fixtures', 'grados-questions.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { questions: GradosQuestion[] }).questions;
}

/** A structural node type (no external operation) — deterministic no-op output. */
export type StructuralNodeType = 'qc_check' | 'filter' | 'join' | 'describe' | 'profile';

/** Governed run node as the STATUS RPC returns it. */
export interface RunNode {
  nodeId: string;
  status: string;
  artifactHash: string | null;
}

/** Governed run status body (`GET /governed-execution/status`). */
export interface RunStatus {
  runId: string;
  runStatus?: string;
  status?: string;
  nodes: RunNode[];
  planId?: string | null;
}

const RUN_POLL_MS = 2_000;
const RUN_POLL_MAX = 60; // 60 * 2s = 120s ceiling per run

// A governed run node is "settled" once it leaves the schedulable states — either
// it produced/reused an artifact, was blocked/failed, or halted for human approval.
const SETTLED = new Set([
  'SUCCEEDED',
  'REUSED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'AWAITING_APPROVAL',
]);

/**
 * AXI-1662: `anchorDataset()` and its types no longer live here. They are the
 * ONE shared resolver in `tests/AXI-1604/harness/anchor-dataset.ts`, imported by
 * this harness and by `tests/AXI-1603/harness/planner.ts` alike. This file used
 * to hold one of two hand-synced copies; AXI-1661's loud-failure fix was applied
 * to this copy only and never reached the other, which is the defect AXI-1662
 * exists to make structurally impossible. It is deliberately NOT re-exported
 * from here either: one implementation AND one import path, so "where does the
 * anchor come from" has a single answer. Add nothing dataset-resolving here.
 */

/** Build the minimal PlannerEnvelope the guided planner needs for one question. */
export function buildEnvelope(
  projectId: string,
  question: string,
  datasets: AnchoredDataset[],
) {
  return {
    projectId,
    question,
    sendData: false,
    context: { scientificContext: 'Grados 2017 IgG4-RD corpus E2E (AXI-1473)' },
    datasets,
  };
}

/** Ask the planner for a plan (LLM or deterministic fallback) for one question. */
export async function planQuestion(api: Api, workspaceId: string, projectId: string, envelope: ReturnType<typeof buildEnvelope>): Promise<any | null> {
  // Real Anthropic spend (AXI-1678 review A2): the gate lives in the helper that makes
  // the call, so no spec can inherit an ungated call. Opt in with E2E_LIVE_LLM=1.
  test.skip(!LIVE_LLM, LIVE_LLM_SKIP_REASON);
  const res = await api.post('/api/v1/guided-analysis/plan', { projectId, envelope }, workspaceHeader(workspaceId));
  if (res.status >= 300 || !res.body?.plan) return null;
  return res.body.plan;
}

/** Submit a plan as a governed run; returns the runId (or null on rejection). */
export async function submitPlan(api: Api, workspaceId: string, projectId: string, plan: any, datasetId: string): Promise<string | null> {
  const res = await api.post('/api/v1/governed-execution/submit', { projectId, plan, datasetId, workspaceId }, workspaceHeader(workspaceId));
  if (res.status >= 300) return null;
  return res.body?.runId ?? null;
}

/** Poll a run until every node has settled (or the ceiling is hit). */
export async function drainRun(api: Api, workspaceId: string, projectId: string, runId: string): Promise<RunStatus> {
  for (let i = 0; i < RUN_POLL_MAX; i++) {
    const res = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, workspaceHeader(workspaceId));
    const body = res.body as RunStatus;
    const nodes = body?.nodes ?? [];
    if (nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) return body;
    await sleep(RUN_POLL_MS);
  }
  const last = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, workspaceHeader(workspaceId));
  return last.body as RunStatus;
}

/** True when no node in the run ended in a hard-error state. */
export function ranWithoutError(run: RunStatus): boolean {
  const nodes = run?.nodes ?? [];
  return nodes.length > 0 && !nodes.some((n) => n.status === 'FAILED');
}
