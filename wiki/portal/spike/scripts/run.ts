// Drives the spike Worker and prints JSON evidence for RESULTS.md (session 01, throwaway).
//   bun wiki/portal/spike/scripts/run.ts <base-url> <step> [runs]
// Steps: integrity | limits | timing | metadata | bigbody
// Fixtures come from wiki/portal/spike/fixtures/ (git-ignored). Variants are saved to
// $TMP/spike-out for jpeginfo.py.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [base, step, runsArg] = process.argv.slice(2);
if (!base || !step) throw new Error("usage: run.ts <base-url> <step> [runs]");
const FIX = join(import.meta.dir, "..", "fixtures");
const OUT = join(process.env.TMP ?? "/tmp", "spike-out");
mkdirSync(OUT, { recursive: true });

// The three originals, renamed by size: a16 = 16.30 MB EXIF-free, b11 = 11.25 MB, c17 = 17.47 MB.
const ORIGINALS = { a16: "a16.jpg", b11: "b11.jpg", c17: "c17.jpg" };

async function bytes(name: string) {
  return new Uint8Array(await Bun.file(join(FIX, name)).arrayBuffer());
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function put(route: "put" | "put-digest", key: string, body: Uint8Array, hash: string) {
  const t0 = performance.now();
  const res = await fetch(`${base}/${route}/${key}?sha256=${hash}`, { method: "PUT", body });
  return { status: res.status, clientMs: Math.round(performance.now() - t0), ...(await res.json()) };
}

async function processKey(key: string, query = "") {
  const t0 = performance.now();
  const res = await fetch(`${base}/process/${key}?${query}`, { method: "POST" });
  return { status: res.status, clientMs: Math.round(performance.now() - t0), ...(await res.json()) };
}

async function download(key: string, file: string) {
  const res = await fetch(`${base}/get/${key}`);
  await Bun.write(join(OUT, file), await res.arrayBuffer());
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });
const print = (x: unknown) => console.log(JSON.stringify(x, null, 1));

if (step === "integrity") {
  const body = await bytes(ORIGINALS.b11);
  const wrong = sha(new TextEncoder().encode("wrong"));
  print({
    good: await put("put", "b11", body, sha(body)),
    wrongHash: await put("put", "wrong-hash", body, wrong),
    digestGood: await put("put-digest", "b11-digest", body, sha(body)),
    digestWrongHash: await put("put-digest", "wrong-digest", body, wrong),
  });
  // Truncated body with the full file's hash: what a dropped connection looks like to R2.
  const half = body.slice(0, body.length >> 1);
  print({ truncatedBodyFullHash: await put("put", "truncated", half, sha(body)) });
}

if (step === "bigbody") {
  // ~95 MB of random bytes through the sha256 put: far above what one isolate could buffer twice.
  const size = 95 * 1024 * 1024;
  const body = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(body.subarray(i, i + 65536));
  print({ put95MB: await put("put", "big95", body, sha(body)), digest95MB: await put("put-digest", "big95d", body, sha(body)) });
}

if (step === "limits") {
  for (const name of ["pad-20000000.jpg", "pad-20000001.jpg", "pad-20971520.jpg", "pad-20971521.jpg"]) {
    const body = await bytes(name);
    const key = name.replace(".jpg", "");
    const up = await put("put", key, body, sha(body));
    const res = await processKey(key);
    print({ name, bytes: body.length, putOk: up.ok, ok: res.ok, info: res.info, error: res.error });
  }
}

if (step === "timing") {
  const runs = Number(runsArg ?? 20);
  for (const [key, name] of Object.entries(ORIGINALS)) {
    const body = await bytes(name);
    const puts: number[] = [];
    const digests: number[] = [];
    for (let i = 0; i < 5; i++) {
      puts.push((await put("put", key, body, sha(body))).ms);
      digests.push((await put("put-digest", `${key}-digest`, body, sha(body))).ms);
    }
    for (const mode of ["", "par=1"]) {
      const server: number[] = [];
      const steps: Record<string, number[]> = { info: [], thumb: [], preview: [], full: [] };
      let sizes: Record<string, number> = {};
      let failed = 0;
      for (let i = 0; i < runs; i++) {
        const r = await processKey(key, mode).catch(() => ({ ok: false }) as { ok: false });
        // On Workers Free most heavy runs die with exceededCpu (non-JSON 503); count, don't stop.
        if (!r.ok) {
          failed++;
          continue;
        }
        server.push(r.totalMs);
        steps.info.push(r.infoMs);
        for (const v of r.variants) steps[v.name].push(v.totalMs);
        sizes = Object.fromEntries(r.variants.map((v: { name: string; size: number }) => [v.name, v.size]));
      }
      print({
        key,
        bytes: body.length,
        mode: mode || "sequential",
        failed,
        processMs: server.length ? stats(server) : null,
        stepsP50: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, pct(v, 50)])),
        sizes,
        putMs: stats(puts),
        putDigestMs: stats(digests),
      });
    }
  }
}

if (step === "metadata") {
  const cases: [string, string][] = [
    ["rot6", "rot6-gps.jpg"],
    ["b11", ORIGINALS.b11],
    ["c17", ORIGINALS.c17],
  ];
  for (const [key, name] of cases) {
    const body = await bytes(name);
    await put("put", key, body, sha(body));
    for (const meta of ["none", "omit", "keep"]) {
      const r = await processKey(key, `meta=${meta}`);
      print({ key, meta, ok: r.ok, info: r.info, error: r.error, sizes: r.variants?.map((v: { name: string; size: number }) => [v.name, v.size]) });
      if (r.ok) for (const v of ["thumb", "preview", "full"]) await download(`events/spike/${key}/${v}.jpg`, `${key}-${meta}-${v}.jpg`);
    }
  }
}
