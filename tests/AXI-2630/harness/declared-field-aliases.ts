/**
 * AXI-2665 (epic AXI-2630, FR76, AC57; SI-042). PURE: the body of
 * `PUT /api/v1/discovery/datasets/:datasetId/semantic-declaration` that states which file column carries
 * each extension field of the plan. A preset field's `name` IS its column, so every pair is
 * declared and exact; nothing here matches a column to a field by likeness.
 */
import type { FileKey, NewModelPreset } from './new-model-preset';

export interface FieldAlias {
  term: string;
  column: string;
}

export interface SemanticDeclarationBody {
  scopeRoles: unknown[];
  aliases?: FieldAlias[];
  [member: string]: unknown;
}

/** One `{term, column}` per extension field the given file carries. */
export function declaredFieldAliases(preset: NewModelPreset, projectId: string, file: FileKey): FieldAlias[] {
  return preset.dataSpecification.fields
    .filter((f) => f.canonicalFieldSource === 'extension' && f.file === file)
    .map((f) => ({ term: `project.${projectId}.${f.canonicalField}`, column: f.name }));
}

/**
 * The declaration to PUT: the dataset's current one with these aliases added. The PUT replaces
 * the whole declaration and a reference file may already be linked to another project, so every
 * other member and every other term is kept.
 */
export function declarationWithFieldAliases(
  current: SemanticDeclarationBody | null,
  aliases: readonly FieldAlias[],
): SemanticDeclarationBody {
  const base = current ?? { scopeRoles: [] };
  const terms = new Set(aliases.map((a) => a.term));
  const kept = (base.aliases ?? []).filter((a) => !terms.has(a.term));
  return { ...base, aliases: [...kept, ...aliases] };
}
