// Device authentication (DESIGN §8, §13). Every device call except enrolment carries
// `Authorization: Bearer <credential>`. The credential is hashed and looked up; the device must be
// enrolled and not revoked, so a revocation takes effect on the device's next request. Credentials
// don't expire: an admin revokes a lost tablet, and last seen shows one that went quiet
// (wiki/Portal.md → "Devices and enrolment").
import { createMiddleware } from "hono/factory";
import { DEVICE_HEADERS } from "../../shared/schemas";
import { getDeviceByTokenHash, recordHeartbeat } from "../db/devices";
import { heartbeatDue, parseAppVersion, parseBearer, parseOutboxDepth } from "../domain/device";
import { hashToken } from "../domain/tokens";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";

/**
 * Sets `device` for the route. Also writes the heartbeat (last seen, `X-Outbox-Depth`,
 * `X-App-Version`), at most once a minute per device to save D1 writes: a booth polls and uploads
 * far more often than an admin needs to see it.
 */
export const deviceAuth = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const credential = parseBearer(c.req.header("Authorization"));
    const device = credential === null ? null : await getDeviceByTokenHash(c.env.DB, await hashToken(credential));
    // token_hash is set only together with enrolled_at (a CHECK), so a match is an enrolled device.
    if (!device || device.revoked_at !== null) throw new AppError("unauthorized", "The device is not enrolled.");

    const now = new Date();
    if (heartbeatDue(device.last_seen_at, now)) {
      await recordHeartbeat(c.env.DB, {
        id: device.id,
        now,
        backlog: parseOutboxDepth(c.req.header(DEVICE_HEADERS.outboxDepth)),
        appVersion: parseAppVersion(c.req.header(DEVICE_HEADERS.appVersion)),
      }).run();
    }
    c.set("device", device);
    return next();
  });
