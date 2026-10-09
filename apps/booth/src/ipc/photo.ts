// URL of a captured photo served from memory by the backend's `booth://` protocol.
//
// The scheme is exposed differently per platform: Android and Windows rewrite custom schemes
// to `http://<scheme>.localhost/`, while macOS and Linux keep `booth://localhost/`.

function usesHttpLocalhost(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android|windows/i.test(navigator.userAgent);
}

export function photoUrl(sessionId: string, shot: number): string {
  const path = `photo/${encodeURIComponent(sessionId)}/${shot}`;
  return usesHttpLocalhost()
    ? `http://booth.localhost/${path}`
    : `booth://localhost/${path}`;
}

/**
 * Gets each photo ready for the strip while the guest is busy with the next countdown.
 *
 * A captured JPEG is the camera's full-size image (~10–20 MB, 24 MP). Showing three of them in
 * the strip meant fetching and decoding them all at the moment the strip appeared (about a
 * third of a second on the tablet, up to 0.8 s), and holding them decoded is no better: the
 * browser evicts 24 MP bitmaps, so the cost came back anyway. So each photo is fetched once, in
 * the background, decoded straight to strip size, and kept as a small in-memory JPEG (a
 * `blob:` URL, never written to disk); the full-size data is let go. The strip shows the small
 * copy as soon as it exists and the original until then. The original stays available at its
 * `booth://` URL.
 *
 * It is fetched as a Blob and decoded with `createImageBitmap(blob)`, which the browser does on
 * a background thread. Decoding an `<img>` instead (`createImageBitmap(img)`) ran on the page's
 * main thread and froze the live preview for ~280 ms per photo.
 *
 * Measured on the tablet with 24 MP photos: the first two photos of a strip were visible about
 * 17 ms after it appeared instead of ~320 ms. The last photo is only captured ~0.3 s before the
 * strip appears, so it still starts from the original URL and swaps to the small copy when ready.
 */
export interface PhotoPrefetcher {
  /** Starts getting a photo ready (once per photo). Never rejects. */
  prefetch(sessionId: string, shot: number): Promise<void>;
  /** What to show for a photo: the small ready copy if there is one, otherwise the original. */
  urlFor(sessionId: string, shot: number): string;
  /** Calls `listener` whenever a `urlFor` answer may have changed. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Frees every small copy and forgets all photos, e.g. when the session is over. */
  clear(): void;
  /** Photos being tracked. */
  readonly size: number;
}

export interface PhotoPrefetcherDeps {
  /** Fetches the full-size photo. */
  fetchPhoto?: (url: string) => Promise<Blob>;
  /** Produces a `blob:` URL of a strip-sized copy of a photo, or null if it cannot. */
  shrink?: (photo: Blob) => Promise<string | null>;
  /** Frees a URL `shrink` produced. */
  release?: (url: string) => void;
}

/** Wider than the strip's photos on any screen the booth runs on, at twice the pixel density. */
const PREVIEW_MAX_WIDTH = 1280;
const PREVIEW_QUALITY = 0.92;
/** Photos smaller than this (the test camera's ~60 KB) already show fast; shrinking only costs. */
const WORTH_SHRINKING_BYTES = 1_000_000;

async function fetchPhotoBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`photo request failed: ${response.status}`);
  return response.blob();
}

async function shrinkToPreview(photo: Blob): Promise<string | null> {
  // Decodes on a background thread, straight to the target width (aspect ratio kept), so the
  // 24 MP bitmap is never materialised.
  const bitmap = await createImageBitmap(photo, {
    resizeWidth: PREVIEW_MAX_WIDTH,
    resizeQuality: "medium",
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", PREVIEW_QUALITY),
    );
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    bitmap.close();
  }
}

interface Entry {
  small: string | null;
}

export function createPhotoPrefetcher(deps: PhotoPrefetcherDeps = {}): PhotoPrefetcher {
  const fetchPhoto = deps.fetchPhoto ?? fetchPhotoBlob;
  const shrink = deps.shrink ?? shrinkToPreview;
  const release = deps.release ?? ((url: string) => URL.revokeObjectURL(url));

  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    async prefetch(sessionId, shot) {
      const url = photoUrl(sessionId, shot);
      if (entries.has(url)) return;
      const entry: Entry = { small: null };
      entries.set(url, entry);

      try {
        const photo = await fetchPhoto(url);
        if (photo.size < WORTH_SHRINKING_BYTES) return;
        const small = await shrink(photo);
        if (!small) return;
        // clear() may have run while we were working: then nobody wants this copy.
        if (entries.get(url) !== entry) release(small);
        else {
          entry.small = small;
          notify();
        }
      } catch {
        // The strip falls back to the original URL, which reports a broken photo itself.
      }
    },

    urlFor(sessionId, shot) {
      const url = photoUrl(sessionId, shot);
      return entries.get(url)?.small ?? url;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    clear() {
      const had = entries.size > 0;
      for (const entry of entries.values()) if (entry.small) release(entry.small);
      entries.clear();
      if (had) notify();
    },

    get size() {
      return entries.size;
    },
  };
}

let current: PhotoPrefetcher = createPhotoPrefetcher();

/** The app's prefetcher. Calls go to whichever one is installed (tests swap it). */
export const photoPrefetcher: PhotoPrefetcher = {
  prefetch: (sessionId, shot) => current.prefetch(sessionId, shot),
  urlFor: (sessionId, shot) => current.urlFor(sessionId, shot),
  subscribe: (listener) => current.subscribe(listener),
  clear: () => current.clear(),
  get size() {
    return current.size;
  },
};

export function setPhotoPrefetcher(prefetcher: PhotoPrefetcher): void {
  current = prefetcher;
}

export function resetPhotoPrefetcher(): void {
  current = createPhotoPrefetcher();
}
