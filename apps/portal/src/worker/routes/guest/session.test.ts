import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionRequestFixture from "../../../../contract/fixtures/gallery.session-request.valid.json";
import sessionResponseFixture from "../../../../contract/fixtures/gallery.session-response.valid.json";
import manifest from "../../../../contract/manifest.json";
import { AdminEvent, ErrorBody, GallerySessionRequest, GallerySessionResponse } from "../../../shared/schemas";
import { newPublicId, newShareToken } from "../../domain/ids";
import { adminHeaders, stubAccessCerts } from "../../test/access";
import { expectFixtureShape } from "../../test/device";
import { resetDb } from "../../test/factories";
import { expectGeneric404, freshIp, guestGet, liveEvent, openGallery, postSession } from "../../test/guest";

beforeEach(async () => {
  await resetDb();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

async function adminAction(eventId: string, action: string): Promise<AdminEvent> {
  const res = await exports.default.fetch(`http://admin.localhost:8787/api/events/${eventId}/${action}`, {
    method: "POST",
    headers: await adminHeaders(),
    body: "{}",
  });
  if (res.status !== 200) throw new Error(`${action}: ${res.status} ${await res.text()}`);
  return AdminEvent.parse(await res.json());
}

/** Two refusals are indistinguishable: same status, body (bar the correlation ID) and headers. */
async function comparable(res: Response) {
  const body = ErrorBody.parse(await res.clone().json());
  const headers = [...res.headers].filter(([name]) => !["x-request-id", "content-length"].includes(name)).sort();
  return { status: res.status, code: body.code, message: body.message, headers };
}

describe("POST /e/{publicId}/api/session", () => {
  it("swaps the share token for the event's cookie", async () => {
    const event = await liveEvent();
    const res = await postSession(event.public_id, { token: event.share_token });
    expect(res.status).toBe(manifest.fixtures["gallery.session-response.valid.json"].status);
    const body = await res.json();
    expectFixtureShape(body, sessionResponseFixture);
    expect(GallerySessionResponse.parse(body)).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toMatch(
      new RegExp(
        `^g=${event.id}\\.1\\.[0-9]+\\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=/e/${event.public_id}; HttpOnly; Secure; SameSite=Lax$`,
      ),
    );
    const exp = Number(cookie!.split(";")[0]!.split(".")[2]);
    expect(Math.abs(exp - (Date.now() / 1000 + 2_592_000))).toBeLessThan(60);
  });

  it("accepts the contract's request shape", () => {
    expect(GallerySessionRequest.parse(sessionRequestFixture)).toEqual(sessionRequestFixture);
  });

  it("answers every refusal with the same 404 and no cookie", async () => {
    const event = await liveEvent();
    const other = await liveEvent();
    const suspended = await liveEvent({ gallery_status: "SUSPENDED" });
    const hidden = await liveEvent({ gallery_status: "HIDDEN" });
    const deleted = await liveEvent({ deleted_at: "2026-10-23T00:00:00.000Z", purge_after: "2026-10-30T00:00:00.000Z" });
    const refusals = [
      postSession(event.public_id, { token: newShareToken() }),
      postSession(event.public_id, { token: event.share_token.slice(1) }),
      postSession(event.public_id, { token: `${event.share_token}x` }),
      postSession(event.public_id, { token: other.share_token }),
      postSession(newPublicId(), { token: event.share_token }),
      postSession(event.public_id.toUpperCase(), { token: event.share_token }),
      postSession("not-a-public-id", { token: event.share_token }),
      postSession(suspended.public_id, { token: suspended.share_token }),
      postSession(hidden.public_id, { token: hidden.share_token }),
      postSession(deleted.public_id, { token: deleted.share_token }),
      postSession(event.public_id, "not json"),
      postSession(event.public_id, {}),
      postSession(event.public_id, { token: "" }),
      postSession(event.public_id, { token: event.share_token, extra: 1 }),
      postSession(event.public_id, { token: "x".repeat(4096) }),
      postSession(event.public_id, JSON.stringify({ token: event.share_token, pad: "x".repeat(8192) })),
    ];
    const results = await Promise.all(refusals);
    const first = await comparable(results[0]!);
    for (const res of results) {
      expect(res.headers.get("Set-Cookie")).toBeNull();
      await expectGeneric404(res.clone());
      expect(await comparable(res)).toEqual(first);
    }
  });

  it("still opens a gallery past its upload window (galleries don't expire, D15)", async () => {
    const event = await liveEvent({ upload_status: "CLOSED", uploads_until: "2026-01-01T00:00:00.000Z" });
    expect((await postSession(event.public_id, { token: event.share_token })).status).toBe(200);
  });

  it("refuses the old token right after a rotation and accepts the new one", async () => {
    const event = await liveEvent();
    expect((await postSession(event.public_id, { token: event.share_token })).status).toBe(200);
    const rotated = await adminAction(event.id, "rotate-link");
    const newToken = new URL(rotated.galleryUrl).hash.replace("#k=", "");
    expect(newToken).not.toBe(event.share_token);
    await expectGeneric404(await postSession(event.public_id, { token: event.share_token }));
    const res = await postSession(event.public_id, { token: newToken });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(new RegExp(`^g=${event.id}\\.2\\.`));
  });

  it("refuses a token right after the gallery is suspended", async () => {
    const event = await liveEvent();
    await adminAction(event.id, "suspend");
    await expectGeneric404(await postSession(event.public_id, { token: event.share_token }));
  });

  it("is rate-limited per IP (60 a minute) before the token is checked; other IPs are unaffected", async () => {
    const event = await liveEvent();
    // The local simulation counts in wall-clock minutes, so a run that crosses a minute boundary
    // starts its count again part-way. Such a run is repeated once with a fresh address.
    const run = async () => {
      const ip = freshIp();
      const window = Math.floor(Date.now() / 60_000);
      const statuses: number[] = [];
      for (let i = 0; i < 60; i++) statuses.push((await postSession(event.public_id, { token: "wrong" }, { "CF-Connecting-IP": ip })).status);
      const limited = await postSession(event.public_id, { token: event.share_token }, { "CF-Connecting-IP": ip });
      return { statuses, limited, crossedMinute: Math.floor(Date.now() / 60_000) !== window };
    };
    let result = await run();
    if (result.crossedMinute) result = await run();
    expect(result.crossedMinute).toBe(false);
    expect(result.statuses.every((s) => s === 404)).toBe(true);
    expect(result.limited.status).toBe(429);
    expect(result.limited.headers.get("Retry-After")).toBe("60");
    expect(result.limited.headers.get("Set-Cookie")).toBeNull();
    expect(ErrorBody.parse(await result.limited.json()).code).toBe("rate_limited");
    expect((await postSession(event.public_id, { token: event.share_token })).status).toBe(200);
  });

  it("only answers POST, and only on the gallery host", async () => {
    const event = await liveEvent();
    // A GET under /e/ is the SPA shell's (or a 404 when no build exists); never a session.
    const get = await guestGet(event.public_id, "/api/session");
    expect(get.headers.get("Set-Cookie")).toBeNull();
    await expectGeneric404(get);
    const admin = await exports.default.fetch(`http://admin.localhost:8787/e/${event.public_id}/api/session`, {
      method: "POST",
      headers: { ...(await adminHeaders()), "CF-Connecting-IP": freshIp() },
      body: JSON.stringify({ token: event.share_token }),
    });
    expect(admin.status).toBe(404);
    expect(admin.headers.get("Set-Cookie")).toBeNull();
  });

  it("gives each event its own path-scoped cookie", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const ca = await openGallery(a);
    const cb = await openGallery(b);
    expect(ca).not.toBe(cb);
    expect(ca).toMatch(new RegExp(`^g=${a.id}\\.`));
    expect(cb).toMatch(new RegExp(`^g=${b.id}\\.`));
  });
});
