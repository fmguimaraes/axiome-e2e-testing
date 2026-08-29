import { hasFlowCytometryDataset } from '../resolveCaptureContext';
import { blocked } from './types';
import type { MasterResult } from './types';

/**
 * M12 — flow cytometry population-frequency master. OQ4 (dev-epic-context)
 * asked whether usable flow-cytometry data exists at all. It does not:
 * `DataRequirement` (`staging/fixtures/types.ts`) is a CLOSED union of
 * `'de_table' | 'count_matrix' | 'stratified_de_table'` — no flow-cytometry
 * role is representable in the fixture format `stage` reads, so no run of
 * this toolkit can ever produce one. This is a structural block, checked
 * live via `hasFlowCytometryDataset()` rather than assumed, per the story
 * brief's "flag it, don't fabricate" instruction — no browser is launched
 * for this master at all, since there is nothing to navigate to.
 */
const ID = 'M12';
const TITLE = 'Flow cytometry population-frequency master';

export function captureM12(): MasterResult {
  if (hasFlowCytometryDataset()) {
    throw new Error(`${ID}: unexpected — a flow-cytometry dataset role now exists; this master needs implementing, not blocking`);
  }
  return blocked(ID, TITLE, 'OQ4 (dev-epic-context): no flow-cytometry data exists — the fixture\'s DataRequirement union has no such role, so the platform has never ingested one for this tenant. Producing usable flow-cytometry population-frequency data is out of SI-044\'s scope (it stages content against the platform\'s existing REST surface, it does not create new data sources).');
}
