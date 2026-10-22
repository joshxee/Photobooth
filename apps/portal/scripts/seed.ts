// Deterministic local data for `wrangler dev` (never staging or production: it only opens the
// local, persisted D1 and R2 that `wrangler dev` uses in .wrangler/state).
//
//   fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --local
//   fnm exec --using=22.11.0 -- bun run seed
//
// It REPLACES everything in the local database and bucket with: event A (OPEN, gallery LIVE)
// with 6 READY photos in two sessions, 1 PENDING and 1 REJECTED; event B (CLOSED, gallery LIVE)
// with 2 READY photos; and one enrolled device. IDs, tokens and images are fixed; times are
// anchored to the current UTC hour so the events never expire under you.
// The share token and device credential below are LOCAL-ONLY placeholders, not secrets.
import { getPlatformProxy } from "wrangler";
import { insertAudit } from "../src/worker/db/audit";
import { insertDevice } from "../src/worker/db/devices";
import { type EventRow, insertEvent } from "../src/worker/db/events";
import {
  insertPhotoIfUnderLimit,
  markVariantStored,
  type NewPhoto,
  publishPhotoIfComplete,
  rejectPhoto,
} from "../src/worker/db/photos";
import { retentionUntil } from "../src/worker/domain/eventState";
import { hashToken } from "../src/worker/domain/tokens";
import { solidJpeg } from "./solidJpeg";

export const SEED = {
  eventA: { id: "019a0000-0000-7000-8000-00000000000a", publicId: "seedopenlive2222", shareToken: "c2VlZC1sb2NhbC1vbmx5IQ" },
  eventB: { id: "019a0000-0000-7000-8000-00000000000b", publicId: "seedclosedlive22", shareToken: "c2VlZC1sb2NhbC1vbmx5Qg" },
  device: {
    id: "019a0000-0000-7000-8000-0000000000d1",
    credential: "c2VlZC1sb2NhbC1kZXZpY2UtY3JlZGVudGlhbC0wMDA",
  },
} as const;

const HOUR = 60 * 60 * 1000;
type Rgb = [number, number, number];

interface SeedPhoto {
  event: EventRow;
  /** Unique across the seed (photo ID, client ID); `shot` is the position within its session. */
  n: number;
  session: string;
  shot: number;
  portrait: boolean;
  colour: Rgb;
  state: "READY" | "PENDING" | "REJECTED";
}

/** Fixed UUIDs per kind (events and the device are in SEED), so no two rows share an ID. */
function fixedId(kind: "photo" | "audit", n: number): string {
  return `019a0000-0000-7000-${kind === "photo" ? "8001" : "8002"}-${n.toString(16).padStart(12, "0")}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function event(id: string, publicId: string, shareToken: string, name: string, startsAt: Date, uploadStatus: EventRow["upload_status"]): EventRow {
  const starts = startsAt.toISOString();
  const ends = new Date(startsAt.getTime() + 6 * HOUR).toISOString();
  return {
    id,
    public_id: publicId,
    name,
    venue: "Seed Hall",
    timezone: "Pacific/Auckland",
    starts_at: starts,
    ends_at: ends,
    upload_status: uploadStatus,
    gallery_status: "LIVE",
    share_token: shareToken,
    access_version: 1,
    photo_limit: 2000,
    retention_until: retentionUntil(ends),
    deleted_at: null,
    purge_after: null,
    created_at: starts,
    updated_at: starts,
  };
}

async function main(): Promise<void> {
  const hour = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const eventA = event(SEED.eventA.id, SEED.eventA.publicId, SEED.eventA.shareToken, "Seed wedding (open)", new Date(hour.getTime() - 2 * HOUR), "OPEN");
  const eventB = event(SEED.eventB.id, SEED.eventB.publicId, SEED.eventB.shareToken, "Seed party (closed)", new Date(hour.getTime() - 7 * 24 * HOUR), "CLOSED");

  const photos: SeedPhoto[] = [
    { event: eventA, n: 1, session: "5eed0001-1", shot: 1, portrait: false, colour: [214, 96, 77], state: "READY" },
    { event: eventA, n: 2, session: "5eed0001-1", shot: 2, portrait: false, colour: [233, 161, 85], state: "READY" },
    { event: eventA, n: 3, session: "5eed0001-1", shot: 3, portrait: true, colour: [240, 205, 110], state: "READY" },
    { event: eventA, n: 4, session: "5eed0001-2", shot: 1, portrait: false, colour: [96, 168, 140], state: "READY" },
    { event: eventA, n: 5, session: "5eed0001-2", shot: 2, portrait: true, colour: [80, 132, 196], state: "READY" },
    { event: eventA, n: 6, session: "5eed0001-2", shot: 3, portrait: false, colour: [140, 104, 186], state: "READY" },
    { event: eventA, n: 7, session: "5eed0001-3", shot: 1, portrait: false, colour: [128, 128, 128], state: "PENDING" },
    { event: eventA, n: 8, session: "5eed0001-3", shot: 2, portrait: false, colour: [64, 64, 64], state: "REJECTED" },
    { event: eventB, n: 9, session: "5eed0002-1", shot: 1, portrait: false, colour: [52, 73, 94], state: "READY" },
    { event: eventB, n: 10, session: "5eed0002-1", shot: 2, portrait: true, colour: [192, 57, 43], state: "READY" },
  ];

  const proxy = await getPlatformProxy<Env>({ configPath: "wrangler.jsonc", persist: true });
  try {
    const { DB: db, MEDIA: media } = proxy.env;
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photos'").first();
    if (!tables) throw new Error("The local database has no schema. Run `wrangler d1 migrations apply DB --local` first.");

    // Replace, not merge: wipe rows and every local object.
    await db.batch(["photos", "audit", "devices", "events"].map((t) => db.prepare(`DELETE FROM ${t}`)));
    for (let cursor: string | undefined; ; ) {
      const listed = await media.list({ cursor });
      if (listed.objects.length > 0) await media.delete(listed.objects.map((o) => o.key));
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }

    const at = hour.toISOString();
    await db.batch([
      insertEvent(db, eventA),
      insertEvent(db, eventB),
      insertDevice(db, {
        id: SEED.device.id,
        name: "Seed booth",
        token_hash: await hashToken(SEED.device.credential),
        enrol_code_hash: null,
        enrol_expires_at: null,
        enrolled_at: at,
        revoked_at: null,
        last_seen_at: at,
        last_backlog: 1,
        app_version: "0.0.0-seed",
      }),
      insertAudit(db, { id: fixedId("audit", 1), at, actor: "system", action: "seed", event_id: null, target_id: null, detail: { photos: photos.length } }),
    ]);

    for (const p of photos) {
      const [w, h] = p.portrait ? [1707, 2560] : [2560, 1707];
      const thumb = solidJpeg(p.portrait ? 320 : 480, p.portrait ? 480 : 320, p.colour);
      const hd = solidJpeg(w, h, p.colour);
      const id = fixedId("photo", p.n);
      const published = new Date(Date.parse(p.event.starts_at) + p.n * 60_000);
      const row: NewPhoto = {
        id,
        event_id: p.event.id,
        device_id: SEED.device.id,
        client_photo_id: `5eed0000-0000-4000-8000-${p.n.toString(16).padStart(12, "0")}`,
        session_id: p.session,
        shot: p.shot,
        captured_at: published.toISOString(),
        thumb_sha256: await sha256Hex(thumb),
        hd_sha256: await sha256Hex(hd),
        width: w,
        height: h,
        variant_bytes: { thumb: thumb.byteLength, hd: hd.byteLength },
        created_at: published.toISOString(),
      };
      await insertPhotoIfUnderLimit(db, row);
      if (p.state === "PENDING") continue;
      if (p.state === "REJECTED") {
        await rejectPhoto(db, id, "seed: segment 0xe1 not allowed").run();
        continue;
      }
      const prefix = `events/${p.event.id}/${id}`;
      await media.put(`${prefix}/thumb.jpg`, thumb, { sha256: row.thumb_sha256, httpMetadata: { contentType: "image/jpeg" } });
      await media.put(`${prefix}/hd.jpg`, hd, { sha256: row.hd_sha256, httpMetadata: { contentType: "image/jpeg" } });
      await db.batch([markVariantStored(db, id, "thumb"), markVariantStored(db, id, "hd"), publishPhotoIfComplete(db, id, published)]);
    }

    const counts = await db.prepare("SELECT state, COUNT(*) AS n FROM photos GROUP BY state ORDER BY state").all<{ state: string; n: number }>();
    const objects = (await media.list()).objects.length;
    console.log(`Seeded 2 events, 1 device, photos ${counts.results.map((r) => `${r.state}=${r.n}`).join(" ")}, ${objects} objects.`);
    console.log(`Gallery A: http://photos.localhost:8787/e/${SEED.eventA.publicId}#k=${SEED.eventA.shareToken}`);
    console.log(`Gallery B: http://photos.localhost:8787/e/${SEED.eventB.publicId}#k=${SEED.eventB.shareToken}`);
    console.log(`Device credential (local only): ${SEED.device.credential}`);
  } finally {
    await proxy.dispose();
  }
}

if (import.meta.main) await main();
