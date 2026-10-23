// Live updates by polling (DESIGN §11). Every poll is a Worker request against the account's
// Workers Free 100,000 a day, shared by every guest, booth and admin (§16, spike Q12), so:
// 30 s ± 10 % jitter, only while the page is visible and the event accepts uploads, plus one
// poll the moment the page becomes visible again. The session view (a guest who just scanned the
// booth's QR) polls every 10 s for its first 2 minutes, while their shots arrive. Never faster.

export const POLL_MS = 30_000;
export const FAST_POLL_MS = 10_000;
export const FAST_WINDOW_MS = 120_000;
const JITTER = 0.1;

export interface PollerEnv {
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isVisible(): boolean;
  /** Returns the unsubscribe function. */
  onVisibilityChange(fn: () => void): () => void;
}

export const browserEnv: PollerEnv = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  isVisible: () => document.visibilityState === "visible",
  onVisibilityChange(fn) {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

/** `elapsed` is the time since the session view started; `fast` only for that view. */
export function pollDelay(fast: boolean, elapsed: number, random: number): number {
  const base = fast && elapsed < FAST_WINDOW_MS ? FAST_POLL_MS : POLL_MS;
  return Math.round(base * (1 - JITTER + 2 * JITTER * random));
}

export interface PollerOptions {
  env: PollerEnv;
  /** The session view's 10 s window. */
  fast: boolean;
  /** Resolves "stop" when polling should end for good (the event no longer accepts uploads). */
  poll(): Promise<"stop" | undefined>;
}

export interface Poller {
  start(): void;
  stop(): void;
}

export function createPoller({ env, fast, poll }: PollerOptions): Poller {
  const startedAt = env.now();
  let timer: unknown = null;
  let running = false;
  let inFlight = false;
  let unsubscribe: (() => void) | null = null;

  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!running || !env.isVisible()) return;
    timer = env.setTimeout(run, pollDelay(fast, env.now() - startedAt, env.random()));
  };
  const stop = () => {
    running = false;
    clear();
    unsubscribe?.();
    unsubscribe = null;
  };
  async function run() {
    timer = null;
    if (inFlight || !running) return;
    inFlight = true;
    let outcome: "stop" | undefined;
    try {
      outcome = await poll();
    } finally {
      inFlight = false;
    }
    if (outcome === "stop") stop();
    else schedule();
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = env.onVisibilityChange(() => {
        if (!running) return;
        if (env.isVisible()) {
          clear();
          void run();
        } else {
          clear();
        }
      });
      schedule();
    },
    stop,
  };
}
