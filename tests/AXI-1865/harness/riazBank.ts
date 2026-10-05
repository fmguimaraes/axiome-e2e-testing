import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AXI-1865 — the ten Riaz 2017 follow-up questions (Q2..Q11) as a live-run bank.
 * Question text is copied verbatim from
 * axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md (catalog rows Q2..Q11).
 * Selected with `SHADOW_RUN_BANK=riaz`. Pure: reads a local fixture, no network.
 */
export interface RiazQuestion {
  readonly id: number;
  readonly question: string;
}

export const RIAZ_BANK_FIXTURE = join(process.cwd(), 'tests', 'AXI-1865', 'fixtures', 'riaz-questions.json');

export function loadRiazBank(path: string = RIAZ_BANK_FIXTURE): RiazQuestion[] {
  const questions = (JSON.parse(readFileSync(path, 'utf8')) as { questions: RiazQuestion[] }).questions;
  if (questions.length !== 10) {
    throw new Error(`Riaz bank must carry exactly 10 questions, found ${questions.length}`);
  }
  return questions;
}
