// POST /v1/device/enrol on the gallery host (DESIGN §8, §13, D8): a booth swaps the one-time code
// an admin issued for its bearer credential. No auth: the code is the proof.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { EnrolRequest, EnrolResponse } from "../../../shared/schemas";
import { insertEnrolAudit } from "../../db/audit";
import { type DeviceRow, redeemEnrolCode } from "../../db/devices";
import { newDeviceCredential, newId, normaliseEnrolCode } from "../../domain/ids";
import { ipRateKey } from "../../domain/rateKey";
import { hashToken } from "../../domain/tokens";
import { readBody } from "../../lib/api";
import { AppError, errorResponse } from "../../lib/errors";
import type { AppEnv } from "../../types";

/** The request is about 100 bytes. */
const MAX_BODY_BYTES = 4 * 1024;
/** The limiter's period (wrangler.jsonc, ENROL_LIMITER), sent as Retry-After. */
const LIMIT_PERIOD_SECONDS = 60;
/**
 * Every refused code gets exactly this: unknown, malformed, expired, used, replaced by a re-issue,
 * or a revoked device's. Nothing tells a guesser whether a code exists.
 */
const REFUSED = "That code is not valid. Ask for a new one.";

/**
 * Per IP (an IPv6 address by its /64), before anything else, so every attempt counts, malformed
 * ones included. Cloudflare
 * always sets CF-Connecting-IP; only local tests can lack it.
 */
const enrolRateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.ENROL_LIMITER.limit({ key: ipRateKey("enrol", c.req.header("CF-Connecting-IP")) });
  if (success) return next();
  const res = errorResponse(c, "rate_limited", "Too many attempts. Wait a minute and try again.");
  res.headers.set("Retry-After", String(LIMIT_PERIOD_SECONDS));
  return res;
});

export const enrolApi = new Hono<AppEnv>();

enrolApi.post("/", enrolRateLimit, bodyLimit({ maxSize: MAX_BODY_BYTES }), async (c) => {
  const body = await readBody(c, EnrolRequest);
  const code = normaliseEnrolCode(body.code);
  if (code === null) throw new AppError("unauthorized", REFUSED);

  const now = new Date();
  const credential = newDeviceCredential();
  const tokenHash = await hashToken(credential);
  const db = c.env.DB;
  // One statement redeems the code (single use, even under concurrent requests); the audit row
  // in the same batch finds the device by its new credential, so a refusal writes nothing.
  const [redeemed] = await db.batch([
    redeemEnrolCode(db, { codeHash: await hashToken(code), tokenHash, name: body.name, appVersion: body.appVersion, now }),
    insertEnrolAudit(db, { id: newId(now), at: now.toISOString(), tokenHash, detail: { name: body.name, appVersion: body.appVersion } }),
  ]);
  const device = redeemed?.results[0] as DeviceRow | undefined;
  if (!device) throw new AppError("unauthorized", REFUSED);
  // The credential is in this response only; the server keeps its hash.
  return c.json(EnrolResponse.parse({ deviceId: device.id, name: device.name, credential }), 201);
});
