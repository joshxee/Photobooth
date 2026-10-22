import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import enrolResponseFixture from "../../../../contract/fixtures/device.enrol-response.valid.json";
import manifest from "../../../../contract/manifest.json";
import { EnrolResponse, ErrorBody } from "../../../shared/schemas";
import { listAudit } from "../../db/audit";
import { getDevice, insertDevice, revokeDevice, setEnrolCode } from "../../db/devices";
import { newEnrolCode } from "../../domain/ids";
import { hashToken } from "../../domain/tokens";
import { deviceRow, resetDb } from "../../test/factories";
import { deviceHeaders, expectFixtureShape, GALLERY } from "../../test/device";

const db = env.DB;
const IN_10_MIN = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

/** Each test from its own addresses (10.2.x.x is this file's), so the limiter's state never leaks between tests. */
let ips = 0;
const freshIp = () => `10.2.${Math.floor(++ips / 256)}.${ips % 256}`;

function enrol(body: unknown, ip: string = freshIp()) {
  return exports.default.fetch(`${GALLERY}/v1/device/enrol`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A device with a pending code, as POST /api/devices leaves it. */
async function pendingDevice(expiresAt = IN_10_MIN()) {
  const code = newEnrolCode();
  const device = deviceRow({ name: "Admin's name" });
  await db.batch([insertDevice(db, device), setEnrolCode(db, device.id, await hashToken(code), expiresAt)]);
  return { device, code };
}

const body = (code: string) => ({ code, name: "Booth 1", appVersion: "0.4.0" });

/** Every refused code gets this, byte for byte apart from the correlation ID. */
async function expectRefused(res: Response) {
  expect(res.status).toBe(401);
  const error = ErrorBody.parse(await res.json());
  expect({ code: error.code, message: error.message }).toEqual({ code: "unauthorized", message: "That code is not valid. Ask for a new one." });
}

beforeEach(resetDb);

describe("POST /v1/device/enrol", () => {
  it("swaps a valid code for a credential, shown once and stored only as its hash", async () => {
    const { device, code } = await pendingDevice();
    const res = await enrol(body(code));
    expect(res.status).toBe(manifest.fixtures["device.enrol-response.valid.json"].status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expectFixtureShape(json, enrolResponseFixture);
    const enrolled = EnrolResponse.parse(json);
    expect(enrolled).toMatchObject({ deviceId: device.id, name: "Booth 1" });

    const row = await getDevice(db, device.id);
    expect(row).toMatchObject({
      name: "Booth 1",
      token_hash: await hashToken(enrolled.credential),
      app_version: "0.4.0",
      enrol_code_hash: null,
      enrol_expires_at: null,
      revoked_at: null,
    });
    expect(row?.enrolled_at).not.toBeNull();
    expect(row?.last_seen_at).toBe(row?.enrolled_at);
    expect(JSON.stringify(row)).not.toContain(enrolled.credential);

    // The credential works at once.
    const events = await exports.default.fetch(`${GALLERY}/v1/device/events`, { headers: deviceHeaders(enrolled.credential) });
    expect(events.status).toBe(200);
  });

  it("audits the enrolment as the device, with neither the code nor the credential", async () => {
    const { device, code } = await pendingDevice();
    const enrolled = EnrolResponse.parse(await (await enrol(body(code))).json());
    const audit = await listAudit(db, { limit: 10 });
    expect(audit).toEqual([
      expect.objectContaining({ actor: `device:${device.id}`, action: "device.enrol", event_id: null, target_id: device.id, detail: { name: "Booth 1", appVersion: "0.4.0" } }),
    ]);
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(JSON.stringify(audit)).not.toContain(enrolled.credential);
  });

  it("accepts the code as people type it: lowercase, spaces, dashes and look-alikes", async () => {
    const { code } = await pendingDevice();
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `.replace(/1/g, "l").replace(/0/g, "o");
    expect((await enrol(body(typed))).status).toBe(201);
  });

  it("works once: the same code again is refused", async () => {
    const { code } = await pendingDevice();
    expect((await enrol(body(code))).status).toBe(201);
    await expectRefused(await enrol(body(code)));
  });

  it("refuses an expired code", async () => {
    const { device, code } = await pendingDevice(new Date(Date.now() - 1).toISOString());
    await expectRefused(await enrol(body(code)));
    expect((await getDevice(db, device.id))?.token_hash).toBeNull();
  });

  it("refuses a code that was re-issued (the old one) and a revoked device's code", async () => {
    const { device, code } = await pendingDevice();
    await setEnrolCode(db, device.id, await hashToken(newEnrolCode()), IN_10_MIN()).run();
    await expectRefused(await enrol(body(code)));

    const revoked = await pendingDevice();
    await revokeDevice(db, revoked.device.id, new Date()).run();
    await expectRefused(await enrol(body(revoked.code)));
  });

  it("gives an unknown, malformed or used code the same answer", async () => {
    const { code } = await pendingDevice();
    expect((await enrol(body(code))).status).toBe(201);
    for (const bad of [code, "ZZZZZZZZ", "ABC", "!!!!!!!!", "UUUUUUUU", "A".repeat(32)]) await expectRefused(await enrol(body(bad)));
  });

  it("rejects a body that isn't a valid request with 400, and never enrols", async () => {
    const { device, code } = await pendingDevice();
    for (const bad of [
      "{not json",
      { code },
      { ...body(code), name: "" },
      { ...body(code), appVersion: "x".repeat(33) },
      { ...body(code), appVersion: "1.0\u0007" },
      { ...body(code), extra: true },
    ]) {
      const res = await enrol(bad);
      expect(res.status).toBe(400);
      expect(ErrorBody.parse(await res.json()).code).toBe("invalid_request");
    }
    expect((await getDevice(db, device.id))?.token_hash).toBeNull();
  });

  it("rejects an oversized body with 413", async () => {
    const res = await enrol({ code: "x", name: "x".repeat(10_000), appVersion: "1" });
    expect(res.status).toBe(413);
  });

  it("is rate-limited per IP (10 a minute) before the code is checked, and other IPs are unaffected", async () => {
    const { device, code } = await pendingDevice();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await expectRefused(await enrol(body("ZZZZZZZZ"), ip));
    const limited = await enrol(body(code), ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(ErrorBody.parse(await limited.json()).code).toBe("rate_limited");
    // The valid code wasn't spent by the refused request.
    expect((await getDevice(db, device.id))?.token_hash).toBeNull();
    expect((await enrol(body(code), freshIp())).status).toBe(201);
  });

  it("is only on the gallery host", async () => {
    const { device, code } = await pendingDevice();
    const res = await exports.default.fetch("http://unknown.localhost:8787/v1/device/enrol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body(code)),
    });
    expect(res.status).toBe(404);
    expect((await getDevice(db, device.id))?.token_hash).toBeNull();
  });
});
