/**
 * AXI-2601 (epic AXI-2598 — conventions: asynchronous steps are polled with a bounded timeout and
 * the elapsed time is reported). Clock and sleep are injectable so the unit tests run instantly.
 */
export interface PollOptions<T> {
  /** One observation. */
  read: () => Promise<T>;
  /** Settled (stop and return) when true. */
  done: (value: T) => boolean;
  /** Fails fast (throw with this message) when it returns a string. */
  fatal?: (value: T) => string | null;
  timeoutMs: number;
  intervalMs: number;
  what: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollOutcome<T> {
  value: T;
  elapsedMs: number;
  observations: number;
}

export class PollTimeoutError<T> extends Error {
  constructor(
    message: string,
    readonly last: T | undefined,
    readonly elapsedMs: number,
  ) {
    super(message);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `done`, a `fatal` verdict, or the deadline — whichever comes first. */
export async function pollUntil<T>(opts: PollOptions<T>): Promise<PollOutcome<T>> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const started = now();
  let last: T | undefined;
  let observations = 0;
  for (;;) {
    last = await opts.read();
    observations++;
    const fatal = opts.fatal?.(last) ?? null;
    if (fatal) throw new PollTimeoutError(`${opts.what}: ${fatal}`, last, now() - started);
    if (opts.done(last)) return { value: last, elapsedMs: now() - started, observations };
    if (now() - started + opts.intervalMs > opts.timeoutMs) {
      throw new PollTimeoutError(`${opts.what}: not settled after ${opts.timeoutMs} ms`, last, now() - started);
    }
    await sleep(opts.intervalMs);
  }
}
