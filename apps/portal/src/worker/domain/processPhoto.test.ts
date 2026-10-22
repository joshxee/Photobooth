import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertDevice } from "../db/devices";
import { type EventRow, insertEvent } from "../db/events";
import { getPhoto, insertPhotoIfUnderLimit, type NewPhoto } from "../db/photos";
import { deviceRow, eventRow, photoRow, resetDb } from "../test/factories";
import { baseline, gpsExifSegment, insertAfter, sha256Hex } from "../test/jpeg";
import { variantKey } from "./media";
import { type ProcessDeps, processPhoto } from "./processPhoto";

const db = env.DB;
const media = env.MEDIA;
const NOW = new Date("2026-10-22T10:00:00.000Z");
const deps: ProcessDeps = { db, media, now: () => NOW };

const THUMB = baseline(480, 320);
const HD = baseline(2560, 1707);

let event: EventRow;
let photo: NewPhoto;

async function setUp(overrides: { thumb?: Uint8Array; hd?: Uint8Array; width?: number; height?: number } = {}) {
  const thumb = overrides.thumb ?? THUMB;
  const hd = overrides.hd ?? HD;
  event = eventRow();
  const device = deviceRow();
  photo = photoRow({
    event_id: event.id,
    device_id: device.id,
    thumb_sha256: await sha256Hex(thumb),
    hd_sha256: await sha256Hex(hd),
    width: overrides.width ?? 2560,
    height: overrides.height ?? 1707,
    variant_bytes: { thumb: thumb.length, hd: hd.length },
  });
  await db.batch([insertEvent(db, event), insertDevice(db, device)]);
  await insertPhotoIfUnderLimit(db, photo);
  return { thumb, hd };
}

/** What the upload route does before calling processPhoto: the sha256 put. */
async function store(variant: "thumb" | "hd", bytes: Uint8Array) {
  await media.put(variantKey(event.id, photo.id, variant), bytes, { sha256: await sha256Hex(bytes) });
}

async function exists(variant: "thumb" | "hd") {
  return (await media.head(variantKey(event.id, photo.id, variant))) !== null;
}

async function emptyBucket() {
  const listed = await media.list();
  if (listed.objects.length > 0) await media.delete(listed.objects.map((o) => o.key));
}

beforeEach(async () => {
  await resetDb();
  await emptyBucket();
});

describe("processPhoto: happy path", () => {
  it("thumb then hd: STORED, then READY with published_at", async () => {
    await setUp();
    await store("thumb", THUMB);
    expect(await processPhoto(deps, photo.id, "thumb")).toEqual({ state: "STORED" });
    let row = await getPhoto(db, photo.id);
    expect(row).toMatchObject({ state: "PENDING", thumb_stored: 1, hd_stored: 0, published_at: null });

    await store("hd", HD);
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "READY" });
    row = await getPhoto(db, photo.id);
    expect(row).toMatchObject({ state: "READY", thumb_stored: 1, hd_stored: 1, published_at: NOW.toISOString() });
    expect(row).toMatchObject({ width: 2560, height: 1707, variant_bytes: { thumb: THUMB.length, hd: HD.length } });
  });

  it("hd then thumb gives the same result", async () => {
    await setUp();
    await store("hd", HD);
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "STORED" });
    await store("thumb", THUMB);
    expect(await processPhoto(deps, photo.id, "thumb")).toEqual({ state: "READY" });
    expect((await getPhoto(db, photo.id))?.state).toBe("READY");
  });

  it("a portrait HD and a portrait thumb (no width > height assumption)", async () => {
    const thumb = baseline(320, 480);
    const hd = baseline(1707, 2560);
    await setUp({ thumb, hd, width: 1707, height: 2560 });
    await store("thumb", thumb);
    await store("hd", hd);
    expect(await processPhoto(deps, photo.id, "thumb")).toEqual({ state: "STORED" });
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "READY" });
  });

  it("processing the same variant twice keeps one READY with the first published_at", async () => {
    await setUp();
    await store("thumb", THUMB);
    await store("hd", HD);
    await processPhoto(deps, photo.id, "thumb");
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "READY" });
    const later = { ...deps, now: () => new Date(NOW.getTime() + 60_000) };
    expect(await processPhoto(later, photo.id, "hd")).toEqual({ state: "READY" });
    expect(await processPhoto(later, photo.id, "thumb")).toEqual({ state: "READY" });
    expect((await getPhoto(db, photo.id))?.published_at).toBe(NOW.toISOString());
  });

  it("two concurrent calls for the last variant: one READY, no error", async () => {
    await setUp();
    await store("thumb", THUMB);
    await processPhoto(deps, photo.id, "thumb");
    await store("hd", HD);
    const results = await Promise.all([processPhoto(deps, photo.id, "hd"), processPhoto(deps, photo.id, "hd")]);
    expect(results).toEqual([{ state: "READY" }, { state: "READY" }]);
    expect(await getPhoto(db, photo.id)).toMatchObject({ state: "READY", published_at: NOW.toISOString() });
  });

  it("reads a large HD with two range reads and a small thumb with one", async () => {
    await setUp();
    expect(HD.length).toBeGreaterThan(64 * 1024);
    expect(THUMB.length).toBeLessThan(64 * 1024);
    const reads: string[] = [];
    const counting: ProcessDeps = {
      ...deps,
      media: {
        get: ((key: string, options?: R2GetOptions) => {
          reads.push(`${key.split("/").at(-1)} ${JSON.stringify(options?.range)}`);
          return media.get(key, options);
        }) as R2Bucket["get"],
        delete: (keys) => media.delete(keys),
      },
    };
    await store("thumb", THUMB);
    await store("hd", HD);
    await processPhoto(counting, photo.id, "thumb");
    await processPhoto(counting, photo.id, "hd");
    expect(reads).toEqual([
      'thumb.jpg {"offset":0,"length":65536}',
      'hd.jpg {"offset":0,"length":65536}',
      'hd.jpg {"suffix":2}',
    ]);
  });
});

describe("processPhoto: rejection", () => {
  it("an HD whose SOF size differs from the declared size: REJECTED, object deleted", async () => {
    const hd = baseline(2560, 1700);
    await setUp({ hd });
    await store("hd", hd);
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "REJECTED", reason: "hd is 2560×1700, declared 2560×1707" });
    expect(await exists("hd")).toBe(false);
    expect(await getPhoto(db, photo.id)).toMatchObject({ state: "REJECTED", reject_reason: "hd is 2560×1700, declared 2560×1707", hd_stored: 0 });
  });

  it("a thumb with a long edge over 480 px: REJECTED, object deleted", async () => {
    for (const thumb of [baseline(481, 320), baseline(320, 481)]) {
      await resetDb();
      await setUp({ thumb });
      await store("thumb", thumb);
      const result = await processPhoto(deps, photo.id, "thumb");
      expect(result).toEqual({ state: "REJECTED", reason: "thumb long edge is 481 px, over 480" });
      expect(await exists("thumb")).toBe(false);
      expect((await getPhoto(db, photo.id))?.state).toBe("REJECTED");
    }
  });

  it("a header-walk failure (GPS EXIF): REJECTED with the walk's reason, object deleted", async () => {
    const thumb = insertAfter(THUMB, [gpsExifSegment()]);
    await setUp({ thumb });
    await store("thumb", thumb);
    expect(await processPhoto(deps, photo.id, "thumb")).toEqual({ state: "REJECTED", reason: "segment 0xe1 not allowed" });
    expect(await exists("thumb")).toBe(false);
  });

  it("a REJECTED photo never becomes READY, and a bad object written by a racing PUT is still deleted", async () => {
    const thumb = insertAfter(THUMB, [gpsExifSegment()]);
    await setUp({ thumb });
    await store("hd", HD);
    await processPhoto(deps, photo.id, "hd");
    await store("thumb", thumb);
    await processPhoto(deps, photo.id, "thumb");
    // A second, concurrent PUT of the same bad thumb lands after the first one deleted it.
    await store("thumb", thumb);
    expect(await processPhoto(deps, photo.id, "thumb")).toEqual({ state: "REJECTED", reason: "segment 0xe1 not allowed" });
    expect(await exists("thumb")).toBe(false);
    // The valid HD stored before the rejection doesn't publish anything.
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "REJECTED", reason: "segment 0xe1 not allowed" });
    expect((await getPhoto(db, photo.id))?.state).toBe("REJECTED");
  });
});

describe("processPhoto: partial failure and deletion", () => {
  it("a failure after the object is written but before the UPDATE leaves it PENDING; a retry gives READY", async () => {
    await setUp();
    await store("thumb", THUMB);
    await processPhoto(deps, photo.id, "thumb");
    await store("hd", HD);
    const broken: ProcessDeps = {
      ...deps,
      db: { prepare: (sql: string) => db.prepare(sql), batch: () => Promise.reject(new Error("D1 unavailable")) } as unknown as D1Database,
    };
    await expect(processPhoto(broken, photo.id, "hd")).rejects.toThrow("D1 unavailable");
    expect(await getPhoto(db, photo.id)).toMatchObject({ state: "PENDING", thumb_stored: 1, hd_stored: 0 });
    expect(await exists("hd")).toBe(true);
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "READY" });
  });

  it("an event deleted between the two variants: the second is stored but nothing becomes READY", async () => {
    await setUp();
    await store("thumb", THUMB);
    await processPhoto(deps, photo.id, "thumb");
    await db.prepare("UPDATE events SET deleted_at = ?, purge_after = ? WHERE id = ?").bind(NOW.toISOString(), "2026-10-29T10:00:00.000Z", event.id).run();
    await store("hd", HD);
    expect(await processPhoto(deps, photo.id, "hd")).toEqual({ state: "STORED" });
    expect(await getPhoto(db, photo.id)).toMatchObject({ state: "PENDING", thumb_stored: 1, hd_stored: 1, published_at: null });
  });

  it("a missing object is an error (retryable), not a rejection", async () => {
    await setUp();
    await expect(processPhoto(deps, photo.id, "thumb")).rejects.toThrow(/not found/);
    expect((await getPhoto(db, photo.id))?.state).toBe("PENDING");
  });

  it("an unknown photo is NOT_FOUND", async () => {
    await setUp();
    expect(await processPhoto(deps, crypto.randomUUID(), "thumb")).toEqual({ state: "NOT_FOUND" });
  });
});

describe("purity (DESIGN §9.4)", () => {
  const sources = import.meta.glob<string>(["./processPhoto.ts", "./jpegHeaders.ts", "./media.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  });

  it("processPhoto, the header walk and the key helper import nothing from Hono and use no Request/Response", () => {
    expect(Object.keys(sources).sort()).toEqual(["./jpegHeaders.ts", "./media.ts", "./processPhoto.ts"]);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(/from\s+["']hono/);
      expect(source, file).not.toMatch(/\b(Request|Response|Headers|Context)\b/);
    }
  });
});
