// The gallery link is /e/{publicId}#k={token}[&s={sessionId}][&n={shots}] (DESIGN §11). The token
// lives only in the fragment, which browsers never send; once swapped for the cookie the SPA
// replaces the URL with /e/{publicId}[?s=…&n=…], so a reload, a bookmark or a screenshot of the
// address bar carries no token. `n` (the booth's shots per session) sizes the placeholders.

export interface GalleryLink {
  publicId: string;
  token: string | null;
  session: string | null;
  expected: number | null;
}

const PUBLIC_ID = /^[A-Za-z0-9_-]{1,64}$/;
// `SessionId` in src/shared/schemas.ts.
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

export function parseLink(pathname: string, search: string, hash: string): GalleryLink | null {
  const match = /^\/e\/([^/]+)\/?$/.exec(pathname);
  const publicId = match?.[1];
  if (!publicId || !PUBLIC_ID.test(publicId)) return null;
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search);
  const token = fragment.get("k") || null;
  const session = fragment.get("s") ?? query.get("s");
  const count = Number(fragment.get("n") ?? query.get("n"));
  return {
    publicId,
    token,
    session: session && SESSION.test(session) ? session : null,
    expected: Number.isInteger(count) && count >= 1 && count <= 10 ? count : null,
  };
}

export function viewUrl(publicId: string, session: string | null, expected: number | null): string {
  if (!session) return `/e/${publicId}`;
  return `/e/${publicId}?s=${session}${expected ? `&n=${expected}` : ""}`;
}

/** The address to show once the token is used: no fragment. */
export function cleanUrl(link: GalleryLink): string {
  return viewUrl(link.publicId, link.session, link.expected);
}
