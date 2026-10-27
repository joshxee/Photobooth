// Streaming a stored variant to a client, shared by the guest media route and the admin proxy.
// The bytes go from R2 to the client without being buffered or decoded (D14: the Worker never
// decodes images), so the caller only chooses the caching and, for a download, the filename.

/** The 200 for an R2 object holding a JPEG variant. `headers` adds `Cache-Control` and the like. */
export function jpegResponse(object: R2ObjectBody, headers: Record<string, string>): Response {
  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Content-Length": String(object.size), ...headers },
  });
}
