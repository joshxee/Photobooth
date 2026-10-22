// Upload test helpers (session 06): an open event, an intent for a thumb/hd pair, and the PUTs.
import { env, exports } from "cloudflare:workers";
import { expect } from "vitest";
import { type PhotoIntentRequest, PhotoIntentResponse, type UploadDescriptor } from "../../shared/schemas";
import { type EventRow, insertEvent } from "../db/events";
import { deviceHeaders, GALLERY } from "./device";
import { eventRow } from "./factories";
import { baseline, sha256Hex } from "./jpeg";

export const THUMB = baseline(480, 320);
export const HD = baseline(2560, 1707);

export async function openEvent(overrides: Partial<EventRow> = {}): Promise<EventRow> {
  const event = eventRow(overrides);
  await insertEvent(env.DB, event).run();
  return event;
}

export async function intentBody(
  eventId: string,
  overrides: Partial<PhotoIntentRequest> & { thumb?: Uint8Array; hd?: Uint8Array } = {},
): Promise<PhotoIntentRequest> {
  const { thumb = THUMB, hd = HD, ...rest } = overrides;
  return {
    eventId,
    clientPhotoId: crypto.randomUUID(),
    sessionId: "6a3f1c20-3",
    shot: 1,
    capturedAt: "2026-10-22T09:30:12.345Z",
    width: 2560,
    height: 1707,
    variants: {
      thumb: { bytes: thumb.length, sha256: await sha256Hex(thumb) },
      hd: { bytes: hd.length, sha256: await sha256Hex(hd) },
    },
    ...rest,
  };
}

export function postIntent(credential: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`${GALLERY}/v1/device/photos`, {
    method: "POST",
    headers: { ...deviceHeaders(credential), "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** An intent that must succeed; returns the parsed body. */
export async function intent(credential: string, body: unknown): Promise<PhotoIntentResponse> {
  const res = await postIntent(credential, body);
  if (res.status !== 200) throw new Error(`intent: expected 200, got ${res.status}: ${await res.text()}`);
  return PhotoIntentResponse.parse(await res.json());
}

/** A PUT exactly as the booth sends it: the descriptor's method, URL and headers, the bytes. */
export function upload(descriptor: UploadDescriptor, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(descriptor.url, { method: descriptor.method, headers: { ...descriptor.headers, ...headers }, body: bytes });
}

export function uploadsOf(response: PhotoIntentResponse): { thumb?: UploadDescriptor; hd?: UploadDescriptor } {
  expect(response.state).toBe("PENDING");
  return response.state === "PENDING" ? response.uploads : {};
}

export async function listKeys(): Promise<string[]> {
  return (await env.MEDIA.list()).objects.map((o) => o.key).sort();
}

export async function emptyBucket(): Promise<void> {
  const listed = await env.MEDIA.list();
  if (listed.objects.length > 0) await env.MEDIA.delete(listed.objects.map((o) => o.key));
}
