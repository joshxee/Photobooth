import { afterEach, describe, expect, test } from "bun:test";

import { createPhotoPrefetcher, photoUrl } from "./photo";

const original = navigator.userAgent;
const setUserAgent = (ua: string) =>
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
afterEach(() => setUserAgent(original));

describe("photoUrl", () => {
  test("Android and Windows WebViews use the http://booth.localhost form", () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pad) AppleWebKit/537.36 Chrome/120");
    expect(photoUrl("abc-1", 2)).toBe("http://booth.localhost/photo/abc-1/2");
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120");
    expect(photoUrl("abc-1", 2)).toBe("http://booth.localhost/photo/abc-1/2");
  });

  test("macOS and Linux use booth://localhost", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605");
    expect(photoUrl("abc-1", 3)).toBe("booth://localhost/photo/abc-1/3");
  });

  test("session ids are URL-encoded", () => {
    setUserAgent("Android");
    expect(photoUrl("a/b c", 1)).toBe("http://booth.localhost/photo/a%2Fb%20c/1");
  });
});

describe("photo prefetcher", () => {
  const big = () => new Blob([new Uint8Array(2_000_000)], { type: "image/jpeg" });

  function rig(
    opts: {
      photo?: () => Promise<Blob>;
      shrink?: (photo: Blob) => Promise<string | null>;
    } = {},
  ) {
    setUserAgent("Android");
    const fetched: string[] = [];
    const shrunk: Blob[] = [];
    const revoked: string[] = [];
    let counter = 0;
    const prefetcher = createPhotoPrefetcher({
      fetchPhoto: async (url) => {
        fetched.push(url);
        return (opts.photo ?? (async () => big()))();
      },
      shrink:
        opts.shrink ??
        (async (photo) => {
          shrunk.push(photo);
          return `blob:small-${(counter += 1)}`;
        }),
      release: (url) => void revoked.push(url),
    });
    return { fetched, shrunk, revoked, prefetcher };
  }

  test("fetches a photo ahead of the strip from the URL the strip would use, then shrinks it", async () => {
    const { fetched, shrunk, prefetcher } = rig();
    await prefetcher.prefetch("s-1", 2);
    expect(fetched).toEqual([photoUrl("s-1", 2)]);
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]!.size).toBe(2_000_000);
  });

  test("asking twice for the same photo does the work once", async () => {
    const { fetched, prefetcher } = rig();
    await Promise.all([
      prefetcher.prefetch("s-1", 1),
      prefetcher.prefetch("s-1", 1),
      prefetcher.prefetch("s-1", 2),
      prefetcher.prefetch("s-2", 1),
    ]);
    expect(prefetcher.size).toBe(3);
    expect(fetched).toHaveLength(3);
  });

  test("the strip gets a small ready copy once there is one, and the original until then", async () => {
    const { prefetcher } = rig();
    const heard: number[] = [];
    prefetcher.subscribe(() => void heard.push(heard.length));

    expect(prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1)); // never heard of it
    const done = prefetcher.prefetch("s-1", 1);
    expect(prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1)); // still working on it
    expect(heard).toHaveLength(0);

    await done;
    expect(prefetcher.urlFor("s-1", 1)).toBe("blob:small-1");
    expect(prefetcher.urlFor("s-1", 2)).toBe(photoUrl("s-1", 2));
    expect(heard).toHaveLength(1);
  });

  test("a photo too small to be worth shrinking is left alone", async () => {
    const { prefetcher, shrunk } = rig({ photo: async () => new Blob([new Uint8Array(50_000)]) });
    await prefetcher.prefetch("s-1", 1);
    expect(shrunk).toHaveLength(0);
    expect(prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));
  });

  test("a photo that cannot be fetched or shrunk falls back to the original and is not an error", async () => {
    const missing = rig({ photo: () => Promise.reject(new Error("photo request failed: 404")) });
    await expect(missing.prefetcher.prefetch("s-1", 1)).resolves.toBeUndefined();
    expect(missing.prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));

    const noShrink = rig({ shrink: () => Promise.resolve(null) });
    await noShrink.prefetcher.prefetch("s-1", 1);
    expect(noShrink.prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));

    const throwing = rig({ shrink: () => Promise.reject(new Error("no createImageBitmap")) });
    await expect(throwing.prefetcher.prefetch("s-1", 1)).resolves.toBeUndefined();
    expect(throwing.prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));
  });

  test("clear() frees the small copies, forgets everything and tells listeners", async () => {
    const { prefetcher, revoked, fetched } = rig();
    await prefetcher.prefetch("s-1", 1);
    await prefetcher.prefetch("s-1", 2);
    let heard = 0;
    prefetcher.subscribe(() => (heard += 1));

    prefetcher.clear();
    expect(revoked.sort()).toEqual(["blob:small-1", "blob:small-2"]);
    expect(prefetcher.size).toBe(0);
    expect(prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));
    expect(heard).toBe(1);

    await prefetcher.prefetch("s-1", 1); // not remembered as done
    expect(fetched).toHaveLength(3);
  });

  test("work that finishes after clear() is discarded, not leaked", async () => {
    let finish: (url: string | null) => void = () => undefined;
    const { prefetcher, revoked } = rig({
      shrink: () => new Promise((resolve) => (finish = resolve)),
    });
    const pending = prefetcher.prefetch("s-1", 1);
    await new Promise((r) => setTimeout(r, 0));
    prefetcher.clear();
    finish("blob:late");
    await pending;
    expect(revoked).toEqual(["blob:late"]);
    expect(prefetcher.urlFor("s-1", 1)).toBe(photoUrl("s-1", 1));
  });

  test("unsubscribing stops notifications", async () => {
    const { prefetcher } = rig();
    let heard = 0;
    const off = prefetcher.subscribe(() => (heard += 1));
    off();
    await prefetcher.prefetch("s-1", 1);
    expect(heard).toBe(0);
  });
});
