// The admin devices API (DESIGN §8 admin, §12, D8), mounted under /api/devices on the admin host
// behind adminAuth, sameOrigin, the body limit and no-store (routes/admin.ts). Every mutation runs
// its write and its audit row in one `db.batch`. Codes are returned once and stored only hashed.
import { Hono, type Context } from "hono";
import { AdminDevice, AdminDeviceList, DeviceCodeResponse, DeviceCreateRequest, Id } from "../../../shared/schemas";
import { insertAudit, insertAuditIfDeviceActive } from "../../db/audit";
import { type DeviceRow, getDevice, insertDevice, listDevices, revokeDevice, setEnrolCode } from "../../db/devices";
import { enrolCodeExpiresAt } from "../../domain/device";
import { newEnrolCode, newId } from "../../domain/ids";
import { hashToken } from "../../domain/tokens";
import { readBody } from "../../lib/api";
import { auditEntry } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import type { AppEnv } from "../../types";

export function toAdminDevice(d: DeviceRow): AdminDevice {
  return {
    id: d.id,
    name: d.name,
    enrolledAt: d.enrolled_at,
    revokedAt: d.revoked_at,
    codeExpiresAt: d.enrol_expires_at,
    lastSeenAt: d.last_seen_at,
    lastBacklog: d.last_backlog,
    appVersion: d.app_version,
  };
}

/** The device for `:id`, or 404 (a malformed ID is also a 404: it can't name a device). */
async function loadDevice(c: Context<AppEnv>): Promise<DeviceRow> {
  const id = Id.safeParse(c.req.param("id"));
  const device = id.success ? await getDevice(c.env.DB, id.data) : null;
  if (!device) throw new AppError("not_found", "No such device.");
  return device;
}

/** A fresh code and its expiry. Only the hash is stored; the code itself is returned once. */
async function newCode(now: Date) {
  const code = newEnrolCode();
  return { code, codeHash: await hashToken(code), expiresAt: enrolCodeExpiresAt(now) };
}

export const devicesApi = new Hono<AppEnv>();

devicesApi.get("/", async (c) => {
  const devices = await listDevices(c.env.DB);
  return c.json(AdminDeviceList.parse({ devices: devices.map(toAdminDevice) }));
});

devicesApi.post("/", async (c) => {
  const body = await readBody(c, DeviceCreateRequest);
  const now = new Date();
  const { code, codeHash, expiresAt } = await newCode(now);
  const device: DeviceRow = {
    id: newId(now),
    name: body.name,
    token_hash: null,
    enrol_code_hash: codeHash,
    enrol_expires_at: expiresAt,
    enrolled_at: null,
    revoked_at: null,
    last_seen_at: null,
    last_backlog: null,
    app_version: null,
  };
  const db = c.env.DB;
  const entry = auditEntry(c, now, { action: "device.create", eventId: null, targetId: device.id, detail: { name: device.name } });
  await db.batch([insertDevice(db, device), insertAudit(db, entry)]);
  return c.json(DeviceCodeResponse.parse({ deviceId: device.id, code, expiresAt }), 201);
});

/**
 * Re-issues the code: the old one stops working. Also allowed for an enrolled device, so a wiped
 * tablet can enrol again as the same device; redeeming the code replaces its credential.
 */
devicesApi.post("/:id/code", async (c) => {
  const device = await loadDevice(c);
  const now = new Date();
  const { code, codeHash, expiresAt } = await newCode(now);
  const db = c.env.DB;
  const entry = auditEntry(c, now, { action: "device.code", eventId: null, targetId: device.id });
  // Both apply only to an unrevoked device, so a revoked one gets 409 and no audit row.
  const [, update] = await db.batch([insertAuditIfDeviceActive(db, entry, device.id), setEnrolCode(db, device.id, codeHash, expiresAt)]);
  if (update?.meta.changes !== 1) throw new AppError("conflict", "The device is revoked.");
  return c.json(DeviceCodeResponse.parse({ deviceId: device.id, code, expiresAt }));
});

/** Revokes at once: the next request with its credential is a 401, and any pending code is void. */
devicesApi.post("/:id/revoke", async (c) => {
  const device = await loadDevice(c);
  const now = new Date();
  const db = c.env.DB;
  const entry = auditEntry(c, now, { action: "device.revoke", eventId: null, targetId: device.id });
  // Both apply only if it isn't revoked yet, so revoking twice gets 409 and one audit row.
  const [, update] = await db.batch([insertAuditIfDeviceActive(db, entry, device.id), revokeDevice(db, device.id, now)]);
  if (update?.meta.changes !== 1) throw new AppError("conflict", "The device is already revoked.");
  const revoked: DeviceRow = { ...device, revoked_at: now.toISOString(), enrol_code_hash: null, enrol_expires_at: null };
  return c.json(AdminDevice.parse(toAdminDevice(revoked)));
});
