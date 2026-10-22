// Validates one stored variant and publishes the photo once both are stored (DESIGN §9.1, §9.2,
// D5, D14). It takes no HTTP types: the bucket, the database and the clock come in through `deps`,
// so the upload route calls it today and a queue consumer fed by R2 notifications could call it
// unchanged if uploads ever move to presigned R2 URLs (§9.4).
//
// Why this is safe without leases or a queue (§9.2):
// - The object is already stored under its fixed key with R2's sha256 check, so every call for a
//   variant sees the same bytes, and the header walk is deterministic.
// - `markVariantStored` and `publishPhotoIfComplete` run in one batch (one transaction), and the
//   publish is conditional (PENDING, both variants stored, event not deleted), so exactly one
//   caller turns the photo READY; the others re-read it.
// - A failure anywhere before that batch leaves the photo PENDING, and a retry redoes the work.
import { getPhoto, markVariantStored, type PhotoRow, publishPhotoIfComplete, rejectPhoto } from "../db/photos";
import { LIMITS, type Variant } from "../../shared/schemas";
import { checkJpegHeaders, type HeaderCheck, HEADER_WINDOW, TAIL_BYTES } from "./jpegHeaders";
import { variantKey } from "./media";

export interface ProcessDeps {
  db: D1Database;
  media: Pick<R2Bucket, "get" | "delete">;
  now: () => Date;
}

export type ProcessResult =
  /** Both variants are stored and checked; the photo is published. */
  | { state: "READY" }
  /** This variant is stored and checked; the photo is not READY yet. */
  | { state: "STORED" }
  /** A variant failed its check. The photo never becomes READY. */
  | { state: "REJECTED"; reason: string }
  /** The photo row is gone (an admin deleted it). */
  | { state: "NOT_FOUND" };

/** The SOF size rule per variant: the HD must be the declared size, the thumb fit 480 px. */
function sizeProblem(variant: Variant, frame: { width: number; height: number }, photo: PhotoRow): string | null {
  if (variant === "hd") {
    return frame.width === photo.width && frame.height === photo.height
      ? null
      : `hd is ${frame.width}×${frame.height}, declared ${photo.width}×${photo.height}`;
  }
  const longEdge = Math.max(frame.width, frame.height);
  return longEdge <= LIMITS.thumbMaxEdge ? null : `thumb long edge is ${longEdge} px, over ${LIMITS.thumbMaxEdge}`;
}

/**
 * The first 64 KB and the last 2 bytes, as range reads. An object that fits in the window (every
 * thumb) needs only the first read.
 */
async function walkStored(media: ProcessDeps["media"], key: string): Promise<HeaderCheck> {
  const head = await media.get(key, { range: { offset: 0, length: HEADER_WINDOW } });
  if (!head) throw new Error("stored variant not found");
  const headBytes = new Uint8Array(await head.arrayBuffer());
  if (head.size <= HEADER_WINDOW) return checkJpegHeaders(headBytes, headBytes.subarray(Math.max(0, headBytes.length - TAIL_BYTES)));
  const tail = await media.get(key, { range: { suffix: TAIL_BYTES } });
  if (!tail) throw new Error("stored variant not found");
  return checkJpegHeaders(headBytes, new Uint8Array(await tail.arrayBuffer()));
}

/** The photo's state after this call, re-read when the publish didn't change it. */
async function currentState(db: D1Database, photoId: string): Promise<ProcessResult> {
  const photo = await getPhoto(db, photoId);
  if (!photo) return { state: "NOT_FOUND" };
  if (photo.state === "READY") return { state: "READY" };
  if (photo.state === "REJECTED") return { state: "REJECTED", reason: photo.reject_reason ?? "rejected" };
  return { state: "STORED" };
}

/**
 * Call after `variant`'s object was stored (sha256 put). Checks it; on failure deletes the object
 * and rejects the photo; on success marks the variant stored and publishes the photo if both are.
 * Throws on infrastructure errors (D1, R2, a missing object), which the caller retries.
 */
export async function processPhoto(deps: ProcessDeps, photoId: string, variant: Variant): Promise<ProcessResult> {
  const { db, media } = deps;
  const photo = await getPhoto(db, photoId);
  if (!photo) return { state: "NOT_FOUND" };
  // A READY photo's variants were checked, and their bytes are fixed by the declared sha256.
  if (photo.state === "READY") return { state: "READY" };

  const key = variantKey(photo.event_id, photo.id, variant);
  const check = await walkStored(media, key);
  const problem = check.ok ? sizeProblem(variant, check, photo) : check.reason;
  if (problem !== null) {
    // Delete first: if the UPDATE then fails, the photo stays PENDING without the object and a
    // retried PUT is rejected again. This also runs for an already REJECTED photo, so a bad
    // object written by a racing PUT doesn't stay behind.
    await media.delete(key);
    await rejectPhoto(db, photo.id, problem).run();
    const after = await currentState(db, photo.id);
    return after.state === "REJECTED" ? after : { state: "REJECTED", reason: problem };
  }
  if (photo.state === "REJECTED") return { state: "REJECTED", reason: photo.reject_reason ?? "rejected" };

  const [, publish] = await db.batch([markVariantStored(db, photo.id, variant), publishPhotoIfComplete(db, photo.id, deps.now())]);
  if (publish?.meta.changes === 1) return { state: "READY" };
  return currentState(db, photo.id);
}
