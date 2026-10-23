// Test helpers for the gallery (bun test + happy-dom). Not imported by the app.
import type { GalleryPhoto, GalleryPhotosPage } from "../../shared/schemas";
import type { PollerEnv } from "./poller";

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A hand-driven clock and visibility: `advance` runs due timers in order. */
export function fakeEnv(random = 0.5) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let visible = true;
  const listeners = new Set<() => void>();
  const env: PollerEnv = {
    now: () => now,
    random: () => random,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
    isVisible: () => visible,
    onVisibilityChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    env,
    pending: () => timers.size,
    async advance(ms: number, settle: () => Promise<void> = flushMicrotasks) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
    },
    async setVisible(v: boolean, settle: () => Promise<void> = flushMicrotasks) {
      visible = v;
      for (const fn of listeners) fn();
      await settle();
    },
  };
}

let clock = Date.parse("2026-10-22T09:00:00.000Z");

export function photo(n: number, sessionId: string, shot: number, portrait = false): GalleryPhoto {
  clock += 1000;
  return {
    id: `019a0b7e-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
    sessionId,
    shot,
    width: portrait ? 1707 : 2560,
    height: portrait ? 2560 : 1707,
    publishedAt: new Date(clock).toISOString(),
  };
}

export function page(photos: GalleryPhoto[], extra: Partial<GalleryPhotosPage> = {}): GalleryPhotosPage {
  return {
    eventName: "Smith wedding",
    localDate: "2026-10-22",
    eventOpen: true,
    photos,
    nextCursor: null,
    contact: { address: "34b Malvern Road, Morningside, Auckland", email: "privacy@example.invalid" },
    ...extra,
  };
}

export interface Call {
  method: string;
  url: string;
  body: string | null;
}

/** Replaces global fetch with `route`; records every call (path + query only). */
export function mockFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://photos.localhost");
    const call = { method: init?.method ?? "GET", url: url.pathname + url.search, body: (init?.body as string | undefined) ?? null };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

export const notFound = () => json({ code: "not_found", message: "Not found", correlationId: "x" }, 404);

/**
 * happy-dom's history.back() navigates to about:blank; a browser pops the entry and fires
 * popstate. Emulates the browser for one entry pushed on top of the current URL.
 */
export function browserLikeBack(): void {
  history.back = () => {
    history.replaceState(null, "", location.pathname + location.search);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  };
}

/** Puts the page at `path` (happy-dom keeps one window for the whole run). */
export function setUrl(path: string): void {
  (globalThis as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://photos.localhost${path}`);
}
