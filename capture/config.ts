/**
 * Fixed capture configuration (FR19/AC14, Capture Spec §18).
 *
 * "A fixed viewport identical across every master, in light theme, at
 * 2400px export width and 2x DPR, with no browser chrome." One constant
 * set, imported by every master — no master may override any of these
 * (that is the whole content of NFR4 determinism: two runs, same pixels).
 *
 * `VIEWPORT.height` is not spec-mandated by FR19's literal text (only
 * width is), but "identical viewport across every master" requires SOME
 * fixed height too, so every master's frame is comparable/stitchable —
 * chosen tall enough to show a populated panel without an awkward crop.
 */
export const VIEWPORT = { width: 2400, height: 1500 } as const;

export const DEVICE_SCALE_FACTOR = 2;

export const COLOR_SCHEME = 'light' as const;

/**
 * Generous, uniform timeout for every navigation/action (not FR19-mandated —
 * an operational allowance). The local backend has been observed taking
 * well over a minute on some read endpoints under load (e.g. a single
 * provenance-graph GET took ~150s during this story's own debugging run) —
 * a Playwright default of 30s is not "the master is broken", it is "the
 * backend hadn't answered yet". One constant, not a per-master guess.
 */
export const ACTION_TIMEOUT_MS = 90_000;

/** Directory the master PNGs land in — flat, `M<n>.png`, per the story spec. */
export const MASTERS_DIR = new URL('./masters/', import.meta.url).pathname;

export function masterPngPath(masterId: string): string {
  return `${MASTERS_DIR}${masterId}.png`;
}
