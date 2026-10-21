# Spike results (session 01)

Run on 2026-10-22 against the personal Cloudflare account on **Workers Free**, with the throwaway
`portal-spike` Worker and R2 bucket (both deleted afterwards, see [Clean-up](#clean-up)).
Tooling: wrangler 4.151.3 (run under Node 22, see [Gotchas](#gotchas)), workerd 1.20261019.1,
compatibility date 2026-10-01. Source: [`worker/`](./worker/), [`scripts/`](./scripts/).

**Verdict: GO, with a design change.** Integrity is enforced in-path (Q1), and processing p95 is
3.9 s, under the 10 s trigger (Q4). But the measurements change *where variants are made*:
the Images binding does not fit Workers Free (Q11) and **does not strip GPS or serial numbers**
(Q6). The recommendation is **option B: the booth makes thumb + HD variants, and the Worker only
authenticates, stores them with `sha256` and checks JPEG headers** (Q10). It runs on Workers
Free at about USD 0/month for 2,000 photos/month (Q12).

## Fixtures

The three supplied JPEGs are **not Sony A7 III originals**: two are Canon EOS 80D files saved
through Photoshop (6000×4000, 11.25 MB and 17.47 MB, with EXIF incl. body and lens serial numbers,
IPTC and XMP; one has a GPS IFD with only a version tag), and one has no EXIF at all
(5503×3669, 16.30 MB). They are still 24 MP JPEGs of the right size class, so they stand in for
the size, limit and timing questions. Derived test copies (all git-ignored, never committed):

| Copy | Made with | Purpose |
|---|---|---|
| `rot6-gps.jpg` | `jpeginfo.py retag --orientation 6 --gps` on the 11 MB Canon file | Q5, Q6 (none of the originals is rotated) |
| `small-rot6-gps.jpg` | 2560 px resize keeping the Canon EXIF, then the same retag | Q5, Q6 on real Images (small enough to stay under the Free CPU limit) |
| `pad-20000000.jpg` … `pad-20971521.jpg` | the 17.47 MB file zero-padded after EOI | Q3 limit boundary |

## Answers

| Q | Result | Evidence | DESIGN impact |
|---|---|---|---|
| **Q1** wrong hash | **`put` throws** `Error: put: The SHA-256 checksum you specified did not match what we received. You provided … Actual SHA-256 was: … (10037)`. Nothing is stored (`head` → null). A truncated body with the full file's hash fails the same way. Local `wrangler dev` gives the identical message. | `run.ts integrity`: wrong hash → 400 in 275 ms, `objectExists:false`; truncated half body → same error | §9.2 holds: integrity in-path. Map error 10037 to 422 `hash_mismatch` |
| **Q2** streaming | **Yes.** `BUCKET.put(key, request.body, {sha256})` with the client's `Content-Length` streams natively: **0–1 ms CPU** for 17.47 MB (n=10, p50 0, p95 1). A 95 MiB random body also went through (2.4 s server time, on Workers Free; its CPU was not captured). The `crypto.DigestStream` fallback works but costs **≈280 ms CPU** for 17 MB, so it is not needed. Separately: `put(key, result.image())` **throws** `TypeError: Provided readable stream must have a known length`, so Images outputs must be buffered (or wrapped in `FixedLengthStream` with a known size) before `put`. | tail `cpuTime` for `PUT /put/plain17`; `run.ts bigbody`; local `process?stream=1` | §9.2: drop the DigestStream fallback |
| **Q3** input limits | **Images `.input()`/`.info()` accept up to exactly 20,000,000 bytes** (decimal MB). 20,000,001 bytes → `IMAGES_INFO_ERROR 9402: Could not fetch the image — file too large`. 6000×4000 (24 MP) passes; the documented transform limits are 100 MP and 12,000 px per side. Local `wrangler dev` has **no** size limit. | `run.ts limits` with the padded copies | Under option A the intent cap must be 20,000,000 bytes, and a Sony extra-fine JPEG near 20 MiB would be rejected. Under option B the original never reaches Cloudflare |
| **Q4** wall time | **Option A** (`info` + thumb/preview/full + 3 puts, sequential, 17.47 MB input): **p50 3,198 ms, p95 3,880 ms**, max 3,880 (13 of 20 runs succeeded; the other 7 were killed by the Free CPU limit). Step p50: info 428, thumb 706, preview 781, full 1,244 ms. **Option B** (sha256 put + 64 KB range read + header walk, upload from Auckland included): HD p50 334 / p95 449 ms (n=49), thumb p50 278 / p95 361 ms (n=51). | `process/c17?set=a3` ×20; tail for put-check | Under the 10 s trigger either way: no async processing needed (§9.4) |
| **Q5** orientation | **Applied** by the real binding: an orientation-6 input comes out portrait (480→320×480, 2048→1365×2048, full→1707×2560) and the orientation tag is removed. **`info` reports the stored, unrotated size** (6000×4000 for a portrait shot). Local `wrangler dev` behaves the same. For option B, Pillow's `exif_transpose` gives the same result on the booth side. | `transform/*` on `small-rot6-gps.jpg`; local `process/rot6-gps`; `booth_variants.py` | Dimension checks must not assume `width > height`. Option B: the booth must read the EXIF orientation before encoding |
| **Q6** GPS / serial | **The real Images binding keeps EXIF.** Every variant (thumb, 2048, full) still has the **GPS IFD (5 tags), camera body serial, lens serial and Make**. The output is byte-identical with `metadata` = `none`, omitted, `keep` or `copyright`, whether passed to `transform()` or `output()`. Neither placement is in the binding's TypeScript types, and both are ignored. **Local `wrangler dev` strips all metadata, so a local test would pass while production leaks.** Option B outputs (booth side) contain only `APP0:JFIF`, and the Worker's header walk rejects any `APP1` (`segment 0xe1 not allowed`), on real R2 and locally. | `jpeginfo.py inspect` on downloaded outputs | **§7 "metadata=none" does not work with the binding.** Option A would need an extra strip step in the Worker; option B enforces it by construction and by the server check |
| **Q7** output sizes | **Option A** (Images, 17.47 MB input): thumb 50,498 B, preview 276,594 B, full (original size, q92) 5,241,547 B, about 5.57 MB per photo (§16's 5.7 MB assumption holds for v2.0's variants). **Option B** (libjpeg-turbo via Pillow, the HD-only policy): see the table below. Recommended **thumb 480 px q75 ≈ 14–30 KB, HD 2560 px long edge q85 ≈ 240–585 KB (mean 413 KB)**, about 0.43 MB per photo. | `process` JSON; `booth_variants.py` | §7: replace preview + full with one `hd` variant; storage per photo falls ~13× |
| **Q8** real Sony size | **Could not verify.** The fixtures are not Sony files, the tablet's logcat had no `downloading the captured object` lines (the booth logs `compressed_size` there), and the camera was refusing live view (`AccessDenied`) when checked, so no test capture was taken. | `adb logcat -d` on the Xiaomi Pad 6 | Carry to session 08: read the size from that log line on the first real capture. It matters only for option A's 20 MB cap and for outbox disk use |
| **Q9** local Images | **Supported locally:** `info`, `transform` (width/height/fit, orientation) and `output`. **Not faithful:** quality is ignored (quant tables ≈ q80 for any `quality`), there is no 20 MB input limit, and **all metadata is stripped** (unlike remote, Q6). Local R2 enforces `sha256` with the production error text. Option B's Worker path (put + range read + header walk) behaves the same locally and remotely. | local `wrangler dev` runs | Session 06 under option B can test everything locally. Under option A, metadata and size limits would need remote checks |
| **Q10** where variants are made | **Recommend option B (booth).** Reasons: (1) A's binding leaks GPS and serial numbers (Q6), so A needs a strip step anyway; (2) A needs Workers Paid for CPU (Q11), B runs on Free; (3) B uploads 0.27–0.61 MB per shot instead of 11–17 MB (**20–40× less**), which matters most on venue Wi-Fi or 4G, the "live" path; (4) B has no 20 MB input cap (Q3); (5) business logic stays in Rust (AGENTS.md). Cost: new booth code (decode, orientation, resize, encode) and a JPEG crate, and on-tablet time, **estimated 0.6–1.6 s per photo (unverified)**. See [Q10 detail](#q10-server-vs-booth-variants). | this spike | D4, D5, D6, §1, §7, §9 rewritten (this PR) |
| **Q11** CPU per request | **Option A does not fit Free:** `process` (3 variants, 17 MB) uses **p50 355 ms, p95 460 ms CPU** (ok runs p50 397, p95 471), 35–47× the 10 ms limit. On Free it succeeds only while the account's early allowance lasts; after that, 7 of 20 runs (3 variants) and **20 of 20 runs (2 variants)** died with `exceededCpu` / HTTP 503 `error code: 1102`. Even `info` alone uses 40–47 ms. **Option B fits easily:** sha256 put + header check **p50 1 ms, p95 1 ms** (max 2, n=100); plain sha256 put p50 0, p95 1 ms. A hybrid (booth uploads HD, Worker makes only the thumb from it) uses 5–6 ms CPU, which fits but is tight once auth and D1 are added. | `wrangler tail --format json` `cpuTime`, summarised by `tailstats.py` (tail samples, so n < requests) | A requires Workers Paid ($5). B keeps Workers Free viable |
| **Q12** cost at 2,000 photos/month | **Option B on Workers Free: USD 0/month** (storage ≈ 2.6 GB, all usage inside the free tiers; peak event day ≈ 33k requests, heavy case ≈ 93k of the 100k/day limit). **Option A: ≈ USD 5–5.50/month** (Workers Paid required; 3 variants exceed the 5,000 free transformations, 2 fit). Both fit the USD 20 budget. See [Q12 detail](#q12-cost-model). | pricing pages (2026-10-22), measured sizes | §1 cost row; Workers plan decision for the user (below) |

### Option B variant sizes (measured, Pillow 12.1.1 / libjpeg-turbo, `optimize=True`)

| Fixture | thumb 480 q75 | HD 2048 q85 | **HD 2560 q85** | HD 2560 q90 |
|---|---|---|---|---|
| 16.30 MB, 5503×3669 | 15,952 | 248,775 | **422,771** | 621,216 |
| 11.25 MB, 6000×4000 | 14,073 | 166,710 | **239,743** | 338,773 |
| 17.47 MB, 6000×4000 | 30,019 | 399,877 | **585,180** | 762,244 |

HD size choice: **2560 px long edge, q85**. 2048 saves ~30 % of bytes, but storage is already far
inside the free 10 GB (Q12), and 2560 (4.4 MP) still prints a 6×4 at well over 300 dpi and looks
sharp full-screen on phones and tablets. q90 adds ~40 % for no visible gain at this size.
The gallery lightbox uses HD; there is no separate 1600 px preview (that would have been a third
transformation or upload).

### Q10 server vs booth variants

| | **A: Worker + Images binding** (DESIGN v2.0) | **B: booth makes variants** (recommended) |
|---|---|---|
| Booth uploads | original, 11–17 MB (Sony size unverified, Q8) | thumb + HD, 0.27–0.61 MB total |
| Upload time at 10 Mbit/s | ≈ 9–14 s per shot | ≈ 0.2–0.5 s per shot |
| Worker work | auth, sha256 put, `info`, 2–3 transforms, buffered puts, **plus an EXIF strip it doesn't have** | auth, 2 sha256 puts, 64 KB range read, header walk |
| Worker CPU | 355–471 ms → **Workers Paid required** | ≈ 1 ms → Workers Free |
| Images transformations | 3/photo = 6,000/month (over the 5,000 free; needs Images Paid), or 2/photo = 4,000 (fits) | 0 |
| Metadata removal | binding ignores `metadata` (Q6) | booth re-encodes without metadata; the server rejects APP1/APP13/COM |
| Input size cap | 20,000,000 bytes (Q3) | none (only the variants travel) |
| Local testability | partial (Q9: metadata, limits and quality differ) | full |
| Booth cost | none | decode + orientation + resize + encode, a JPEG crate, est. 0.6–1.6 s per shot |

**On-tablet estimate (option B, unverified).** On this PC (i5-13600KF, one core) the per-shot
pipeline, with a DCT-scaled decode (libjpeg 1/2 scale, which Rust decoders such as `zune-jpeg` or
`turbojpeg` also offer), orientation, a Lanczos resize to 2560 and to 480, and two encodes, takes
**≈ 0.25–0.33 s**; with a full-resolution decode, ≈ 0.65 s. The Xiaomi Pad 6 (Snapdragon 870) is
roughly 2.5× slower per core, so **≈ 0.6–1.6 s per shot**, off the capture path (the upload loop
runs after the session completes). Peak memory: one 3000×2000 RGB frame (18 MB) with scaled
decode, 72 MB without. To verify in session 08 or 10 with the chosen crate.

**Malicious-image trade-off (§13 is missing from DESIGN.md; recorded here).** Under A, untrusted
bytes are decoded by Cloudflare's Images service and guests only ever receive Cloudflare's
re-encode. Under B, the Worker never decodes: it stores the booth's JPEG as-is after a header
walk, so a crafted file would reach guests' browsers' JPEG decoders. Only enrolled, revocable
booth devices (bearer credential plus a signed per-photo URL) can upload, so the attacker would
need a stolen, unrevoked tablet. Mitigations under B: the header walk (SOI, segment allowlist
APP0/APP2-ICC/APP14/DQT/DHT/DRI/SOF0–2, SOF dimensions within limits and equal to the declared
ones, SOS reached within 64 KB), the sha256 and declared byte size, per-variant size caps
(thumb ≤ 200 KB, HD ≤ 3 MB), `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, the
gallery CSP, and device revocation. Residual risk: a valid-header JPEG with a crafted entropy
segment aimed at a browser decoder bug. That is accepted for MVP (owned devices, and browsers'
JPEG decoders are heavily fuzzed); revisit if uploads ever come from devices we don't own.

### Q12 cost model

Assumptions: 4 events/month × 500 photos, 90-day retention → about 6,000 photos stored. Event day:
one booth, about 200 guests, gallery polling only while the tab is visible. Prices from the
Cloudflare docs on 2026-10-22: Workers Free 100,000 requests/day and 10 ms CPU per request;
Workers Paid USD 5/month with 10 M requests and 30 M CPU-ms; R2 free 10 GB-month, 1 M Class A,
10 M Class B per month, then USD 0.015/GB-month; Images 5,000 unique transformations/month free,
then USD 0.50 per 1,000; D1 Free 5 M rows read/day and 100 k rows written/day (enforced since
2026-09-01).

**Requests on an event day** (option B; A is the same minus one PUT per photo):

| Source | Typical | Heavy | Notes |
|---|---|---|---|
| Booth uploads | 1,500 | 1,500 | intent + 2 PUTs per photo × 500 |
| Booth status calls | 720 | 720 | one call every 30 s for 6 h |
| Gallery opens + token swap | 800 | 800 | 200 guests × 3 opens + 200 swaps (SPA assets are static, free) |
| Gallery polls | 8,000 | 48,000 | 200 guests × visible time ÷ interval: 20 min at 30 s, vs 60 min at 15 s |
| Media | 22,000 | 42,000 | 100 vs 200 thumbs plus 10 HD views per guest; private immutable caching stops refetches |
| **Total** | **≈ 33,000** | **≈ 93,000** | Free limit 100,000/day (resets 00:00 UTC; an NZ evening event falls in one UTC day) |

D1 reads on that day: a poll reads at most 1 event row + 24 photo rows through the
`(event_id, state, hidden, published_at, id)` index, and media access 2 rows, so ≤ 0.3 M
(typical) to 1.3 M (heavy) of the 5 M/day. Writes: about 500 × 4 plus one `last_seen` per
device call, ≈ 5,000 of 100,000/day.

**Monthly cost:**

| Item | Option B (Workers Free) | Option A (Workers Paid, 2 variants) |
|---|---|---|
| Workers | USD 0 (Free) | USD 5.00 (CPU 2,000 × 0.47 s ≈ 0.9 M ms of 30 M included) |
| Images | 0 transformations | 4,000 → USD 0 (3 variants: 6,000 → +USD 0.50, and needs the Images Paid plan) |
| R2 storage | 6,000 × 0.43 MB ≈ 2.6 GB (worst fixture 3.7 GB) → USD 0 | thumb + HD ≈ 3–4 GB, plus transient originals ≈ 0.3 GB-month → USD 0 |
| R2 Class A | 2 puts × 2,000 = 4,000 → USD 0 | 3 puts × 2,000 = 6,000 → USD 0 |
| R2 Class B | 90–170 k media reads + 4 k range reads → USD 0 | similar plus processing reads → USD 0 |
| D1 | inside Free → USD 0 | inside Paid → USD 0 |
| **Total** | **USD 0** | **≈ USD 5.00–5.50** |

The `.co.nz` domain (about NZD 30/year at a typical registrar, ≈ USD 1.50/month) is outside
Cloudflare and applies to both. **Workers plan decision (for the user):** option B fits Free with
3× headroom on a typical day, but the heavy case is close to the 100,000/day hard limit, and
going over it fails *all* requests (uploads too) until 00:00 UTC. The design therefore needs:
polls at ≥ 30 s with no polling when hidden, `Cache-Control: private, max-age=31536000,
immutable` on media (keys never change), and 24-photo pages. Suggested: stay on Free for staging
and the pilot, read the pilot's peak requests/day (session 18), and switch production to Workers
Paid (USD 5, unlimited requests) if the peak is over 50,000. Either way the total stays well
inside USD 20.

## Clean-up

Done on 2026-10-22, in this order:

1. `POST /cleanup` on the spike Worker: `{"deleted": 32}`, and a second call `{"deleted": 0}`.
   This replaces one `wrangler r2 object delete` per object.
2. `wrangler delete portal-spike --force` → `Successfully deleted portal-spike`.
3. `wrangler r2 bucket delete portal-spike` → `Deleted bucket portal-spike.` (R2 refuses to delete a
   non-empty bucket, so this also confirms step 1.)
4. Check: `wrangler r2 bucket list` no longer lists `portal-spike`, and the `workers.dev` URL
   returns 404.

No other resources were created. R2 stays enabled on the personal account (free, with no
buckets). The account stays on Workers Free. The spike source stays in `worker/` for reference
and is not deployed again.

## Gotchas

- **`bunx wrangler` silently does nothing on this Windows PC when Node isn't on PATH**: Bun runs
  wrangler itself, prints the banner and exits 0 without making any call. Use
  `fnm exec --using=22.11.0 -- node node_modules/wrangler/bin/wrangler.js …`, or put Node on PATH.
- R2 must be enabled once in the dashboard (`code: 10042` otherwise).
- On Workers Free, a fresh deploy gets a short CPU allowance: the first few heavy requests pass
  and then `exceededCpu` sets in. Measure CPU from `wrangler tail`, not from success rates.
- `wrangler tail` samples under load (n below the request count in the tables above).
- The Images binding's types have no `metadata` option, and passing one is silently ignored.
