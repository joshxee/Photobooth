// Throwaway spike Worker for session 01. It answers RESULTS.md Q1–Q7 and Q9; it is not a
// template for apps/portal (no auth, no validation beyond what the questions need).
//
//   PUT  /put/<key>?sha256=<hex>          stream request.body into R2 with the sha256 option
//   PUT  /put-digest/<key>?sha256=<hex>   fallback: hash with crypto.DigestStream while streaming
//   POST /process/<key>?meta=none|omit&par=1&stream=1
//                                         info + thumb/preview/full → events/spike/<key>/<v>.jpg
//   POST /transform/<variant>?meta=…      body → one variant, no R2 (x-transform-ms header)
//   POST /info                            body → Images.info, no R2
//   GET  /get/<key>                       download an object (for EXIF checks)
//   POST /cleanup                         delete every object in the bucket

interface Variant {
  name: "thumb" | "preview" | "full";
  transform: ImageTransform;
  quality: number;
}

// DESIGN §7. `fit: scale-down` never enlarges a smaller source.
const VARIANTS: Variant[] = [
  { name: "thumb", transform: { width: 480, height: 480, fit: "scale-down" }, quality: 75 },
  { name: "preview", transform: { width: 1600, height: 1600, fit: "scale-down" }, quality: 85 },
  { name: "full", transform: {}, quality: 92 },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { "content-type": "application/json" },
  });

function describe(err: unknown) {
  const e = err as { name?: string; message?: string; code?: number };
  return { name: e?.name, message: e?.message ?? String(err), code: e?.code };
}

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function put(env: Env, key: string, request: Request, sha256: string | null) {
  const t0 = Date.now();
  try {
    const obj = await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType: "image/jpeg" },
      ...(sha256 ? { sha256 } : {}),
    });
    return json({
      ok: true,
      ms: Date.now() - t0,
      size: obj.size,
      storedSha256: obj.checksums.sha256 ? hex(obj.checksums.sha256) : null,
    });
  } catch (err) {
    const head = await env.BUCKET.head(key);
    return json({ ok: false, ms: Date.now() - t0, error: describe(err), objectExists: !!head }, 400);
  }
}

// Hash the bytes as they pass to R2, without buffering. FixedLengthStream gives R2 the known
// length it needs; each chunk is also written to a DigestStream.
async function putDigest(env: Env, key: string, request: Request, sha256: string | null) {
  const t0 = Date.now();
  const length = Number(request.headers.get("content-length"));
  if (!request.body || !Number.isFinite(length)) return json({ error: "need a body and length" }, 411);
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const fixed = new FixedLengthStream(length);
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await writer.write(chunk);
      controller.enqueue(chunk);
    },
    async flush() {
      await writer.close();
    },
  });
  try {
    const [obj] = await Promise.all([
      env.BUCKET.put(key, fixed.readable, { httpMetadata: { contentType: "image/jpeg" } }),
      request.body.pipeThrough(hashing).pipeTo(fixed.writable),
    ]);
    const actual = hex(await digest.digest);
    if (sha256 && actual !== sha256.toLowerCase()) {
      await env.BUCKET.delete(key);
      return json({ ok: false, ms: Date.now() - t0, error: "sha256 mismatch", actual }, 422);
    }
    return json({ ok: true, ms: Date.now() - t0, size: obj.size, sha256: actual });
  } catch (err) {
    return json({ ok: false, ms: Date.now() - t0, error: describe(err) }, 400);
  }
}

async function source(env: Env, key: string) {
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error(`missing ${key}`);
  return obj.body;
}

async function variant(env: Env, key: string, v: Variant, opts: { meta: string; stream: boolean }) {
  const t0 = Date.now();
  // `metadata` is not in the binding's ImageTransform type; send it anyway to see what happens.
  const transform = opts.meta === "omit" ? v.transform : { ...v.transform, metadata: opts.meta };
  const result = await env.IMAGES.input(await source(env, key))
    .transform(transform as ImageTransform)
    .output({ format: "image/jpeg", quality: v.quality });
  const tTransform = Date.now() - t0;
  const outKey = `events/spike/${key}/${v.name}.jpg`;
  let streamError: unknown = null;
  let size: number;
  if (opts.stream) {
    try {
      size = (await env.BUCKET.put(outKey, result.image()))?.size ?? -1;
    } catch (err) {
      streamError = describe(err);
      size = -1;
    }
  } else {
    const bytes = await new Response(result.image()).arrayBuffer();
    size = (await env.BUCKET.put(outKey, bytes, { httpMetadata: { contentType: "image/jpeg" } })).size;
  }
  return {
    name: v.name,
    size,
    contentType: result.contentType(),
    transformMs: tTransform,
    totalMs: Date.now() - t0,
    ...(streamError ? { streamError } : {}),
  };
}

// No R2: the request body goes straight into the binding and the variant comes back.
async function transformBody(env: Env, name: string, request: Request, url: URL) {
  const v = VARIANTS.find((x) => x.name === name);
  if (!v || !request.body) return json({ error: "unknown variant or no body" }, 400);
  const meta = url.searchParams.get("meta") ?? "none";
  const transform = meta === "omit" ? v.transform : { ...v.transform, metadata: meta };
  const t0 = Date.now();
  try {
    const result = await env.IMAGES.input(request.body)
      .transform(transform as ImageTransform)
      .output({ format: "image/jpeg", quality: v.quality });
    return result.response({ headers: { "x-transform-ms": String(Date.now() - t0) } });
  } catch (err) {
    return json({ ok: false, error: describe(err), ms: Date.now() - t0 }, 422);
  }
}

async function infoBody(env: Env, request: Request) {
  if (!request.body) return json({ error: "no body" }, 400);
  const t0 = Date.now();
  try {
    const info = await env.IMAGES.info(request.body);
    return json({ ok: true, info, ms: Date.now() - t0 });
  } catch (err) {
    return json({ ok: false, error: describe(err), ms: Date.now() - t0 }, 422);
  }
}

async function processPhoto(env: Env, key: string, url: URL) {
  const opts = { meta: url.searchParams.get("meta") ?? "none", stream: url.searchParams.has("stream") };
  const t0 = Date.now();
  try {
    const info = await env.IMAGES.info(await source(env, key));
    const tInfo = Date.now() - t0;
    const variants = url.searchParams.has("par")
      ? await Promise.all(VARIANTS.map((v) => variant(env, key, v, opts)))
      : await VARIANTS.reduce<Promise<Awaited<ReturnType<typeof variant>>[]>>(
          async (acc, v) => [...(await acc), await variant(env, key, v, opts)],
          Promise.resolve([]),
        );
    return json({ ok: true, info, infoMs: tInfo, variants, totalMs: Date.now() - t0, opts });
  } catch (err) {
    return json({ ok: false, error: describe(err), ms: Date.now() - t0, opts }, 422);
  }
}

async function cleanup(env: Env) {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    deleted += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ deleted });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [, route, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const sha256 = url.searchParams.get("sha256");
    switch (`${request.method} ${route}`) {
      case "PUT put":
        return put(env, key, request, sha256);
      case "PUT put-digest":
        return putDigest(env, key, request, sha256);
      case "POST process":
        return processPhoto(env, key, url);
      case "POST transform":
        return transformBody(env, key, request, url);
      case "POST info":
        return infoBody(env, request);
      case "GET get": {
        const obj = await env.BUCKET.get(key);
        return obj ? new Response(obj.body, { headers: { "content-type": "image/jpeg" } }) : json({}, 404);
      }
      case "POST cleanup":
        return cleanup(env);
      default:
        return json({ error: "not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
