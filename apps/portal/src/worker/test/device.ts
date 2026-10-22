// Device API test helpers: an enrolled device, its request headers, and the fixture-shape check.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { type DeviceRow, insertDevice } from "../db/devices";
import { newDeviceCredential } from "../domain/ids";
import { hashToken } from "../domain/tokens";
import { deviceRow, T0 } from "./factories";

export const GALLERY = "http://photos.localhost:8787";

/** A device enrolled straight into D1, with the credential the booth would hold. */
export async function enrolledDevice(overrides: Partial<DeviceRow> = {}): Promise<{ device: DeviceRow; credential: string }> {
  const credential = newDeviceCredential();
  const device = deviceRow({ token_hash: await hashToken(credential), enrolled_at: T0, app_version: "0.4.0", ...overrides });
  await insertDevice(env.DB, device).run();
  return { device, credential };
}

export function deviceHeaders(credential: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${credential}`, ...extra };
}

/**
 * The JSON shape of a value: object keys (sorted) with their shapes, an array as its first
 * element's shape, and `typeof` (or "null") for the rest. Two values with the same shape have the
 * same fields at every depth and the same JSON types.
 */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

/** A response body has exactly its contract fixture's fields and JSON types (every array element). */
export function expectFixtureShape(actual: unknown, fixture: unknown): void {
  if (Array.isArray(actual) && Array.isArray(fixture)) {
    if (fixture.length === 0) expect(actual).toEqual([]);
    for (const item of actual) expectFixtureShape(item, fixture[0]);
    return;
  }
  if (actual && fixture && typeof actual === "object" && typeof fixture === "object" && !Array.isArray(actual)) {
    const a = actual as Record<string, unknown>;
    const f = fixture as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(Object.keys(f).sort());
    for (const key of Object.keys(f)) expectFixtureShape(a[key], f[key]);
    return;
  }
  expect(shapeOf(actual)).toEqual(shapeOf(fixture));
}
