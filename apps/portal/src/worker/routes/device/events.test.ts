import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import detailHiddenFixture from "../../../../contract/fixtures/device.event-detail.hidden.json";
import detailLiveFixture from "../../../../contract/fixtures/device.event-detail.live.json";
import eventsEmptyFixture from "../../../../contract/fixtures/device.events-response.empty.json";
import eventsFixture from "../../../../contract/fixtures/device.events-response.valid.json";
import manifest from "../../../../contract/manifest.json";
import { DeviceEventDetail, DeviceEventsResponse, ErrorBody } from "../../../shared/schemas";
import { type DeviceRow, getDevice } from "../../db/devices";
import { type EventRow, insertEvent } from "../../db/events";
import { newDeviceCredential } from "../../domain/ids";
import { adminHeaders, stubAccessCerts } from "../../test/access";
import { deviceHeaders, enrolledDevice, expectFixtureShape, GALLERY } from "../../test/device";
import { eventRow, resetDb, T0 } from "../../test/factories";

const db = env.DB;

function get(path: string, headers: Record<string, string>) {
  return exports.default.fetch(`${GALLERY}/v1/device${path}`, { headers });
}

async function json(res: Response, status = 200): Promise<unknown> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return res.json();
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(ErrorBody.parse(await res.json()).code).toBe("unauthorized");
}

async function insertEvents(...rows: EventRow[]) {
  await db.batch(rows.map((r) => insertEvent(db, r)));
}

/** Pretend the heartbeat was last written `ms` ago. */
async function lastSeen(device: DeviceRow, msAgo: number) {
  await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(new Date(Date.now() - msAgo).toISOString(), device.id).run();
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("device authentication", () => {
  it("refuses a missing, malformed or unknown credential with 401", async () => {
    const { credential } = await enrolledDevice();
    await expectUnauthorized(await get("/events", {}));
    await expectUnauthorized(await get("/events", { Authorization: credential }));
    await expectUnauthorized(await get("/events", { Authorization: `Basic ${credential}` }));
    await expectUnauthorized(await get("/events", { Authorization: `Bearer ${credential.slice(1)}` }));
    await expectUnauthorized(await get("/events", deviceHeaders(newDeviceCredential())));
    await expectUnauthorized(await get(`/events/${crypto.randomUUID()}`, {}));
    expect((await get("/events", deviceHeaders(credential))).status).toBe(200);
  });

  it("takes effect on the next request after an admin revokes the device", async () => {
    stubAccessCerts();
    const { device, credential } = await enrolledDevice();
    expect((await get("/events", deviceHeaders(credential))).status).toBe(200);
    const revoke = await exports.default.fetch(`http://admin.localhost:8787/api/devices/${device.id}/revoke`, {
      method: "POST",
      headers: await adminHeaders(),
      body: "{}",
    });
    expect(revoke.status).toBe(200);
    await expectUnauthorized(await get("/events", deviceHeaders(credential)));
  });

  it("refuses a revoked device whose heartbeat is still fresh, and doesn't record it", async () => {
    const { device, credential } = await enrolledDevice({ revoked_at: T0, last_seen_at: null });
    await expectUnauthorized(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "5" })));
    expect((await getDevice(db, device.id))?.last_seen_at).toBeNull();
  });

  it("answers 401 without the auth details, and never on the admin host", async () => {
    stubAccessCerts();
    const { credential } = await enrolledDevice();
    const res = await get("/events", deviceHeaders(newDeviceCredential()));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).not.toContain(credential);
    const admin = await exports.default.fetch("http://admin.localhost:8787/v1/device/events", {
      headers: { ...(await adminHeaders()), ...deviceHeaders(credential) },
    });
    expect(admin.status).toBe(404);
  });
});

describe("the heartbeat", () => {
  it("records last seen, the clamped backlog and the app version", async () => {
    const { device, credential } = await enrolledDevice();
    const before = Date.now();
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "250000", "X-App-Version": "0.5.0" })));
    const row = await getDevice(db, device.id);
    expect(row).toMatchObject({ last_backlog: 100_000, app_version: "0.5.0" });
    expect(Date.parse(row!.last_seen_at!)).toBeGreaterThanOrEqual(before);
  });

  it("writes at most once a minute per device", async () => {
    const { device, credential } = await enrolledDevice();
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "3" })));
    const first = await getDevice(db, device.id);
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "9", "X-App-Version": "9.9.9" })));
    expect(await getDevice(db, device.id)).toEqual(first);

    await lastSeen(device, 61_000);
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "9" })));
    expect((await getDevice(db, device.id))?.last_backlog).toBe(9);
  });

  it("keeps the stored values when a header is missing or malformed", async () => {
    const { device, credential } = await enrolledDevice({ last_backlog: 4, app_version: "0.4.0" });
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "lots", "X-App-Version": "x".repeat(40) })));
    expect(await getDevice(db, device.id)).toMatchObject({ last_backlog: 4, app_version: "0.4.0" });
    expect((await getDevice(db, device.id))?.last_seen_at).not.toBeNull();
  });

  it("clamps a negative backlog to 0", async () => {
    const { device, credential } = await enrolledDevice();
    await json(await get("/events", deviceHeaders(credential, { "X-Outbox-Depth": "-3" })));
    expect((await getDevice(db, device.id))?.last_backlog).toBe(0);
  });

  it("is recorded on a request that then fails (an unknown event is still a sign of life)", async () => {
    const { device, credential } = await enrolledDevice();
    expect((await get(`/events/${crypto.randomUUID()}`, deviceHeaders(credential, { "X-Outbox-Depth": "2" }))).status).toBe(404);
    expect((await getDevice(db, device.id))?.last_backlog).toBe(2);
  });
});

describe("GET /v1/device/events", () => {
  it("lists only OPEN, non-deleted events inside their upload window, soonest first, in the fixture's shape", async () => {
    const { credential } = await enrolledDevice();
    const later = eventRow({ name: "Ng 40th", venue: "", starts_at: "2026-10-24T05:00:00.000Z", ends_at: "2026-10-24T11:00:00.000Z" });
    const sooner = eventRow({ name: "Smith wedding", venue: "Morningside Hall", starts_at: "2026-10-22T05:00:00.000Z" });
    await insertEvents(
      later,
      sooner,
      eventRow({ upload_status: "CLOSED" }),
      eventRow({ upload_status: "DRAFT" }),
      eventRow({ deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" }),
      eventRow({ uploads_until: new Date(Date.now() - 1000).toISOString() }),
    );

    const res = await get("/events", deviceHeaders(credential));
    expect(res.status).toBe(manifest.fixtures["device.events-response.valid.json"].status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expectFixtureShape(body, eventsFixture);
    expect(DeviceEventsResponse.parse(body)).toEqual({
      events: [
        { id: sooner.id, name: "Smith wedding", venue: "Morningside Hall", timezone: "Pacific/Auckland", localDate: "2026-10-22" },
        { id: later.id, name: "Ng 40th", venue: "", timezone: "Pacific/Auckland", localDate: "2026-10-24" },
      ],
    });
  });

  it("gives the start date in the event's time zone", async () => {
    const { credential } = await enrolledDevice();
    // 11:30 UTC on the 22nd is 00:30 on the 23rd in Auckland.
    await insertEvents(eventRow({ starts_at: "2026-10-22T11:30:00.000Z", ends_at: "2026-10-22T15:00:00.000Z" }));
    const { events } = DeviceEventsResponse.parse(await json(await get("/events", deviceHeaders(credential))));
    expect(events[0]?.localDate).toBe("2026-10-23");
  });

  it("returns an empty list in the empty fixture's shape", async () => {
    const { credential } = await enrolledDevice();
    const body = await json(await get("/events", deviceHeaders(credential)));
    expectFixtureShape(body, eventsEmptyFixture);
    expect(body).toEqual(eventsEmptyFixture);
  });
});

describe("GET /v1/device/events/{id}", () => {
  it("includes the gallery URL with its token when the gallery is LIVE (the live fixture's shape)", async () => {
    const { credential } = await enrolledDevice();
    const event = eventRow({ gallery_status: "LIVE" });
    await insertEvents(event);
    const res = await get(`/events/${event.id}`, deviceHeaders(credential));
    expect(res.status).toBe(manifest.fixtures["device.event-detail.live.json"].status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expectFixtureShape(body, detailLiveFixture);
    expect(DeviceEventDetail.parse(body)).toEqual({
      id: event.id,
      name: event.name,
      venue: event.venue,
      timezone: event.timezone,
      localDate: "2026-10-22",
      uploadStatus: "OPEN",
      galleryStatus: "LIVE",
      galleryUrl: `http://photos.localhost:8787/e/${event.public_id}#k=${event.share_token}`,
    });
  });

  it.each(["HIDDEN", "SUSPENDED"] as const)("hides the gallery URL when the gallery is %s (the hidden fixture's shape)", async (status) => {
    const { credential } = await enrolledDevice();
    const event = eventRow({ gallery_status: status });
    await insertEvents(event);
    const body = await json(await get(`/events/${event.id}`, deviceHeaders(credential)));
    expectFixtureShape(body, detailHiddenFixture);
    expect(DeviceEventDetail.parse(body)).toMatchObject({ galleryStatus: status, galleryUrl: null });
    expect(JSON.stringify(body)).not.toContain(event.share_token);
  });

  it("shows a CLOSED event, and an OPEN one past its upload window as CLOSED", async () => {
    const { credential } = await enrolledDevice();
    const closed = eventRow({ upload_status: "CLOSED" });
    const lapsed = eventRow({ upload_status: "OPEN", uploads_until: new Date(Date.now() - 1000).toISOString() });
    const draft = eventRow({ upload_status: "DRAFT", gallery_status: "HIDDEN" });
    await insertEvents(closed, lapsed, draft);
    for (const [event, status] of [[closed, "CLOSED"], [lapsed, "CLOSED"], [draft, "DRAFT"]] as const) {
      const detail = DeviceEventDetail.parse(await json(await get(`/events/${event.id}`, deviceHeaders(credential))));
      expect(detail.uploadStatus, event.id).toBe(status);
    }
  });

  it("404s for a deleted, unknown or malformed event", async () => {
    const { credential } = await enrolledDevice();
    const deleted = eventRow({ deleted_at: T0, purge_after: "2026-10-29T09:00:00.000Z" });
    await insertEvents(deleted);
    for (const path of [`/events/${deleted.id}`, `/events/${crypto.randomUUID()}`, "/events/not-an-id", "/events/"]) {
      const res = await get(path, deviceHeaders(credential));
      expect(res.status, path).toBe(404);
      expect(ErrorBody.parse(await res.json()).code).toBe("not_found");
    }
  });
});
