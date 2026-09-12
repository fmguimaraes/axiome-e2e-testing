import questionsJson from './grados-questions.json';

/**
 * AXI-1458 — Guided Analysis question bank for the Grados 2017 IgG4-RD demo
 * (project "CeRAINOM-IgG4 — Grados 2017 IgG4-RD (MAG4)"). 46 questions spanning
 * the analytic surface the demo exercises; drive the guided flow's question
 * screen with these instead of ad-hoc strings.
 */
export type GradosCategory =
  | 'group_comparison'
  | 'representation'
  | 'longitudinal'
  | 'cohort_structure'
  | 'correlation'
  | 'stratification'
  | 'pathology'
  | 'data_quality'
  | 'governance';

export interface GradosQuestion {
  id: number;
  category: GradosCategory;
  question: string;
}

export const GRADOS_QUESTIONS: GradosQuestion[] = (questionsJson as { questions: GradosQuestion[] }).questions;

export function questionsByCategory(category: GradosCategory): GradosQuestion[] {
  return GRADOS_QUESTIONS.filter((q) => q.category === category);
}

export function questionById(id: number): GradosQuestion | undefined {
  return GRADOS_QUESTIONS.find((q) => q.id === id);
}
