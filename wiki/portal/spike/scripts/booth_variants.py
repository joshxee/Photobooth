"""Option B estimate: make thumb + HD variants the way the booth would (session 01, throwaway).

  python -I booth_variants.py <out-dir> <file.jpg> [...]

Pillow uses libjpeg-turbo, the same codec family a Rust build would use (turbojpeg crate) and
close to zune-jpeg/jpeg-encoder speeds. Prints JSON: per file and setting, output bytes and
encode times on this PC. "draft" decodes with libjpeg DCT scaling (1/2 or 1/4), which most
Rust decoders can also do; "full" decodes every pixel first.
"""

import io
import json
import os
import sys
import time

from PIL import Image, ImageOps

SETTINGS = [
    ("thumb", 480, 75),
    ("hd2048", 2048, 85),
    ("hd2560", 2560, 85),
    ("hd2560q90", 2560, 90),
]


def encode(img, edge, quality):
    out = img.copy()
    out.thumbnail((edge, edge), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    # No exif=, no icc_profile=: the output has no APP1/APP13, only APP0 JFIF.
    out.save(buf, "JPEG", quality=quality, optimize=True, progressive=False)
    return buf.getvalue(), out.size


def run(path, out_dir, mode):
    data = open(path, "rb").read()
    results = {}
    for name, edge, quality in SETTINGS:
        t0 = time.perf_counter()
        img = Image.open(io.BytesIO(data))
        if mode == "draft":
            # Ask for the short side too, or libjpeg will not scale a 3:2 frame.
            img.draft("RGB", (edge, edge * 2 // 3))
        img = ImageOps.exif_transpose(img.convert("RGB"))
        t1 = time.perf_counter()
        jpg, size = encode(img, edge, quality)
        t2 = time.perf_counter()
        base = os.path.splitext(os.path.basename(path))[0][:8]
        with open(os.path.join(out_dir, f"{base}-{mode}-{name}.jpg"), "wb") as f:
            f.write(jpg)
        results[name] = {
            "bytes": len(jpg),
            "size": size,
            "decode_ms": round((t1 - t0) * 1000),
            "resize_encode_ms": round((t2 - t1) * 1000),
        }
    return results


def main(argv):
    out_dir, files = argv[0], argv[1:]
    os.makedirs(out_dir, exist_ok=True)
    for path in files:
        for mode in ("full", "draft"):
            print(json.dumps({"file": os.path.basename(path)[:8], "mode": mode, **run(path, out_dir, mode)}))


if __name__ == "__main__":
    main(sys.argv[1:])
