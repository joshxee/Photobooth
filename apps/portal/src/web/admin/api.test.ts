import { afterEach, describe, expect, it } from "bun:test";
import { ApiError, api, describeError, isNotAuthorised } from "./api";
import { apiError, device, event, json, mockFetch } from "./testing";

let mocked: ReturnType<typeof mockFetch> | null = null;
afterEach(() => mocked?.restore());

describe("request wrapper", () => {
  it("sends JSON with the same-origin credentials the Worker checks", async () => {
    mocked = mockFetch(() => json(event(), 201));
    await api.createEvent({ name: "A", timezone: "UTC", startsAt: "2026-10-24T05:00:00.000Z", endsAt: "2026-10-24T13:00:00.000Z" });
    const call = mocked.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/events");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toEqual({ name: "A", timezone: "UTC", startsAt: "2026-10-24T05:00:00.000Z", endsAt: "2026-10-24T13:00:00.000Z" });
  });

  it("sends {} for the action routes, which need a JSON body", async () => {
    mocked = mockFetch(() => json(event()));
    await api.eventAction("019a0b7e-0000-7000-8000-000000000001", "rotate-link");
    const call = mocked.calls[0]!;
    expect(call.path).toBe("/api/events/019a0b7e-0000-7000-8000-000000000001/rotate-link");
    expect(call.body).toEqual({});
    expect(call.headers["content-type"]).toBe("application/json");
  });

  it("sends no body on GET", async () => {
    mocked = mockFetch(() => json({ events: [] }));
    await api.listEvents();
    expect(mocked.calls[0]).toMatchObject({ method: "GET", path: "/api/events", body: null });
  });

  it("returns the devices list and a code response", async () => {
    mocked = mockFetch((c) =>
      c.method === "GET" ? json({ devices: [device()] }) : json({ deviceId: "d", code: "ABCDEFGH", expiresAt: "2026-10-23T12:10:00.000Z" }, 201),
    );
    expect((await api.listDevices()).devices[0]!.name).toBe("Booth A");
    expect((await api.createDevice("Booth B")).code).toBe("ABCDEFGH");
    expect(mocked.calls[1]).toMatchObject({ method: "POST", path: "/api/devices", body: { name: "Booth B" } });
  });

  it("re-issues a code and revokes through the device routes", async () => {
    mocked = mockFetch(() => json({}));
    await api.reissueCode("dev-1");
    await api.revokeDevice("dev-1");
    expect(mocked.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/devices/dev-1/code", "POST /api/devices/dev-1/revoke"]);
  });

  it("turns an error body into an ApiError with its code, status and correlation ID", async () => {
    mocked = mockFetch(() => apiError(409, "conflict", "The event changed meanwhile; reload and try again."));
    const error = await api.listEvents().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "conflict", correlationId: "11111111-1111-4111-8111-111111111111" });
  });

  it("treats a failed fetch (offline, or an Access login redirect) as a network error", async () => {
    mocked = mockFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await api.listEvents().catch((e: unknown) => e)).toMatchObject({ code: "network", status: 0 });
  });

  it("treats a non-JSON answer (a proxy's HTML page) as an error, not data", async () => {
    mocked = mockFetch(() => new Response("<html>Sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await api.listEvents().catch((e: unknown) => e)).toMatchObject({ code: "network" });
  });

  it("maps a non-JSON error status to a generic error", async () => {
    mocked = mockFetch(() => new Response("bad gateway", { status: 502 }));
    expect(await api.listEvents().catch((e: unknown) => e)).toMatchObject({ code: "internal", status: 502 });
  });
});

describe("describeError", () => {
  const e = (status: number, code: ApiError["code"], message = "server words") => new ApiError(status, code, message, "corr-1");

  it("shows the server's own words for refusals it words for people", () => {
    expect(describeError(e(409, "conflict", "The event changed meanwhile; reload and try again."))).toBe("The event changed meanwhile; reload and try again.");
    expect(describeError(e(409, "conflict", "The device is revoked."))).toBe("The device is revoked.");
  });

  it("explains a malformed request without the server's generic text", () => {
    expect(describeError(e(400, "invalid_request", "The request was not valid."))).toContain("check the form");
  });

  it("explains a missing event or device", () => {
    expect(describeError(e(404, "not_found"))).toContain("no longer exists");
  });

  it("explains authorisation failures", () => {
    expect(describeError(e(401, "unauthorized"))).toContain("not signed in");
    expect(describeError(e(403, "forbidden"))).toContain("not allowed");
  });

  it("asks to wait on rate limits", () => {
    expect(describeError(e(429, "rate_limited"))).toContain("Too many requests");
  });

  it("gives the reference for a server fault so it can be found in the logs", () => {
    expect(describeError(e(500, "internal"))).toContain("corr-1");
  });

  it("says what a network error probably means", () => {
    expect(describeError(new ApiError(0, "network", "", null))).toContain("reload the page");
  });

  it("handles a thrown non-ApiError", () => {
    expect(describeError(new Error("boom"))).toBe("Something went wrong.");
    expect(describeError("x")).toBe("Something went wrong.");
  });
});

describe("isNotAuthorised", () => {
  it("is true for 401 and 403 only", () => {
    expect(isNotAuthorised(new ApiError(401, "unauthorized", "", null))).toBe(true);
    expect(isNotAuthorised(new ApiError(403, "forbidden", "", null))).toBe(true);
    expect(isNotAuthorised(new ApiError(404, "not_found", "", null))).toBe(false);
    expect(isNotAuthorised(new Error("x"))).toBe(false);
  });
});
