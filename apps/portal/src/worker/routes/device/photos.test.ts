import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import conflictFixture from "../../../../contract/fixtures/device.intent-response.conflict.json";
import pendingBothFixture from "../../../../contract/fixtures/device.intent-response.pending-both.json";
import pendingHdFixture from "../../../../contract/fixtures/device.intent-response.pending-hd.json";
import readyFixture from "../../../../contract/fixtures/device.intent-response.ready.json";
import rejectedFixture from "../../../../contract/fixtures/device.intent-response.rejected.json";
import manifest from "../../../../contract/manifest.json";
import { ErrorBody, LIMITS, PhotoIntentResponse } from "../../../shared/schemas";
import { getPhoto } from "../../db/photos";
import { verifyUploadUrl } from "../../lib/uploadUrl";
import { enrolledDevice, expectFixtureShape } from "../../test/device";
import { resetDb, T0 } from "../../test/factories";
import { baseline } from "../../test/jpeg";
import { emptyBucket, HD, intent, intentBody, openEvent, postIntent, THUMB, upload, uploadsOf } from "../../test/upload";

const db = env.DB;

async function expectCode(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(await res.json()).code).toBe(code);
}

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
});
afterEach(() => vi.restoreAllMocks());

describe("POST /v1/device/photos: a new photo", () => {
  it("creates a PENDING photo and returns signed URLs for both variants, in the fixture's shape", async () => {
    const { device, credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const res = await postIntent(credential, body);
    expect(res.status).toBe(manifest.fixtures["device.intent-response.pending-both.json"].status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expectFixtureShape(json, pendingBothFixture);
    const response = PhotoIntentResponse.parse(json);
    const { thumb, hd } = uploadsOf(response);
    expect(thumb!.url).toMatch(new RegExp(`^http://photos\\.localhost:8787/v1/device/uploads/${response.photoId}/thumb\\?exp=\\d+&sig=`));
    expect(hd!.url).toContain(`/v1/device/uploads/${response.photoId}/hd?`);
    expect(Date.parse(hd!.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(hd!.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    const row = await getPhoto(db, response.photoId);
    expect(row).toMatchObject({
      event_id: event.id,
      device_id: device.id,
      client_photo_id: body.clientPhotoId,
      session_id: body.sessionId,
      shot: body.shot,
      captured_at: body.capturedAt,
      thumb_sha256: body.variants.thumb.sha256,
      hd_sha256: body.variants.hd.sha256,
      width: 2560,
      height: 1707,
      variant_bytes: { thumb: THUMB.length, hd: HD.length },
      state: "PENDING",
      thumb_stored: 0,
      hd_stored: 0,
    });
    // The URLs are signed for this photo's declared bytes and hashes.
    for (const [variant, d] of [["thumb", thumb!], ["hd", hd!]] as const) {
      const url = new URL(d.url);
      const target = { photoId: response.photoId, variant, ...body.variants[variant] };
      const query = { exp: url.searchParams.get("exp") ?? undefined, sig: url.searchParams.get("sig") ?? undefined };
      expect(await verifyUploadUrl(env.UPLOAD_KEY, target, query, new Date())).toBe("valid");
    }
  });

  it("is idempotent: a duplicate intent returns the same photo with fresh URLs for both variants", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    const second = await intent(credential, body);
    expect(second.photoId).toBe(first.photoId);
    expect(Object.keys(uploadsOf(second)).sort()).toEqual(["hd", "thumb"]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())?.n).toBe(1);
  });

  it("keys idempotency by device: two devices may use the same clientPhotoId", async () => {
    const a = await enrolledDevice();
    const b = await enrolledDevice({ name: "Booth 2" });
    const event = await openEvent();
    const body = await intentBody(event.id);
    const fromA = await intent(a.credential, body);
    const fromB = await intent(b.credential, body);
    expect(fromB.photoId).not.toBe(fromA.photoId);
  });

  it("409 conflict for the same clientPhotoId with different hashes, sizes or event", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const other = await openEvent();
    const body = await intentBody(event.id);
    await intent(credential, body);
    const variants = (patch: object) => ({ ...body, variants: { ...body.variants, ...patch } });
    for (const changed of [
      variants({ thumb: { ...body.variants.thumb, sha256: "0".repeat(64) } }),
      variants({ hd: { ...body.variants.hd, sha256: "0".repeat(64) } }),
      variants({ hd: { ...body.variants.hd, bytes: body.variants.hd.bytes + 1 } }),
      { ...body, width: 2559 },
      { ...body, eventId: other.id },
    ]) {
      const res = await postIntent(credential, changed);
      expect(res.status).toBe(manifest.fixtures["device.intent-response.conflict.json"].status);
      const json = await res.json();
      expectFixtureShape(json, conflictFixture);
      expect(ErrorBody.parse(json).code).toBe("conflict");
    }
  });

  it("413 too_large over the byte caps; exactly at the caps is accepted", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const sized = (thumb: number, hd: number) => ({
      ...body,
      clientPhotoId: crypto.randomUUID(),
      variants: { thumb: { ...body.variants.thumb, bytes: thumb }, hd: { ...body.variants.hd, bytes: hd } },
    });
    await expectCode(await postIntent(credential, sized(LIMITS.thumbMaxBytes + 1, 1000)), 413, "too_large");
    await expectCode(await postIntent(credential, sized(1000, LIMITS.hdMaxBytes + 1)), 413, "too_large");
    expect((await postIntent(credential, sized(LIMITS.thumbMaxBytes, LIMITS.hdMaxBytes))).status).toBe(200);
  });

  it("400 invalid_request for an HD long edge over 2560, an unknown field, a bad UUID or a non-JSON body", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    await expectCode(await postIntent(credential, { ...body, width: 2561 }), 400, "invalid_request");
    await expectCode(await postIntent(credential, { ...body, height: 2561 }), 400, "invalid_request");
    await expectCode(await postIntent(credential, { ...body, extra: 1 }), 400, "invalid_request");
    await expectCode(await postIntent(credential, { ...body, clientPhotoId: "not-a-uuid" }), 400, "invalid_request");
    await expectCode(await postIntent(credential, "{"), 400, "invalid_request");
  });

  it("413 for a body over 4 KB", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    await expectCode(await postIntent(credential, JSON.stringify(body) + " ".repeat(5000)), 413, "too_large");
  });

  it("401 without a device credential, or for a revoked device", async () => {
    const event = await openEvent();
    const body = await intentBody(event.id);
    await expectCode(await postIntent("not-a-credential", body), 401, "unauthorized");
    const { credential } = await enrolledDevice({ revoked_at: T0 });
    await expectCode(await postIntent(credential, body), 401, "unauthorized");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())?.n).toBe(0);
  });
});

describe("POST /v1/device/photos: the event", () => {
  it("404 not_found for an unknown event", async () => {
    const { credential } = await enrolledDevice();
    await expectCode(await postIntent(credential, await intentBody(crypto.randomUUID())), 404, "not_found");
  });

  it("409 event_closed for a new photo in a CLOSED, DRAFT or deleted event, or one past uploads_until", async () => {
    const { credential } = await enrolledDevice();
    for (const event of [
      await openEvent({ upload_status: "CLOSED" }),
      await openEvent({ upload_status: "DRAFT" }),
      await openEvent({ deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" }),
      await openEvent({ uploads_until: new Date(Date.now() - 1000).toISOString() }),
    ]) {
      await expectCode(await postIntent(credential, await intentBody(event.id)), 409, "event_closed");
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())?.n).toBe(0);
  });

  it("closing blocks new intents only: an accepted photo's re-intent still gets fresh URLs (DESIGN §9.2)", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    await db.prepare("UPDATE events SET upload_status = 'CLOSED' WHERE id = ?").bind(event.id).run();
    const again = await intent(credential, body);
    expect(again.photoId).toBe(first.photoId);
    expect(Object.keys(uploadsOf(again)).sort()).toEqual(["hd", "thumb"]);
    // …and the same after the upload window has passed.
    await db.prepare("UPDATE events SET upload_status = 'OPEN', uploads_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), event.id).run();
    expect((await intent(credential, body)).photoId).toBe(first.photoId);
    // A mismatched re-intent into a closed event is still a conflict, not event_closed.
    await expectCode(await postIntent(credential, { ...body, width: 2000 }), 409, "conflict");
  });

  it("a deleted event refuses even an accepted photo's re-intent", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    await intent(credential, body);
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(T0, "2026-10-29T09:00:00.000Z", event.id).run();
    await expectCode(await postIntent(credential, body), 409, "event_closed");
  });

  it("409 photo_limit at the event's limit; a retry of an accepted photo still works", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent({ photo_limit: 1 });
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    await expectCode(await postIntent(credential, await intentBody(event.id)), 409, "photo_limit");
    expect((await intent(credential, body)).photoId).toBe(first.photoId);
  });
});

describe("POST /v1/device/photos: an existing photo's state", () => {
  it("READY: nothing to upload, in the fixture's shape", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    const { thumb, hd } = uploadsOf(first);
    expect((await upload(thumb!, THUMB)).status).toBe(200);
    expect((await upload(hd!, HD)).status).toBe(201);
    const res = await postIntent(credential, body);
    expect(res.status).toBe(manifest.fixtures["device.intent-response.ready.json"].status);
    const json = await res.json();
    expectFixtureShape(json, readyFixture);
    expect(json).toEqual({ state: "READY", photoId: first.photoId });
  });

  it("PENDING with the thumb stored: returns only the hd URL, in the fixture's shape", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    expect((await upload(uploadsOf(first).thumb!, THUMB)).status).toBe(200);
    const res = await postIntent(credential, body);
    expect(res.status).toBe(manifest.fixtures["device.intent-response.pending-hd.json"].status);
    const json = await res.json();
    expectFixtureShape(json, pendingHdFixture);
    expect(Object.keys(uploadsOf(PhotoIntentResponse.parse(json)))).toEqual(["hd"]);
  });

  it("REJECTED: returns the reason and no URLs, in the fixture's shape", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const wrongSize = baseline(2560, 1700);
    const body = await intentBody(event.id, { hd: wrongSize });
    const first = await intent(credential, body);
    expect((await upload(uploadsOf(first).hd!, wrongSize)).status).toBe(422);
    const res = await postIntent(credential, body);
    expect(res.status).toBe(manifest.fixtures["device.intent-response.rejected.json"].status);
    const json = await res.json();
    expectFixtureShape(json, rejectedFixture);
    expect(json).toEqual({ state: "REJECTED", photoId: first.photoId, reason: "hd is 2560×1700, declared 2560×1707" });
  });

  it("PENDING with both variants stored (event deleted then restored mid-upload): a re-intent publishes it", async () => {
    const { credential } = await enrolledDevice();
    const event = await openEvent();
    const body = await intentBody(event.id);
    const first = await intent(credential, body);
    expect((await upload(uploadsOf(first).thumb!, THUMB)).status).toBe(200);
    // The event was deleted between the hd's checks and its publish (processPhoto.test.ts covers
    // that race); the row is left with both variants stored, still PENDING.
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(T0, "2026-10-29T09:00:00.000Z", event.id).run();
    await db.prepare("UPDATE photos SET hd_stored = 1 WHERE id = ?").bind(first.photoId).run();
    await db.prepare("UPDATE events SET deleted_at = NULL, purge_after = NULL WHERE id = ?").bind(event.id).run();
    expect(await intent(credential, body)).toEqual({ state: "READY", photoId: first.photoId });
  });
});

describe("POST /v1/device/photos: rate limit", () => {
  it("is keyed by device ID; a refusal is 429 with Retry-After and writes nothing", async () => {
    const { device, credential } = await enrolledDevice();
    const event = await openEvent();
    const limit = vi.spyOn(env.INTENT_LIMITER, "limit");
    await intent(credential, await intentBody(event.id));
    expect(limit).toHaveBeenCalledWith({ key: device.id });
    limit.mockResolvedValue({ success: false });
    const res = await postIntent(credential, await intentBody(event.id));
    await expectCode(res, 429, "rate_limited");
    expect(res.headers.get("Retry-After")).toBe("60");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>())?.n).toBe(1);
  });

  it("allows 120 intents a minute per device (the local simulation of the binding)", async () => {
    const event = await openEvent();
    // The simulation counts in wall-clock minutes, so a run that crosses a minute boundary starts
    // its count again part-way. Such a run is repeated once with a fresh device (a fresh key).
    const run = async () => {
      const { credential } = await enrolledDevice();
      const body = await intentBody(event.id);
      const window = Math.floor(Date.now() / 60_000);
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++) statuses.push((await postIntent(credential, body)).status);
      return { statuses, crossedMinute: Math.floor(Date.now() / 60_000) !== window };
    };
    let result = await run();
    if (result.crossedMinute) result = await run();
    expect(result.crossedMinute).toBe(false);
    expect(result.statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(result.statuses[120]).toBe(429);
  });
});
