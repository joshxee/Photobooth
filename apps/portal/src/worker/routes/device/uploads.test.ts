import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import readyFixture from "../../../../contract/fixtures/device.upload-response.ready.json";
import storedFixture from "../../../../contract/fixtures/device.upload-response.stored.json";
import invalidImageFixture from "../../../../contract/fixtures/error.body.invalid_image.json";
import hashMismatchFixture from "../../../../contract/fixtures/error.body.hash_mismatch.json";
import expiredFixture from "../../../../contract/fixtures/error.body.upload_expired.json";
import manifest from "../../../../contract/manifest.json";
import { ErrorBody, type UploadDescriptor, UploadResponse } from "../../../shared/schemas";
import { getPhoto } from "../../db/photos";
import { variantKey } from "../../domain/media";
import { hmacUploadSigner } from "../../lib/uploadUrl";
import { enrolledDevice, expectFixtureShape } from "../../test/device";
import { resetDb, T0 } from "../../test/factories";
import { baseline, concat, gpsExifSegment, insertAfter, retag } from "../../test/jpeg";
import { emptyBucket, HD, intent, intentBody, listKeys, openEvent, THUMB, upload, uploadsOf } from "../../test/upload";

const db = env.DB;

async function expectCode(res: Response, status: number, code: string, fixture?: unknown) {
  const json = await res.json();
  expect({ status: res.status, code: ErrorBody.parse(json).code }).toEqual({ status, code });
  if (fixture) expectFixtureShape(json, fixture);
}

/** An enrolled device, an open event and an accepted intent for `thumb` and `hd`. */
async function accepted(thumb = THUMB, hd = HD, sizes: { width?: number; height?: number } = {}) {
  const { device, credential } = await enrolledDevice();
  const event = await openEvent();
  const body = await intentBody(event.id, { thumb, hd, ...sizes });
  const response = await intent(credential, body);
  const { thumb: thumbUrl, hd: hdUrl } = uploadsOf(response);
  return { device, credential, event, body, photoId: response.photoId, urls: { thumb: thumbUrl!, hd: hdUrl! } };
}

function withQuery(d: UploadDescriptor, patch: (url: URL) => void): UploadDescriptor {
  const url = new URL(d.url);
  patch(url);
  return { ...d, url: url.toString() };
}

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PUT /v1/device/uploads/{photoId}/{variant}: the happy path", () => {
  it("thumb → 200 STORED, hd → 201 READY, in the fixtures' shapes, both objects at their keys", async () => {
    const { event, photoId, urls } = await accepted();
    const first = await upload(urls.thumb, THUMB);
    expect(first.status).toBe(manifest.fixtures["device.upload-response.stored.json"].status);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const stored = await first.json();
    expectFixtureShape(stored, storedFixture);
    expect(UploadResponse.parse(stored)).toEqual({ state: "STORED", photoId, variant: "thumb" });

    const second = await upload(urls.hd, HD);
    expect(second.status).toBe(manifest.fixtures["device.upload-response.ready.json"].status);
    const ready = await second.json();
    expectFixtureShape(ready, readyFixture);
    expect(ready).toEqual({ state: "READY", photoId });

    expect(await listKeys()).toEqual([variantKey(event.id, photoId, "hd"), variantKey(event.id, photoId, "thumb")].sort());
    const object = await env.MEDIA.get(variantKey(event.id, photoId, "hd"));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(HD);
    expect(object!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(await getPhoto(db, photoId)).toMatchObject({ state: "READY", thumb_stored: 1, hd_stored: 1 });
  });

  it("hd → 200 STORED, thumb → 201 READY (either order)", async () => {
    const { photoId, urls } = await accepted();
    const first = await upload(urls.hd, HD);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ state: "STORED", photoId, variant: "hd" });
    expect((await upload(urls.thumb, THUMB)).status).toBe(201);
  });

  it("the booth encoder's real output (committed pair) is accepted", async () => {
    const files = import.meta.glob<string>("../../../../scripts/fixtures/booth-*.jpg", { query: "?inline", import: "default", eager: true });
    const bytes = (name: string) => {
      const dataUrl = files[`../../../../scripts/fixtures/booth-${name}.jpg`]!;
      return Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    };
    const thumb = bytes("thumb");
    const hd = bytes("hd");
    const { urls } = await accepted(thumb, hd, { width: 2560, height: 1707 });
    expect((await upload(urls.thumb, thumb)).status).toBe(200);
    expect((await upload(urls.hd, hd)).status).toBe(201);
  });

  it("the same PUT twice: one READY, identical keys, the object unchanged", async () => {
    const { event, photoId, urls } = await accepted();
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    expect((await upload(urls.hd, HD)).status).toBe(201);
    const etag = (await env.MEDIA.head(variantKey(event.id, photoId, "hd")))!.etag;
    const again = await upload(urls.hd, HD);
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ state: "READY", photoId });
    expect(await listKeys()).toHaveLength(2);
    expect((await env.MEDIA.head(variantKey(event.id, photoId, "hd")))!.etag).toBe(etag);
  });

  it("two concurrent PUTs of the last variant: one READY, no error", async () => {
    const { photoId, urls } = await accepted();
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    const [a, b] = await Promise.all([upload(urls.hd, HD), upload(urls.hd, HD)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([await a.json(), await b.json()]).toEqual([{ state: "READY", photoId }, { state: "READY", photoId }]);
    expect((await getPhoto(db, photoId))?.state).toBe("READY");
    expect(await listKeys()).toHaveLength(2);
  });

  it("closing uploads doesn't strand an accepted photo: its PUTs still finish (DESIGN §9.2)", async () => {
    const { event, urls } = await accepted();
    await db.prepare("UPDATE events SET upload_status = 'CLOSED', uploads_until = ? WHERE id = ?").bind(T0, event.id).run();
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    expect((await upload(urls.hd, HD)).status).toBe(201);
  });

  it("needs no bearer and ignores one: the signed URL is the authorisation", async () => {
    const { urls } = await accepted();
    expect((await upload(urls.thumb, THUMB, { Authorization: "Bearer nonsense" })).status).toBe(200);
  });
});

describe("PUT: the signed URL", () => {
  it("403 forbidden for a tampered photoId, variant, signature or expiry, or a missing query", async () => {
    const { photoId, urls } = await accepted();
    const other = await intent((await enrolledDevice({ name: "Booth 2" })).credential, await intentBody((await openEvent()).id));
    const swapPhoto = withQuery(urls.thumb, (u) => (u.pathname = u.pathname.replace(photoId, other.photoId)));
    const swapVariant = { ...urls.thumb, url: urls.thumb.url.replace("/thumb?", "/hd?") };
    const tamperedSig = withQuery(urls.thumb, (u) => u.searchParams.set("sig", `${u.searchParams.get("sig")!.startsWith("A") ? "B" : "A"}${u.searchParams.get("sig")!.slice(1)}`));
    const laterExp = withQuery(urls.thumb, (u) => u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 3600)));
    const noSig = withQuery(urls.thumb, (u) => u.searchParams.delete("sig"));
    const noQuery = withQuery(urls.thumb, (u) => (u.search = ""));
    for (const d of [swapPhoto, swapVariant, tamperedSig, laterExp, noSig, noQuery]) {
      await expectCode(await upload(d, THUMB), 403, "forbidden");
    }
    expect(await listKeys()).toEqual([]);
  });

  it("403 for a URL signed for other bytes or another hash (the photo row is the source of truth)", async () => {
    const { photoId } = await accepted();
    const signer = hmacUploadSigner(env.UPLOAD_KEY, "http://photos.localhost:8787");
    const now = new Date();
    const otherBytes = await signer.sign({ photoId, variant: "thumb", bytes: THUMB.length + 1, sha256: "a".repeat(64) }, now);
    await expectCode(await upload(otherBytes, concat(THUMB, [0])), 403, "forbidden");
    expect(await listKeys()).toEqual([]);
  });

  it("403 for an unknown photo (the same answer as a bad signature)", async () => {
    const { urls, photoId } = await accepted();
    const missing = withQuery(urls.thumb, (u) => (u.pathname = u.pathname.replace(photoId, crypto.randomUUID())));
    await expectCode(await upload(missing, THUMB), 403, "forbidden");
  });

  it("404 for a malformed photo ID or an unknown variant", async () => {
    const { urls, photoId } = await accepted();
    await expectCode(await upload(withQuery(urls.thumb, (u) => (u.pathname = u.pathname.replace(photoId, "nope"))), THUMB), 404, "not_found");
    await expectCode(await upload(withQuery(urls.thumb, (u) => (u.pathname = u.pathname.replace("/thumb", "/full"))), THUMB), 404, "not_found");
  });

  it("410 upload_expired after 15 minutes, in the fixture's shape; nothing stored", async () => {
    const { urls } = await accepted();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(urls.thumb.expiresAt));
    const res = await upload(urls.thumb, THUMB);
    expect(res.status).toBe(manifest.fixtures["error.body.upload_expired.json"].status);
    await expectCode(res, 410, "upload_expired", expiredFixture);
    expect(await listKeys()).toEqual([]);
  });

  it("only PUT is routed", async () => {
    const { urls } = await accepted();
    expect((await exports.default.fetch(urls.thumb.url, { method: "POST", body: THUMB })).status).toBe(404);
    expect((await exports.default.fetch(urls.thumb.url)).status).toBe(404);
  });
});

describe("PUT: the body", () => {
  it("400 when the length differs from the declared bytes; nothing stored", async () => {
    const { urls } = await accepted();
    await expectCode(await upload(urls.thumb, concat(THUMB, [0])), 400, "invalid_request");
    await expectCode(await upload(urls.thumb, THUMB.subarray(0, THUMB.length - 1)), 400, "invalid_request");
    expect(await listKeys()).toEqual([]);
  });

  it("400 for a content type other than image/jpeg; nothing stored", async () => {
    const { urls } = await accepted();
    for (const type of ["image/png", "application/octet-stream", "image/jpg"]) {
      await expectCode(await upload(urls.thumb, THUMB, { "Content-Type": type }), 400, "invalid_request");
    }
    expect(await listKeys()).toEqual([]);
  });

  it("422 hash_mismatch for the right length but other bytes, in the fixture's shape; nothing stored", async () => {
    const { photoId, urls } = await accepted();
    const tampered = THUMB.slice();
    tampered[100] = tampered[100]! ^ 0xff;
    const res = await upload(urls.thumb, tampered);
    expect(res.status).toBe(manifest.fixtures["error.body.hash_mismatch.json"].status);
    await expectCode(res, 422, "hash_mismatch", hashMismatchFixture);
    expect(await listKeys()).toEqual([]);
    expect((await getPhoto(db, photoId))?.state).toBe("PENDING");
    // The booth retries with the right bytes.
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
  });
});

describe("PUT: the device and the event", () => {
  it("401 for a revoked device, even with a valid URL; nothing stored", async () => {
    const { device, urls } = await accepted();
    await db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(T0, device.id).run();
    await expectCode(await upload(urls.thumb, THUMB), 401, "unauthorized");
    expect(await listKeys()).toEqual([]);
  });

  it("409 event_closed for a deleted event; nothing stored", async () => {
    const { event, urls } = await accepted();
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(T0, "2026-10-29T09:00:00.000Z", event.id).run();
    await expectCode(await upload(urls.thumb, THUMB), 409, "event_closed");
    expect(await listKeys()).toEqual([]);
  });

  it("an event deleted between the two variants: no READY", async () => {
    const { event, photoId, urls } = await accepted();
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(T0, "2026-10-29T09:00:00.000Z", event.id).run();
    await expectCode(await upload(urls.hd, HD), 409, "event_closed");
    expect((await getPhoto(db, photoId))?.state).toBe("PENDING");
  });
});

describe("PUT: validation (the header walk)", () => {
  it("422 invalid_image for a metadata-bearing variant, in the fixture's shape; object deleted, photo REJECTED", async () => {
    const bad = insertAfter(THUMB, [gpsExifSegment()]);
    const { photoId, urls } = await accepted(bad);
    const res = await upload(urls.thumb, bad);
    await expectCode(res.clone(), 422, "invalid_image", invalidImageFixture);
    expect(ErrorBody.parse(await res.json()).message).toContain("segment 0xe1 not allowed");
    expect(await listKeys()).toEqual([]);
    expect(await getPhoto(db, photoId)).toMatchObject({ state: "REJECTED", reject_reason: "segment 0xe1 not allowed" });
  });

  it("a REJECTED photo: every later PUT is 422 without writing, and the valid variant never publishes", async () => {
    const progressive = retag(HD, 0xc0, 0xc2);
    const { photoId, urls } = await accepted(THUMB, progressive);
    await expectCode(await upload(urls.hd, progressive), 422, "invalid_image");
    await expectCode(await upload(urls.thumb, THUMB), 422, "invalid_image");
    await expectCode(await upload(urls.hd, progressive), 422, "invalid_image");
    expect(await listKeys()).toEqual([]);
    expect((await getPhoto(db, photoId))?.state).toBe("REJECTED");
  });

  it("an hd whose SOF size differs from the declared size, or a thumb over 480 px: REJECTED, object deleted", async () => {
    const hd = baseline(2000, 1333);
    const first = await accepted(THUMB, hd);
    await expectCode(await upload(first.urls.hd, hd), 422, "invalid_image");
    expect(await listKeys()).toEqual([]);

    await resetDb();
    const thumb = baseline(640, 427);
    const second = await accepted(thumb);
    await expectCode(await upload(second.urls.thumb, thumb), 422, "invalid_image");
    expect(await listKeys()).toEqual([]);
    expect((await getPhoto(db, second.photoId))?.reject_reason).toBe("thumb long edge is 640 px, over 480");
  });

  it("trailing data, a missing EOI and a PNG are rejected the same way", async () => {
    for (const bad of [concat(THUMB, [0x00, 0x01]), THUMB.subarray(0, THUMB.length - 2), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])]) {
      await resetDb();
      const { urls } = await accepted(bad);
      await expectCode(await upload(urls.thumb, bad), 422, "invalid_image");
      expect(await listKeys()).toEqual([]);
    }
  });
});

describe("PUT: logging", () => {
  it("logs the device, event and photo IDs but never the signature or query", async () => {
    const { device, event, photoId, urls } = await accepted();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    expect((await upload(urls.thumb, THUMB)).status).toBe(200);
    const access = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.method === "PUT");
    expect(access).toMatchObject({ deviceId: device.id, eventId: event.id, photoId, status: 200, path: `/v1/device/uploads/${photoId}/thumb` });
    const sig = new URL(urls.thumb.url).searchParams.get("sig")!;
    expect(lines.join("\n")).not.toContain(sig);
  });

  it("logs the device ID on an intent", async () => {
    const { device, credential } = await enrolledDevice();
    const event = await openEvent();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => lines.push(line));
    const body = await intentBody(event.id);
    const res = await intent(credential, body);
    const access = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.method === "POST");
    expect(access).toMatchObject({ deviceId: device.id, eventId: event.id, photoId: res.photoId, path: "/v1/device/photos" });
  });
});
