// End-to-end smoke test of the live-delivery path (session 06): create and open an event and a
// device on the admin host, enrol, declare a photo, PUT both variants, and expect READY. Then the
// guest path (session 11): publish, swap the link's token for the cookie, list the photo, fetch both
// variants and the download, and check that rotating the link locks the old cookie out.
//
//   fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js dev --var DEV_AUTH:1
//   bun run scripts/smoke.ts --base http://localhost:8787
//
// Setup uses DEV_AUTH, so it works only against `wrangler dev` on *.localhost (session 07 adapts it
// for staging, with a service token). For a localhost base the hosts default to photos.localhost and
// admin.localhost on the same port, sent as the Host header (the Worker routes on Host).
// The variants are scripts/fixtures/booth-{thumb,hd}.jpg: synthetic (a generated pattern, no
// photo), made by the booth's own encoder (photobooth-core `encode_variants`), HD 2560×1707.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { base: { type: "string" }, "photos-host": { type: "string" }, "admin-host": { type: "string" } },
});
if (!values.base) {
  console.error("usage: bun run scripts/smoke.ts --base http://localhost:8787 [--photos-host h] [--admin-host h]");
  process.exit(2);
}
const base = new URL(values.base);
const local = base.hostname === "localhost" || base.hostname === "127.0.0.1";
const photosHost = values["photos-host"] ?? (local ? `photos.localhost:${base.port}` : base.host);
const adminHost = values["admin-host"] ?? (local ? `admin.localhost:${base.port}` : base.host);
const adminOrigin = `${local ? "http" : "https"}://${adminHost}`;

const HD_WIDTH = 2560;
const HD_HEIGHT = 1707;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sends to `base`, whatever origin the URL names, with the Host header the Worker routes on. */
async function call(host: string, url: string, init: RequestInit & { expect: number }): Promise<unknown> {
  const target = new URL(url, base);
  target.protocol = base.protocol;
  target.host = base.host;
  const headers = new Headers(init.headers);
  headers.set("Host", host);
  const res = await fetch(target, { ...init, headers });
  const text = await res.text();
  const label = `${init.method ?? "GET"} ${target.pathname}`;
  if (res.status !== init.expect) throw new Error(`${label}: expected ${init.expect}, got ${res.status} ${text}`);
  console.log(`ok  ${res.status} ${label}`);
  return text ? JSON.parse(text) : null;
}

function admin(path: string, body: unknown, expect: number) {
  return call(adminHost, path, {
    method: "POST",
    headers: { Origin: adminOrigin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    expect,
  });
}

function device(path: string, body: unknown, expect: number, credential?: string) {
  return call(photosHost, path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential ? { Authorization: `Bearer ${credential}`, "X-Outbox-Depth": "1", "X-App-Version": "smoke" } : {}),
    },
    body: JSON.stringify(body),
    expect,
  });
}

interface Upload {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A guest request on the photos host: returns the raw response after checking its status. */
async function guest(path: string, init: RequestInit & { expect: number }): Promise<Response> {
  const target = new URL(path, base);
  const headers = new Headers(init.headers);
  headers.set("Host", photosHost);
  const res = await fetch(target, { ...init, headers });
  const label = `${init.method ?? "GET"} ${target.pathname}${target.search}`;
  if (res.status !== init.expect) throw new Error(`${label}: expected ${init.expect}, got ${res.status} ${await res.text()}`);
  console.log(`ok  ${res.status} ${label}`);
  return res;
}

async function guestPath(event: { id: string }, photoId: string, thumb: Uint8Array, hd: Uint8Array): Promise<void> {
  const published = (await admin(`/api/events/${event.id}/publish`, {}, 200)) as { publicId: string; galleryUrl: string };
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
  if (page.photos[0]?.id !== photoId) throw new Error(`photos: expected ${photoId} first, got ${JSON.stringify(page.photos)}`);

  for (const [variant, bytes] of [["thumb", thumb], ["hd", hd]] as const) {
    const res = await guest(`${prefix}/m/${photoId}/${variant}`, { headers: { Cookie: cookie }, expect: 200 });
    const body = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(body)) !== (await sha256Hex(bytes))) throw new Error(`${variant}: served bytes differ from the upload`);
    if (res.headers.get("Cache-Control") !== "private, max-age=31536000, immutable") throw new Error(`${variant}: Cache-Control`);
  }
  const download = await guest(`${prefix}/m/${photoId}/hd?download=1`, { headers: { Cookie: cookie }, expect: 200 });
  await download.arrayBuffer();
  if (!/^attachment; filename="[a-z0-9-]+-smoke-1-1\.jpg"$/.test(download.headers.get("Content-Disposition") ?? "")) {
    throw new Error(`download: Content-Disposition ${download.headers.get("Content-Disposition")}`);
  }

  await admin(`/api/events/${event.id}/rotate-link`, {}, 200);
  await guest(`${prefix}/api/photos`, { headers: { Cookie: cookie }, expect: 404 });
  await guest(`${prefix}/m/${photoId}/thumb`, { headers: { Cookie: cookie }, expect: 404 });
}

async function main(): Promise<void> {
  const dir = new URL("./fixtures/", import.meta.url);
  const thumb = new Uint8Array(await Bun.file(new URL("booth-thumb.jpg", dir)).arrayBuffer());
  const hd = new Uint8Array(await Bun.file(new URL("booth-hd.jpg", dir)).arrayBuffer());

  const now = Date.now();
  const event = (await admin(
    "/api/events",
    {
      name: `Smoke ${new Date(now).toISOString()}`,
      timezone: "Pacific/Auckland",
      startsAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now + 5 * 3_600_000).toISOString(),
    },
    201,
  )) as { id: string };
  await admin(`/api/events/${event.id}/open`, {}, 200);
  const created = (await admin("/api/devices", { name: "Smoke booth" }, 201)) as { code: string };
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
  const pending = (await device("/v1/device/photos", intent, 200, credential)) as {
    state: string;
    photoId: string;
    uploads: { thumb: Upload; hd: Upload };
  };
  if (pending.state !== "PENDING") throw new Error(`intent: expected PENDING, got ${pending.state}`);

  const put = (u: Upload, bytes: Uint8Array, expect: number) =>
    call(photosHost, u.url, { method: u.method, headers: u.headers, body: bytes, expect });
  const stored = (await put(pending.uploads.thumb, thumb, 200)) as { state: string };
  if (stored.state !== "STORED") throw new Error(`thumb: expected STORED, got ${stored.state}`);
  const ready = (await put(pending.uploads.hd, hd, 201)) as { state: string };
  if (ready.state !== "READY") throw new Error(`hd: expected READY, got ${ready.state}`);

  const again = (await device("/v1/device/photos", intent, 200, credential)) as { state: string };
  if (again.state !== "READY") throw new Error(`re-intent: expected READY, got ${again.state}`);

  await guestPath(event, pending.photoId, thumb, hd);
  console.log(`smoke passed: photo ${pending.photoId} READY in event ${event.id} and served to a guest`);
}

try {
  await main();
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
