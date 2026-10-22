// Row builders and a database reset for Worker tests. Every builder returns a valid row with
// fresh IDs; pass overrides for what the test cares about.
import { env } from "cloudflare:workers";
import type { DeviceRow } from "../db/devices";
import type { EventRow } from "../db/events";
import type { NewPhoto } from "../db/photos";
import { newId, newPublicId, newShareToken } from "../domain/ids";

export const T0 = "2026-10-22T09:00:00.000Z";

export async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM photos"),
    env.DB.prepare("DELETE FROM audit"),
    env.DB.prepare("DELETE FROM devices"),
    env.DB.prepare("DELETE FROM events"),
  ]);
}

export function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: newId(),
    public_id: newPublicId(),
    name: "Test event",
    venue: "Test venue",
    timezone: "Pacific/Auckland",
    starts_at: "2026-10-22T05:00:00.000Z",
    ends_at: "2026-10-22T11:00:00.000Z",
    upload_status: "OPEN",
    gallery_status: "LIVE",
    share_token: newShareToken(),
    access_version: 1,
    photo_limit: 2000,
    retention_until: "2027-01-20T11:00:00.000Z",
    deleted_at: null,
    purge_after: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function deviceRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: newId(),
    name: "Booth 1",
    token_hash: null,
    enrol_code_hash: null,
    enrol_expires_at: null,
    enrolled_at: null,
    revoked_at: null,
    last_seen_at: null,
    last_backlog: null,
    app_version: null,
    ...overrides,
  };
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

export function photoRow(overrides: Partial<NewPhoto> & Pick<NewPhoto, "event_id" | "device_id">): NewPhoto {
  return {
    id: newId(),
    client_photo_id: crypto.randomUUID(),
    session_id: "19a0b6c1-1",
    shot: 1,
    captured_at: T0,
    thumb_sha256: SHA_A,
    hd_sha256: SHA_B,
    width: 2560,
    height: 1707,
    variant_bytes: { thumb: 21_000, hd: 416_000 },
    created_at: T0,
    ...overrides,
  };
}
