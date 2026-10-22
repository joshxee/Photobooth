// Device rules (DESIGN §8, §13, D8). Pure: no I/O, `now` is passed in.
import { LIMITS } from "../../shared/schemas";

/** An enrolment code works for 10 minutes after it is issued (DESIGN §13). */
export const ENROL_CODE_TTL_MS = 10 * 60 * 1000;

/** The heartbeat (last seen, backlog, app version) is written at most once a minute per device. */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function enrolCodeExpiresAt(now: Date): string {
  return new Date(now.getTime() + ENROL_CODE_TTL_MS).toISOString();
}

/**
 * Should this request write the heartbeat? Yes if the device was never seen, was last written a
 * minute or more ago, or has a stored time in the future (so a clock jump can't freeze it).
 */
export function heartbeatDue(lastSeenAt: string | null, now: Date): boolean {
  if (lastSeenAt === null) return true;
  const age = now.getTime() - Date.parse(lastSeenAt);
  return age < 0 || age >= HEARTBEAT_INTERVAL_MS;
}

/** `X-Outbox-Depth`: an integer clamped to 0–100000, or null (ignored) if it isn't one. */
export function parseOutboxDepth(header: string | undefined): number | null {
  const value = header?.trim();
  if (!value || !/^-?\d+$/.test(value)) return null;
  return Math.min(Math.max(Number(value), 0), LIMITS.outboxDepthMax);
}

/** `X-App-Version` (or the enrolment body's): 1–32 printable ASCII characters, or null. */
export function parseAppVersion(value: string | undefined): string | null {
  const version = value?.trim();
  return version && /^[\x20-\x7e]{1,32}$/.test(version) ? version : null;
}

/** The credential from `Authorization: Bearer <43 base64url characters>`, or null. */
export function parseBearer(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? "");
  return match ? match[1]! : null;
}
