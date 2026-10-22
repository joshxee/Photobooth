import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminDevice, AdminDeviceList, DeviceCodeResponse, ErrorBody } from "../../../shared/schemas";
import { listAudit } from "../../db/audit";
import { getDevice, insertDevice } from "../../db/devices";
import { hashToken } from "../../domain/tokens";
import { ADMIN_EMAIL, ADMIN_ORIGIN, adminHeaders, stubAccessCerts } from "../../test/access";
import { deviceRow, resetDb, T0 } from "../../test/factories";

const ADMIN = "http://admin.localhost:8787";
const GALLERY = "http://photos.localhost:8787";
const db = env.DB;
const MINUTES_10 = 10 * 60 * 1000;

async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const h = headers ?? (await adminHeaders());
  return exports.default.fetch(`${ADMIN}/api${path}`, {
    method,
    headers: h,
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
}

async function json(res: Response, status: number): Promise<unknown> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return res.json();
}

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(await res.json()).code).toBe(code);
}

async function create(name = "Booth 1"): Promise<DeviceCodeResponse> {
  return DeviceCodeResponse.parse(await json(await api("POST", "/devices", { name }), 201));
}

/** Each call from its own address (10.1.x.x is this file's), so these tests never meet the per-IP enrolment limit. */
let calls = 0;
function enrol(code: string, ip = `10.1.${Math.floor(++calls / 256)}.${calls % 256}`) {
  return exports.default.fetch(`${GALLERY}/v1/device/enrol`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ code, name: "Booth 1", appVersion: "0.4.0" }),
  });
}

const allAudit = () => listAudit(db, { limit: 100 });

beforeEach(async () => {
  await resetDb();
  stubAccessCerts();
});
afterEach(() => vi.restoreAllMocks());

describe("auth on the devices API", () => {
  it("protects every route (401 with no Access token) and refuses a cross-origin POST (403)", async () => {
    const device = await create();
    const noToken = { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" };
    const routes: [string, string][] = [
      ["GET", "/devices"],
      ["POST", "/devices"],
      ["POST", `/devices/${device.deviceId}/code`],
      ["POST", `/devices/${device.deviceId}/revoke`],
    ];
    for (const [method, path] of routes) {
      const res = await api(method, path, method === "GET" ? undefined : { name: "x" }, noToken);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    const crossOrigin = { ...(await adminHeaders()), Origin: "https://evil.example.com" };
    await expectError(await api("POST", "/devices", { name: "x" }, crossOrigin), 403, "forbidden");
    await expectError(await api("POST", `/devices/${device.deviceId}/revoke`, {}, crossOrigin), 403, "forbidden");
    expect((await getDevice(db, device.deviceId))?.revoked_at).toBeNull();
  });

  it("is not served on the gallery host", async () => {
    const res = await exports.default.fetch(`${GALLERY}/api/devices`, { headers: await adminHeaders() });
    await expectError(res, 404, "not_found");
  });
});

describe("create", () => {
  it("returns an 8-character code once, valid 10 minutes, storing only its hash, and audits it", async () => {
    const before = Date.now();
    const res = await api("POST", "/devices", { name: "Front door" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const created = DeviceCodeResponse.parse(await json(res, 201));
    const after = Date.now();
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const expires = Date.parse(created.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + MINUTES_10);
    expect(expires).toBeLessThanOrEqual(after + MINUTES_10);

    const row = await getDevice(db, created.deviceId);
    expect(row).toMatchObject({
      name: "Front door",
      enrol_code_hash: await hashToken(created.code),
      enrol_expires_at: created.expiresAt,
      token_hash: null,
      enrolled_at: null,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(created.code);

    const audit = await allAudit();
    expect(audit).toEqual([
      expect.objectContaining({ actor: ADMIN_EMAIL, action: "device.create", event_id: null, target_id: created.deviceId, detail: { name: "Front door" } }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(created.code);
  });

  it.each([
    ["a missing name", {}],
    ["an empty name", { name: "" }],
    ["a long name", { name: "x".repeat(101) }],
    ["an unknown field", { name: "Booth", code: "ABCDEFGH" }],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    await expectError(await api("POST", "/devices", body), 400, "invalid_request");
    expect(await db.prepare("SELECT id FROM devices").all().then((r) => r.results)).toEqual([]);
    expect(await allAudit()).toEqual([]);
  });

  it("rejects an oversized body with 413", async () => {
    await expectError(await api("POST", "/devices", { name: "x".repeat(70_000) }), 413, "too_large");
  });
});

describe("re-issue a code", () => {
  it("issues a new code and the old one stops working", async () => {
    const created = await create();
    const reissued = DeviceCodeResponse.parse(await json(await api("POST", `/devices/${created.deviceId}/code`), 200));
    expect(reissued.deviceId).toBe(created.deviceId);
    expect(reissued.code).not.toBe(created.code);
    expect((await getDevice(db, created.deviceId))?.enrol_code_hash).toBe(await hashToken(reissued.code));

    expect((await enrol(created.code)).status).toBe(401);
    expect((await enrol(reissued.code)).status).toBe(201);
    const actions = (await allAudit()).map((a) => [a.action, a.target_id]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ["device.create", created.deviceId],
        ["device.code", created.deviceId],
      ]),
    );
  });

  it("works for an enrolled device (re-enrolment replaces its credential)", async () => {
    const created = await create();
    expect((await enrol(created.code)).status).toBe(201);
    const reissued = DeviceCodeResponse.parse(await json(await api("POST", `/devices/${created.deviceId}/code`), 200));
    expect((await getDevice(db, created.deviceId))?.enrolled_at).not.toBeNull();
    expect((await enrol(reissued.code)).status).toBe(201);
  });

  it("404s for an unknown or malformed ID, 409s for a revoked device, and audits neither", async () => {
    const revoked = deviceRow({ revoked_at: T0 });
    await insertDevice(db, revoked).run();
    await expectError(await api("POST", `/devices/${crypto.randomUUID()}/code`), 404, "not_found");
    await expectError(await api("POST", "/devices/not-an-id/code"), 404, "not_found");
    await expectError(await api("POST", `/devices/${revoked.id}/code`), 409, "conflict");
    expect((await getDevice(db, revoked.id))?.enrol_code_hash).toBeNull();
    expect(await allAudit()).toEqual([]);
  });
});

describe("revoke", () => {
  it("revokes, voids a pending code, returns the device and audits it once", async () => {
    const created = await create();
    const revoked = AdminDevice.parse(await json(await api("POST", `/devices/${created.deviceId}/revoke`), 200));
    expect(revoked).toMatchObject({ id: created.deviceId, codeExpiresAt: null });
    expect(revoked.revokedAt).not.toBeNull();
    expect((await enrol(created.code)).status).toBe(401);

    await expectError(await api("POST", `/devices/${created.deviceId}/revoke`), 409, "conflict");
    const revokes = (await allAudit()).filter((a) => a.action === "device.revoke");
    expect(revokes).toEqual([expect.objectContaining({ actor: ADMIN_EMAIL, target_id: created.deviceId, event_id: null })]);
  });

  it("404s for an unknown or malformed ID", async () => {
    await expectError(await api("POST", `/devices/${crypto.randomUUID()}/revoke`), 404, "not_found");
    await expectError(await api("POST", "/devices/x/revoke"), 404, "not_found");
    await expectError(await api("POST", `/devices/${crypto.randomUUID()}/rename`), 404, "not_found");
  });
});

describe("list", () => {
  it("lists every device in creation order with its status, last seen, backlog and app version", async () => {
    const pending = await create("Pending");
    const enrolled = await create("Enrolled");
    expect((await enrol(enrolled.code)).status).toBe(201);
    await db.prepare("UPDATE devices SET last_backlog = 7 WHERE id = ?").bind(enrolled.deviceId).run();
    const revoked = await create("Revoked");
    await json(await api("POST", `/devices/${revoked.deviceId}/revoke`), 200);

    const res = await api("GET", "/devices");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { devices } = AdminDeviceList.parse(await json(res, 200));
    expect(devices.map((d) => d.id)).toEqual([pending.deviceId, enrolled.deviceId, revoked.deviceId]);
    const row = await getDevice(db, enrolled.deviceId);
    expect(devices[0]).toEqual({
      id: pending.deviceId,
      name: "Pending",
      enrolledAt: null,
      revokedAt: null,
      codeExpiresAt: pending.expiresAt,
      lastSeenAt: null,
      lastBacklog: null,
      appVersion: null,
    });
    expect(devices[1]).toEqual({
      id: enrolled.deviceId,
      name: "Booth 1",
      enrolledAt: row!.enrolled_at,
      revokedAt: null,
      codeExpiresAt: null,
      lastSeenAt: row!.last_seen_at,
      lastBacklog: 7,
      appVersion: "0.4.0",
    });
    expect(devices[2]?.revokedAt).not.toBeNull();
    // Never a secret: no code, hash or credential in the list.
    expect(JSON.stringify(devices)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("lists nothing when there are no devices", async () => {
    expect(AdminDeviceList.parse(await json(await api("GET", "/devices"), 200))).toEqual({ devices: [] });
  });
});
