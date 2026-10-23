import { describe, expect, it } from "bun:test";
import { cleanUrl, parseLink, viewUrl } from "./link";

describe("parseLink", () => {
  it("reads the event, token, session and expected shot count from the booth's link", () => {
    expect(parseLink("/e/seedopenlive2222", "", "#k=abc_DEF-1&s=6a3f1c20-3&n=3")).toEqual({
      publicId: "seedopenlive2222",
      token: "abc_DEF-1",
      session: "6a3f1c20-3",
      expected: 3,
    });
  });

  it("takes the session filter from ?s= once the fragment is gone", () => {
    expect(parseLink("/e/seedopenlive2222/", "?s=6a3f1c20-3&n=4", "")).toEqual({
      publicId: "seedopenlive2222",
      token: null,
      session: "6a3f1c20-3",
      expected: 4,
    });
  });

  it("has no token, session or count for the plain event link", () => {
    expect(parseLink("/e/seedopenlive2222", "", "")).toEqual({ publicId: "seedopenlive2222", token: null, session: null, expected: null });
  });

  it("ignores a count outside 1–10 and a malformed session", () => {
    const link = parseLink("/e/seedopenlive2222", "", "#k=t&s=bad%20id&n=99");
    expect(link?.session).toBeNull();
    expect(link?.expected).toBeNull();
  });

  it("returns null for a path that isn't an event", () => {
    expect(parseLink("/", "", "#k=t")).toBeNull();
    expect(parseLink("/e/", "", "")).toBeNull();
    expect(parseLink("/e/a/b", "", "")).toBeNull();
  });
});

describe("cleanUrl", () => {
  it("drops the fragment and keeps the session filter as a query", () => {
    const link = parseLink("/e/p1", "", "#k=secret&s=6a3f1c20-3&n=3");
    if (!link) throw new Error("no link");
    expect(cleanUrl(link)).toBe("/e/p1?s=6a3f1c20-3&n=3");
    expect(cleanUrl(link)).not.toContain("secret");
  });

  it("is the bare event path without a session", () => {
    expect(viewUrl("p1", null, null)).toBe("/e/p1");
    expect(viewUrl("p1", "6a3f1c20-3", null)).toBe("/e/p1?s=6a3f1c20-3");
  });
});
