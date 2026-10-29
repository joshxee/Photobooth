// Test helpers for the admin SPA (bun test + happy-dom). Not imported by the app.
import type { AdminDevice, AdminEvent, AdminPhoto, AuditEntry } from "../../shared/schemas";
import type { AdminEnv } from "./env";

export const NOW = Date.parse("2026-10-23T12:00:00.000Z");

export function event(over: Partial<AdminEvent> = {}): AdminEvent {
  return {
    id: "019a0b7e-0000-7000-8000-000000000001",
    publicId: "abcdefghijklmnop",
    name: "Smith wedding",
    venue: "Town Hall",
    timezone: "Pacific/Auckland",
    startsAt: "2026-10-24T05:00:00.000Z",
    endsAt: "2026-10-24T13:00:00.000Z",
    uploadStatus: "DRAFT",
    galleryStatus: "HIDDEN",
    accessVersion: 1,
    photoLimit: 2000,
    uploadsUntil: "2027-01-22T13:00:00.000Z",
    deletedAt: null,
    purgeAfter: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    galleryUrl: "https://photos.example.invalid/e/abcdefghijklmnop#k=TESTTOKEN",
    counts: { pending: 0, ready: 0, rejected: 0, hidden: 0 },
    ...over,
  };
}

export function device(over: Partial<AdminDevice> = {}): AdminDevice {
  return {
    id: "019a0b7e-0000-7000-8000-0000000000d1",
    name: "Booth A",
    enrolledAt: "2026-10-22T00:00:00.000Z",
    revokedAt: null,
    codeExpiresAt: null,
    lastSeenAt: new Date(NOW - 60_000).toISOString(),
    lastBacklog: 0,
    appVersion: "0.1.0",
    ...over,
  };
}

let photoSeq = 0;
/** A READY photo of the default event; IDs count up so the newest-first order is easy to read. */
export function photo(over: Partial<AdminPhoto> = {}): AdminPhoto {
  const n = ++photoSeq;
  return {
    id: `019a0b7e-1000-7000-8000-${String(n).padStart(12, "0")}`,
    eventId: "019a0b7e-0000-7000-8000-000000000001",
    deviceId: "019a0b7e-0000-7000-8000-0000000000d1",
    sessionId: "19a0b6c1-1",
    shot: 1,
    state: "READY",
    rejectReason: null,
    hidden: false,
    width: 2560,
    height: 1707,
    variantBytes: { thumb: 21_000, hd: 416_000 },
    capturedAt: "2026-10-24T06:30:00.000Z",
    publishedAt: "2026-10-24T06:30:02.000Z",
    createdAt: "2026-10-24T06:30:01.000Z",
    ...over,
  };
}

let auditSeq = 0;
export function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  const n = ++auditSeq;
  return {
    id: `019a0b7e-2000-7000-8000-${String(n).padStart(12, "0")}`,
    at: "2026-10-24T06:40:00.000Z",
    actor: "josh@knockbox.nz",
    action: "event.create",
    eventId: "019a0b7e-0000-7000-8000-000000000001",
    targetId: "019a0b7e-0000-7000-8000-000000000001",
    detail: null,
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

/** Replaces global fetch with `route`; records every call. */
export function mockFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://admin.localhost");
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      redirect: init?.redirect,
    };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const apiError = (status: number, code: string, message: string) =>
  json({ code, message, correlationId: "11111111-1111-4111-8111-111111111111" }, status);

/** Puts the page at `path` (happy-dom keeps one window for the whole run). */
export function setUrl(path: string): void {
  (globalThis as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`http://admin.localhost${path}`);
}

/** Lets pending promises and effects settle inside act(). */
export const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A hand-driven clock, timers and visibility, and recorders for downloads and the clipboard. */
export function fakeAdminEnv(start = NOW) {
  let now = start;
  let nextId = 1;
  let visible = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const saved: { filename: string; blob: Blob }[] = [];
  const copied: string[] = [];
  const env: AdminEnv = {
    now: () => now,
    zone: () => "Pacific/Auckland",
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    isVisible: () => visible,
    onVisibilityChange: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    saveFile: (blob, filename) => void saved.push({ filename, blob }),
    copyText: async (text) => void copied.push(text),
    png: async (text) => new Blob([`png:${text}`], { type: "image/png" }),
  };
  return {
    env,
    saved,
    copied,
    timers: () => timers.size,
    /** Runs due timers in order; call inside act(). */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
    },
    async setVisible(v: boolean) {
      visible = v;
      for (const fn of listeners) fn();
      await flush();
    },
  };
}
