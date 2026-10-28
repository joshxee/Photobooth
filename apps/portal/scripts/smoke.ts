// End-to-end smoke test of the live-delivery path (sessions 06, 11, 07): create and open a uniquely
// named event and device on the admin host, enrol, declare a photo, PUT both variants, and expect
// READY. Then the guest path: publish, swap the link's token for the cookie, list the photo, fetch
// both variants (byte-identical to the upload) and the download, and check that rotating the link
// locks the old cookie out. Then a variant carrying EXIF (APP1, a GPS IFD) must be refused with 422
// `invalid_image` and leave no object in R2. It always cleans up: the event is deleted (purged by the
// retention job after its undo window) and the device revoked.
//
// Local, against `wrangler dev --var DEV_AUTH:1` (admin calls use DEV_AUTH, so *.localhost only):
//   bun run scripts/smoke.ts --base http://localhost:8787
// For a localhost base the hosts default to photos.localhost and admin.localhost on the same port,
// sent as the Host header (the Worker routes on Host).
//
// Staging (the deploy workflow, or an agent locally), each host at its own origin:
//   bun run scripts/smoke.ts --photos https://portal-staging.josh-33c.workers.dev \
//     --admin https://portal-staging-admin.josh-33c.workers.dev [--commit <sha>] [--bucket portal-media-staging]
// Admin calls carry the Access service token from CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET.
// First it checks that Access, not the Worker, turns away a request without the token or with a
// wrong one. `--commit` waits until both hosts' /healthz report that commit (a fresh deploy can take
// a few seconds to reach every location). `--bucket` checks R2 directly through the Cloudflare API
// (CLOUDFLARE_API_TOKEN with R2 read, CLOUDFLARE_ACCOUNT_ID): the READY photo's objects exist and
// the rejected variant's doesn't.
//
// The variants are scripts/fixtures/booth-{thumb,hd}.jpg: synthetic (a generated pattern, no
// photo), made by the booth's own encoder (photobooth-core `encode_variants`), HD 2560×1707.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    "photos-host": { type: "string" },
    "admin-host": { type: "string" },
    photos: { type: "string" },
    admin: { type: "string" },
    commit: { type: "string" },
    bucket: { type: "string" },
  },
});

/** Where a host's requests go, and the Host header the Worker routes on. */
interface Target {
  origin: URL;
  host: string;
}

const remote = values.photos !== undefined || values.admin !== undefined;
if (remote ? !values.photos || !values.admin || values.base : !values.base) {
  console.error(
    "usage: bun run scripts/smoke.ts --base http://localhost:8787 [--photos-host h] [--admin-host h]\n" +
      "       bun run scripts/smoke.ts --photos <origin> --admin <origin> [--commit <sha>] [--bucket <name>]",
  );
  process.exit(2);
}
// Asking for the R2 check and then skipping it quietly would hide a lost CI secret.
if (values.bucket && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
  console.error("--bucket needs CLOUDFLARE_API_TOKEN (R2 read) and CLOUDFLARE_ACCOUNT_ID");
  process.exit(2);
}

let photos: Target;
let admin: Target;
if (remote) {
  photos = { origin: new URL(values.photos!), host: new URL(values.photos!).host };
  admin = { origin: new URL(values.admin!), host: new URL(values.admin!).host };
} else {
  const base = new URL(values.base!);
  const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  photos = { origin: base, host: values["photos-host"] ?? (local ? `photos.localhost:${base.port}` : base.host) };
  admin = { origin: base, host: values["admin-host"] ?? (local ? `admin.localhost:${base.port}` : base.host) };
}
const adminOrigin = `${admin.origin.protocol === "http:" ? "http" : "https"}://${admin.host}`;

/** Remote admin calls authenticate to Access with the service token; local ones rely on DEV_AUTH. */
function accessHeaders(): Record<string, string> {
  if (!remote) return {};
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set for a remote run");
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
}

const HD_WIDTH = 2560;
const HD_HEIGHT = 1707;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sends to the target's origin, keeping only the path and query of `url` (so an absolute URL the
 * Worker returned, such as an upload URL, goes to the same place), with the Host it routes on.
 */
async function send(target: Target, url: string, init: RequestInit = {}): Promise<Response> {
  const given = new URL(url, target.origin);
  const dest = new URL(given.pathname + given.search, target.origin);
  const headers = new Headers(init.headers);
  if (!remote) headers.set("Host", target.host);
  return fetch(dest, { redirect: "manual", ...init, headers });
}

/** `send`, then checks the status and parses a JSON body. */
async function call(target: Target, url: string, init: RequestInit & { expect: number }): Promise<unknown> {
  const res = await send(target, url, init);
  const text = await res.text();
  const label = `${init.method ?? "GET"} ${target.host}${new URL(url, target.origin).pathname}`;
  if (res.status !== init.expect) throw new Error(`${label}: expected ${init.expect}, got ${res.status} ${text.slice(0, 300)}`);
  console.log(`ok  ${res.status} ${label}`);
  return text ? JSON.parse(text) : null;
}

function adminCall(path: string, body: unknown, expect: number) {
  return call(admin, path, {
    method: "POST",
    headers: { Origin: adminOrigin, "Content-Type": "application/json", ...accessHeaders() },
    body: JSON.stringify(body),
    expect,
  });
}

function device(path: string, body: unknown, expect: number, credential?: string) {
  return call(photos, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}`, "X-Outbox-Depth": "1", "X-App-Version": "smoke" } : {}),
    },
    body: JSON.stringify(body),
    expect,
  });
}

/** A guest request on the photos host: returns the raw response after checking its status. */
async function guest(path: string, init: RequestInit & { expect: number }): Promise<Response> {
  const res = await send(photos, path, init);
  const label = `${init.method ?? "GET"} ${path}`;
  if (res.status !== init.expect) throw new Error(`${label}: expected ${init.expect}, got ${res.status} ${await res.text()}`);
  console.log(`ok  ${res.status} ${label}`);
  return res;
}

/** The Worker sets X-Request-Id on every response; Access's own refusals don't have one. */
async function expectAccessRefuses(label: string, headers: Record<string, string>): Promise<void> {
  const res = await send(admin, "/api/events", { headers });
  await res.arrayBuffer();
  const location = res.headers.get("Location") ?? "";
  const byAccess =
    res.headers.get("X-Request-Id") === null &&
    (res.status === 401 || res.status === 403 || (res.status === 302 && new URL(location, admin.origin).hostname.endsWith(".cloudflareaccess.com")));
  if (!byAccess) throw new Error(`${label}: expected Access to refuse, got ${res.status} (X-Request-Id ${res.headers.get("X-Request-Id")})`);
  console.log(`ok  ${res.status} GET ${admin.host}/api/events ${label}: refused by Access`);
}

/** Waits until `/healthz` reports `commit` (a deploy reaches every location within seconds). */
async function waitForCommit(target: Target, headers: Record<string, string>, commit: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const res = await send(target, "/healthz", { headers });
    const body = res.ok ? ((await res.json()) as { commit?: string | null }) : (await res.arrayBuffer(), null);
    if (body?.commit === commit) {
      console.log(`ok  ${res.status} GET ${target.host}/healthz commit ${commit}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${target.host}/healthz: expected commit ${commit}, got ${res.status} ${JSON.stringify(body)}`);
    await Bun.sleep(5_000);
  }
}

/** HEAD-like check of one R2 object through the Cloudflare API (R2 read), or null when not configured. */
async function r2Exists(key: string): Promise<boolean | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!values.bucket || !token || !account) return null;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${values.bucket}/objects/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.arrayBuffer();
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`R2 API ${key}: unexpected ${res.status}`);
}

/**
 * The thumb with an APP1 Exif segment right after SOI: a big-endian TIFF header, IFD0 with one
 * GPSInfo pointer, and a GPS IFD holding GPSVersionID. The Worker refuses any APP1 (DESIGN §9.1).
 */
function withGpsExif(jpeg: Uint8Array): Uint8Array {
  const tiff = [
    ...[0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], // "MM", 42, IFD0 at 8
    ...[0x00, 0x01, 0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1a], // GPSInfo → 26
    ...[0x00, 0x00, 0x00, 0x00],
    ...[0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x02, 0x02, 0x00, 0x00], // GPSVersionID 2.2
    ...[0x00, 0x00, 0x00, 0x00],
  ];
  const payload = [...Array.from("Exif", (ch) => ch.charCodeAt(0)), 0, 0, ...tiff];
  const length = payload.length + 2;
  const segment = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2));
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

interface Upload {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface Intent {
  state: string;
  photoId: string;
  uploads: { thumb: Upload; hd: Upload };
}

function sameOrigin(url: string, target: Target, what: string): void {
  if (remote && new URL(url).origin !== target.origin.origin) throw new Error(`${what}: ${new URL(url).origin} is not ${target.origin.origin}`);
}

async function guestPath(event: { id: string }, photoId: string, removedId: string, thumb: Uint8Array, hd: Uint8Array): Promise<void> {
  const published = (await adminCall(`/api/events/${event.id}/publish`, {}, 200)) as { publicId: string; galleryUrl: string };
  // The admin Worker builds the QR link from its GALLERY_HOST: it must be the photos host.
  sameOrigin(published.galleryUrl, photos, "galleryUrl");
  const link = new URL(published.galleryUrl);
  const token = link.hash.replace(/^#k=/, "");
  const prefix = link.pathname;

  await guest(`${prefix}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "not-the-token" }),
    expect: 404,
  });
  const session = await guest(`${prefix}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    expect: 200,
  });
  const setCookie = session.headers.get("Set-Cookie") ?? "";
  if (!setCookie.includes(`Path=${prefix};`) || !setCookie.includes("HttpOnly") || !setCookie.includes("Secure")) {
    throw new Error(`session: unexpected Set-Cookie ${setCookie}`);
  }
  const cookie = setCookie.split(";")[0]!;

  const page = (await (await guest(`${prefix}/api/photos`, { headers: { Cookie: cookie }, expect: 200 })).json()) as {
    photos: { id: string }[];
  };
  const listed = page.photos.map((p) => p.id);
  if (!listed.includes(photoId) || !listed.includes(removedId)) throw new Error(`photos: expected both photos, got ${JSON.stringify(listed)}`);

  for (const [variant, bytes] of [["thumb", thumb], ["hd", hd]] as const) {
    const res = await guest(`${prefix}/m/${photoId}/${variant}`, { headers: { Cookie: cookie }, expect: 200 });
    const body = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(body)) !== (await sha256Hex(bytes))) throw new Error(`${variant}: served bytes differ from the upload`);
    if (res.headers.get("Cache-Control") !== "private, max-age=31536000, immutable") throw new Error(`${variant}: Cache-Control`);
  }
  const download = await guest(`${prefix}/m/${photoId}/hd?download=1`, { headers: { Cookie: cookie }, expect: 200 });
  const downloaded = new Uint8Array(await download.arrayBuffer());
  if ((await sha256Hex(downloaded)) !== (await sha256Hex(hd))) throw new Error("download: bytes differ from the upload");
  if (!/^attachment; filename="[a-z0-9-]+-smoke-1-1\.jpg"$/.test(download.headers.get("Content-Disposition") ?? "")) {
    throw new Error(`download: Content-Disposition ${download.headers.get("Content-Disposition")}`);
  }

  await removal(event.id, prefix, cookie, photoId, removedId, thumb, hd);

  await adminCall(`/api/events/${event.id}/rotate-link`, {}, 200);
  await guest(`${prefix}/api/photos`, { headers: { Cookie: cookie }, expect: 404 });
  await guest(`${prefix}/m/${photoId}/thumb`, { headers: { Cookie: cookie }, expect: 404 });
}

/** The admin's preview of a variant through the media proxy (never cached), or the response. */
async function adminMedia(photoId: string, variant: string, expect: number): Promise<Response> {
  const res = await send(admin, `/api/media/${photoId}/${variant}`, { headers: accessHeaders() });
  if (res.status !== expect) throw new Error(`GET ${admin.host}/api/media/…/${variant}: expected ${expect}, got ${res.status}`);
  console.log(`ok  ${res.status} GET ${admin.host}/api/media/${photoId}/${variant}`);
  return res;
}

/**
 * The removal-request runbook's delete (wiki/Portal.md): the admin previews the photo, deletes it,
 * and it is gone at once from the guest list, from both hosts' media routes and from R2, while the
 * event's other photo stays.
 */
async function removal(eventId: string, prefix: string, cookie: string, keptId: string, removedId: string, thumb: Uint8Array, hd: Uint8Array): Promise<void> {
  for (const [variant, bytes] of [["thumb", thumb], ["hd", hd]] as const) {
    const res = await adminMedia(removedId, variant, 200);
    const body = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(body)) !== (await sha256Hex(bytes))) throw new Error(`admin ${variant}: served bytes differ from the upload`);
    if (!(res.headers.get("Cache-Control") ?? "").includes("no-store")) throw new Error(`admin ${variant}: Cache-Control ${res.headers.get("Cache-Control")}`);
  }
  await call(admin, `/api/photos/${removedId}`, {
    method: "DELETE",
    headers: { Origin: adminOrigin, "Content-Type": "application/json", ...accessHeaders() },
    body: "{}",
    expect: 200,
  });
  const page = (await (await guest(`${prefix}/api/photos`, { headers: { Cookie: cookie }, expect: 200 })).json()) as { photos: { id: string }[] };
  const listed = page.photos.map((p) => p.id);
  if (listed.includes(removedId) || !listed.includes(keptId)) throw new Error(`after delete: expected only ${keptId}, got ${JSON.stringify(listed)}`);
  for (const variant of ["thumb", "hd"]) {
    await guest(`${prefix}/m/${removedId}/${variant}`, { headers: { Cookie: cookie }, expect: 404 });
    await adminMedia(removedId, variant, 404);
  }
  const kept = await r2Exists(`events/${eventId}/${keptId}/hd.jpg`);
  if (kept === null) return;
  if (!kept) throw new Error("R2: the kept photo's hd is missing");
  for (const variant of ["thumb", "hd"]) {
    if (await r2Exists(`events/${eventId}/${removedId}/${variant}.jpg`)) throw new Error(`R2: the deleted photo's ${variant} is still there`);
  }
  console.log("ok  R2: the deleted photo's thumb and hd are gone, the other photo's are there");
}

/** A photo whose thumb carries EXIF: 422 `invalid_image`, the photo REJECTED, nothing left in R2. */
async function metadataRejected(eventId: string, credential: string, thumb: Uint8Array, hd: Uint8Array, readyPhotoId: string): Promise<void> {
  const exifThumb = withGpsExif(thumb);
  const intent = (await device(
    "/v1/device/photos",
    {
      eventId,
      clientPhotoId: crypto.randomUUID(),
      sessionId: "smoke-1",
      shot: 2,
      capturedAt: new Date().toISOString(),
      width: HD_WIDTH,
      height: HD_HEIGHT,
      variants: {
        thumb: { bytes: exifThumb.length, sha256: await sha256Hex(exifThumb) },
        hd: { bytes: hd.length, sha256: await sha256Hex(hd) },
      },
    },
    200,
    credential,
  )) as Intent;
  const res = await send(photos, intent.uploads.thumb.url, { method: "PUT", headers: intent.uploads.thumb.headers, body: exifThumb });
  const body = (await res.json()) as { code?: string };
  if (res.status !== 422 || body.code !== "invalid_image") throw new Error(`EXIF thumb: expected 422 invalid_image, got ${res.status} ${JSON.stringify(body)}`);
  console.log(`ok  422 PUT EXIF (APP1, GPS) thumb → invalid_image`);
  // The photo is REJECTED for good: its clean HD is refused too and stored nowhere.
  const hdRes = await send(photos, intent.uploads.hd.url, { method: "PUT", headers: intent.uploads.hd.headers, body: hd });
  const hdBody = (await hdRes.json()) as { code?: string };
  if (hdRes.status !== 422 || hdBody.code !== "invalid_image") throw new Error(`rejected photo's hd: expected 422, got ${hdRes.status}`);
  console.log(`ok  422 PUT the rejected photo's hd → invalid_image`);

  const prefix = `events/${eventId}`;
  const ready = await r2Exists(`${prefix}/${readyPhotoId}/thumb.jpg`);
  if (ready === null) {
    console.log("--  R2 not checked (no --bucket)");
    return;
  }
  // The positive control: the API sees the READY photo's objects, so a 404 below means something.
  if (!ready || !(await r2Exists(`${prefix}/${readyPhotoId}/hd.jpg`))) throw new Error("R2: the READY photo's objects are missing");
  for (const variant of ["thumb", "hd"]) {
    if (await r2Exists(`${prefix}/${intent.photoId}/${variant}.jpg`)) throw new Error(`R2: the rejected photo's ${variant} was left behind`);
  }
  console.log(`ok  R2 has the READY photo's thumb and hd, and nothing for the rejected photo`);
}

async function main(): Promise<void> {
  const dir = new URL("./fixtures/", import.meta.url);
  const thumb = new Uint8Array(await Bun.file(new URL("booth-thumb.jpg", dir)).arrayBuffer());
  const hd = new Uint8Array(await Bun.file(new URL("booth-hd.jpg", dir)).arrayBuffer());

  // The deploy first: until a newly enabled workers.dev hostname is live, Cloudflare answers it
  // with a bare 404, which isn't Access refusing.
  if (values.commit) {
    await waitForCommit(photos, {}, values.commit);
    await waitForCommit(admin, accessHeaders(), values.commit);
  }
  if (remote) {
    await expectAccessRefuses("without a token", {});
    await expectAccessRefuses("with a wrong secret", {
      "CF-Access-Client-Id": accessHeaders()["CF-Access-Client-Id"]!,
      "CF-Access-Client-Secret": "not-the-secret",
    });
  }

  const now = Date.now();
  const tag = `${new Date(now).toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  try {
    const event = (await adminCall(
      "/api/events",
      {
        name: `Smoke ${tag}`,
        timezone: "Pacific/Auckland",
        startsAt: new Date(now - 3_600_000).toISOString(),
        endsAt: new Date(now + 5 * 3_600_000).toISOString(),
      },
      201,
    )) as { id: string };
    cleanup.push(() => adminCall(`/api/events/${event.id}/delete`, {}, 200));
    await adminCall(`/api/events/${event.id}/open`, {}, 200);
    const created = (await adminCall("/api/devices", { name: `Smoke booth ${tag}` }, 201)) as { deviceId: string; code: string };
    cleanup.push(() => adminCall(`/api/devices/${created.deviceId}/revoke`, {}, 200));
    const { credential } = (await device("/v1/device/enrol", { code: created.code, name: "Smoke booth", appVersion: "smoke" }, 201)) as {
      credential: string;
    };

    const intent = {
      eventId: event.id,
      clientPhotoId: crypto.randomUUID(),
      sessionId: "smoke-1",
      shot: 1,
      capturedAt: new Date(now).toISOString(),
      width: HD_WIDTH,
      height: HD_HEIGHT,
      variants: {
        thumb: { bytes: thumb.length, sha256: await sha256Hex(thumb) },
        hd: { bytes: hd.length, sha256: await sha256Hex(hd) },
      },
    };
    const pending = (await device("/v1/device/photos", intent, 200, credential)) as Intent;
    if (pending.state !== "PENDING") throw new Error(`intent: expected PENDING, got ${pending.state}`);
    // The gallery Worker signs upload URLs for its own GALLERY_HOST.
    sameOrigin(pending.uploads.thumb.url, photos, "upload URL");

    const put = (u: Upload, bytes: Uint8Array, expect: number) => call(photos, u.url, { method: u.method, headers: u.headers, body: bytes, expect });
    const stored = (await put(pending.uploads.thumb, thumb, 200)) as { state: string };
    if (stored.state !== "STORED") throw new Error(`thumb: expected STORED, got ${stored.state}`);
    const ready = (await put(pending.uploads.hd, hd, 201)) as { state: string };
    if (ready.state !== "READY") throw new Error(`hd: expected READY, got ${ready.state}`);

    const again = (await device("/v1/device/photos", intent, 200, credential)) as { state: string };
    if (again.state !== "READY") throw new Error(`re-intent: expected READY, got ${again.state}`);

    // A second READY photo, for the removal-request delete.
    const second = (await device("/v1/device/photos", { ...intent, clientPhotoId: crypto.randomUUID(), shot: 3 }, 200, credential)) as Intent;
    await put(second.uploads.thumb, thumb, 200);
    const secondReady = (await put(second.uploads.hd, hd, 201)) as { state: string };
    if (secondReady.state !== "READY") throw new Error(`second photo: expected READY, got ${secondReady.state}`);

    await guestPath(event, pending.photoId, second.photoId, thumb, hd);
    await metadataRejected(event.id, credential, thumb, hd, pending.photoId);
    console.log(`smoke passed: photo ${pending.photoId} READY in event ${event.id}, served to a guest; a second photo deleted; EXIF refused`);
  } finally {
    // Newest first: revoke the device, then delete the event. A failed step fails the run but
    // doesn't hide the error that got here.
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (err) {
        console.error(`cleanup FAILED: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
  }
}

try {
  await main();
  if (process.exitCode === 1) console.error("smoke FAILED: cleanup");
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
