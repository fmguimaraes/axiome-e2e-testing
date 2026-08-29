/**
 * AC15 — "No shipped frame contains anything from Capture Spec §19." The
 * primary control is WHICH screens capture visits at all (masters only
 * navigate sanctioned routes — never `/partners`, `/rules`, a Safe-Compare
 * view, or any dashed-placeholder marketing slot) — this module is the
 * defense-in-depth second check: a textual scan of what actually rendered,
 * so a regression that leaks do-not-ship content onto a sanctioned page
 * still fails loudly instead of silently shipping.
 */
const DO_NOT_SHIP_MARKERS: RegExp[] = [
  /Product screenshot\s*·/i, // the dashed placeholder card itself (Feature doc §2)
  /partners?\s+trusted\s+by/i, // partner/trusted-by strip
  /safe\s*compare/i, // Safe-Compare screens (AXI-1236) — not a Capture Spec surface
  /\brule\s+catalog\b/i, // rule-authoring screens
];

/** Pure — exported for unit testing without a browser. */
export function findDoNotShipViolations(pageText: string): string[] {
  return DO_NOT_SHIP_MARKERS.filter((re) => re.test(pageText)).map((re) => re.source);
}

export function assertNoDoNotShipContent(masterId: string, pageText: string): void {
  const violations = findDoNotShipViolations(pageText);
  if (violations.length > 0) {
    throw new Error(`${masterId}: AC15 violation — Capture Spec §19 do-not-ship marker(s) found on the rendered page: ${violations.join(', ')}`);
  }
}
