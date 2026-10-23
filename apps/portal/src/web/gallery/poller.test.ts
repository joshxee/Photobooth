import { describe, expect, it } from "bun:test";
import { createPoller, pollDelay } from "./poller";
import { fakeEnv } from "./testing";

describe("pollDelay", () => {
  it("is 30 s ± 10 % in the event view", () => {
    expect(pollDelay(false, 0, 0)).toBe(27_000);
    expect(pollDelay(false, 0, 0.5)).toBe(30_000);
    expect(pollDelay(false, 0, 0.999_999)).toBeLessThanOrEqual(33_000);
  });

  it("is 10 s ± 10 % for the session view's first 2 minutes, then 30 s", () => {
    expect(pollDelay(true, 0, 0.5)).toBe(10_000);
    expect(pollDelay(true, 119_999, 0.5)).toBe(10_000);
    expect(pollDelay(true, 120_000, 0.5)).toBe(30_000);
    expect(pollDelay(true, 60_000, 0)).toBe(9_000);
  });
});

describe("createPoller", () => {
  it("polls every 30 s while visible and the event is open", async () => {
    const f = fakeEnv();
    let polls = 0;
    const poller = createPoller({ env: f.env, fast: false, poll: async () => void polls++ });
    poller.start();
    await f.advance(29_999);
    expect(polls).toBe(0);
    await f.advance(1);
    expect(polls).toBe(1);
    await f.advance(90_000);
    expect(polls).toBe(4);
    poller.stop();
  });

  it("stops while hidden and polls once as soon as the page is visible again", async () => {
    const f = fakeEnv();
    let polls = 0;
    const poller = createPoller({ env: f.env, fast: false, poll: async () => void polls++ });
    poller.start();
    await f.setVisible(false);
    expect(f.pending()).toBe(0);
    await f.advance(600_000);
    expect(polls).toBe(0);
    await f.setVisible(true);
    expect(polls).toBe(1);
    await f.advance(30_000);
    expect(polls).toBe(2);
    poller.stop();
  });

  it("doesn't start while hidden", async () => {
    const f = fakeEnv();
    await f.setVisible(false);
    let polls = 0;
    createPoller({ env: f.env, fast: false, poll: async () => void polls++ }).start();
    await f.advance(120_000);
    expect(polls).toBe(0);
  });

  it("stops for good once a poll reports the event closed", async () => {
    const f = fakeEnv();
    let polls = 0;
    const poller = createPoller({ env: f.env, fast: false, poll: async () => (++polls >= 2 ? "stop" : undefined) });
    poller.start();
    await f.advance(300_000);
    expect(polls).toBe(2);
    await f.setVisible(false);
    await f.setVisible(true);
    expect(polls).toBe(2);
    expect(f.pending()).toBe(0);
  });

  it("switches the session view from 10 s to 30 s after 2 minutes", async () => {
    const f = fakeEnv();
    const at: number[] = [];
    const poller = createPoller({ env: f.env, fast: true, poll: async () => void at.push(f.env.now()) });
    poller.start();
    await f.advance(200_000);
    expect(at.slice(0, 12)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 110_000, 120_000]);
    expect(at[12]).toBe(150_000);
    expect(at[13]).toBe(180_000);
    poller.stop();
  });

  it("never runs two polls at once", async () => {
    const f = fakeEnv();
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | undefined;
    const poller = createPoller({
      env: f.env,
      fast: false,
      poll: () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<undefined>((resolve) => {
          release = () => {
            inFlight--;
            resolve(undefined);
          };
        });
      },
    });
    poller.start();
    await f.advance(30_000);
    await f.setVisible(false);
    await f.setVisible(true);
    expect(maxInFlight).toBe(1);
    release?.();
    poller.stop();
  });

  it("removes its timer and listener on stop", async () => {
    const f = fakeEnv();
    let polls = 0;
    const poller = createPoller({ env: f.env, fast: false, poll: async () => void polls++ });
    poller.start();
    poller.stop();
    await f.setVisible(false);
    await f.setVisible(true);
    await f.advance(120_000);
    expect(polls).toBe(0);
  });
});
