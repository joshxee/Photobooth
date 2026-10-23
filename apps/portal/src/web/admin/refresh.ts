// The event-day health view refreshes itself (DESIGN §12, §15): every 15 s while the page is
// visible, one refresh the moment it becomes visible again, never two in flight. Each refresh is one
// admin request against the Workers Free daily limit, hence "visible only".

export const REFRESH_MS = 15_000;

export interface RefreshEnv {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isVisible(): boolean;
  /** Returns the unsubscribe function. */
  onVisibilityChange(fn: () => void): () => void;
}

export const browserEnv: RefreshEnv = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  isVisible: () => document.visibilityState === "visible",
  onVisibilityChange(fn) {
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  },
};

/**
 * Calls `load` every `REFRESH_MS` while visible. The first call is the caller's own (the view
 * loads on mount); this one only keeps it fresh. Returns the stop function. A failed load is
 * `load`'s to report; the next refresh happens as usual.
 */
export function startRefresh({ env = browserEnv, load }: { env?: RefreshEnv; load(): Promise<void> }): () => void {
  let timer: unknown = null;
  let inFlight = false;
  let stopped = false;

  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (stopped || inFlight || !env.isVisible()) return;
    timer = env.setTimeout(run, REFRESH_MS);
  };
  const run = async () => {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await load();
    } catch {
      // The view shows the failure; the next refresh retries.
    } finally {
      inFlight = false;
    }
    schedule();
  };
  const onVisibility = () => {
    if (env.isVisible()) void run();
    else clear();
  };

  const unsubscribe = env.onVisibilityChange(onVisibility);
  schedule();
  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
}
