// Keyset cursor for newest-first lists ordered by (published_at DESC, id DESC). The cursor is
// the last row's position, base64url-encoded so clients treat it as opaque. It holds nothing
// secret: a guest who forges one can only page within the event their cookie already allows.

export interface CursorPosition {
  publishedAt: string;
  id: string;
}

const MAX_CURSOR_LENGTH = 128;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(position: CursorPosition): string {
  return btoa(`${position.publishedAt}|${position.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The position, or null for anything that isn't a cursor this code made (the route returns 400). */
export function decodeCursor(cursor: string): CursorPosition | null {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  let text: string;
  try {
    text = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const parts = text.split("|");
  if (parts.length !== 2) return null;
  const [publishedAt, id] = parts as [string, string];
  if (!ISO_UTC.test(publishedAt) || !UUID.test(id)) return null;
  // Round-trip through Date so impossible dates (month 13) are refused.
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== publishedAt) return null;
  return { publishedAt, id };
}
