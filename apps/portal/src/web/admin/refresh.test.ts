import { describe, expect, it } from "bun:test";
import { REFRESH_MS, startRefresh, type RefreshEnv } from "./refresh";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function fakeEnv() {
  let now = 0;
  let nextId = 1;
  let visible = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const env: RefreshEnv = {
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
  };
  return {
    env,
    timers: () => timers.size,
    async advance(ms: number) {
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
    async setVisible(v: boolean) {
      visible = v;
      for (const fn of listeners) fn();
      await settle();
    },
  };
}

describe("startRefresh", () => {
  it("refreshes every 15 seconds while the page is visible", async () => {
    expect(REFRESH_MS).toBe(15_000);
    const t = fakeEnv();
    let calls = 0;
    startRefresh({ env: t.env, load: async () => void calls++ });
    await t.advance(14_999);
    expect(calls).toBe(0);
    await t.advance(1);
    expect(calls).toBe(1);
    await t.advance(45_000);
    expect(calls).toBe(4);
  });

  it("stops while hidden and refreshes once the moment it is visible again", async () => {
    const t = fakeEnv();
    let calls = 0;
    startRefresh({ env: t.env, load: async () => void calls++ });
    await t.setVisible(false);
    expect(t.timers()).toBe(0);
    await t.advance(120_000);
    expect(calls).toBe(0);
    await t.setVisible(true);
    expect(calls).toBe(1);
    await t.advance(15_000);
    expect(calls).toBe(2);
  });

  it("never overlaps: a slow load delays the next one until it is done", async () => {
    const t = fakeEnv();
    let calls = 0;
    let release: () => void = () => {};
    startRefresh({
      env: t.env,
      load: () => {
        calls++;
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    await t.advance(15_000);
    expect(calls).toBe(1);
    await t.advance(60_000);
    expect(calls).toBe(1);
    release();
    await settle();
    await t.advance(15_000);
    expect(calls).toBe(2);
  });

  it("keeps going after a failed load", async () => {
    const t = fakeEnv();
    let calls = 0;
    startRefresh({
      env: t.env,
      load: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    await t.advance(45_000);
    expect(calls).toBe(3);
  });

  it("stop() cancels the timer and the visibility listener", async () => {
    const t = fakeEnv();
    let calls = 0;
    const stop = startRefresh({ env: t.env, load: async () => void calls++ });
    stop();
    expect(t.timers()).toBe(0);
    await t.setVisible(false);
    await t.setVisible(true);
    await t.advance(60_000);
    expect(calls).toBe(0);
  });

  it("a load that finishes after stop() does not schedule again", async () => {
    const t = fakeEnv();
    let release: () => void = () => {};
    const stop = startRefresh({ env: t.env, load: () => new Promise<void>((resolve) => (release = resolve)) });
    await t.advance(15_000);
    stop();
    release();
    await settle();
    expect(t.timers()).toBe(0);
  });
});
