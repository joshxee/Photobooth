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
