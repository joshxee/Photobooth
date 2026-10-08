import { afterEach, describe, expect, test } from "bun:test";

import { photoUrl } from "./photo";

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
