"""Inspect or retag JPEG metadata without exiftool (spike session 01, throwaway).

  python -I jpeginfo.py inspect <file.jpg> [...]       JSON report per file
  python -I jpeginfo.py retag <src> <dst> [--orientation N] [--gps]

`inspect` uses only the standard library. `retag` needs Pillow to rebuild the Exif block; it
splices the new APP1 segment in place of the old one and leaves the image data untouched.
"""

import json
import struct
import sys

SOF_MARKERS = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
STANDALONE = {0x01, *range(0xD0, 0xD8)}
TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}

TAG_ORIENTATION = 0x0112
TAG_MAKE = 0x010F
TAG_MODEL = 0x0110
TAG_EXIF_IFD = 0x8769
TAG_GPS_IFD = 0x8825
TAG_BODY_SERIAL = 0xA431
TAG_LENS_SERIAL = 0xA435
TAG_MAKER_NOTE = 0x927C


def segments(data):
    """Yields (marker, offset, length) for each marker segment up to SOS."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    pos = 2
    while pos < len(data):
        if data[pos] != 0xFF:
            raise ValueError(f"bad marker at {pos}")
        marker = data[pos + 1]
        if marker == 0xFF:
            pos += 1
            continue
        if marker in STANDALONE:
            pos += 2
            continue
        length = struct.unpack(">H", data[pos + 2 : pos + 4])[0]
        yield marker, pos, length
        if marker == 0xDA:
            return
        pos += 2 + length


def scan_data(data):
    """Bytes from the SOS marker to the end: the compressed image, unaffected by retagging."""
    for marker, pos, _ in segments(data):
        if marker == 0xDA:
            return data[pos:]
    raise ValueError("no SOS")


def end_of_image(data):
    """Offset just past the first EOI after SOS. Sony appends MPF preview JPEGs after it."""
    sos = len(data) - len(scan_data(data))
    i = sos
    while True:
        i = data.index(b"\xff", i)
        nxt = data[i + 1]
        if nxt == 0xD9:
            return i + 2
        i += 1 if nxt == 0xFF else 2


def segment_kind(marker, payload):
    if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
        return "APP1:Exif"
    if marker == 0xE1 and payload.startswith(b"http://ns.adobe.com/xap/1.0/"):
        return "APP1:XMP"
    if marker == 0xE2 and payload.startswith(b"ICC_PROFILE"):
        return "APP2:ICC"
    if marker == 0xE2 and payload.startswith(b"MPF\x00"):
        return "APP2:MPF"
    if 0xE0 <= marker <= 0xEF:
        return f"APP{marker - 0xE0}:{payload[:8].split(b'\x00')[0].decode('latin-1')}"
    if marker == 0xFE:
        return "COM"
    return f"0x{marker:02X}"


class Tiff:
    def __init__(self, tiff):
        self.b = tiff
        self.e = "<" if tiff[:2] == b"II" else ">"

    def u16(self, off):
        return struct.unpack(self.e + "H", self.b[off : off + 2])[0]

    def u32(self, off):
        return struct.unpack(self.e + "I", self.b[off : off + 4])[0]

    def ifd(self, off):
        """Returns {tag: (type, count, value_or_offset_field_pos)} and the next-IFD offset."""
        entries = {}
        n = self.u16(off)
        for i in range(n):
            e = off + 2 + 12 * i
            entries[self.u16(e)] = (self.u16(e + 2), self.u32(e + 4), e + 8)
        return entries, self.u32(off + 2 + 12 * n)

    def value(self, entry):
        typ, count, field = entry
        size = TYPE_SIZES.get(typ, 1) * count
        pos = field if size <= 4 else self.u32(field)
        raw = self.b[pos : pos + size]
        if typ == 2:
            return raw.split(b"\x00")[0].decode("latin-1").strip()
        if typ == 3 and count == 1:
            return self.u16(field)
        if typ == 4 and count == 1:
            return self.u32(field)
        return {"type": typ, "bytes": size}


def parse_exif(payload):
    t = Tiff(payload[6:])
    ifd0, ifd1_off = t.ifd(t.u32(4))
    out = {
        "make": t.value(ifd0[TAG_MAKE]) if TAG_MAKE in ifd0 else None,
        "model": t.value(ifd0[TAG_MODEL]) if TAG_MODEL in ifd0 else None,
        "orientation": t.value(ifd0[TAG_ORIENTATION]) if TAG_ORIENTATION in ifd0 else None,
        "ifd0_tags": len(ifd0),
        "has_ifd1_thumbnail": ifd1_off != 0,
        "gps_tags": 0,
        "exif_tags": 0,
        "body_serial": None,
        "lens_serial": None,
        "maker_note_bytes": 0,
    }
    if TAG_GPS_IFD in ifd0:
        gps, _ = t.ifd(t.value(ifd0[TAG_GPS_IFD]))
        out["gps_tags"] = len(gps)
    if TAG_EXIF_IFD in ifd0:
        exif, _ = t.ifd(t.value(ifd0[TAG_EXIF_IFD]))
        out["exif_tags"] = len(exif)
        if TAG_BODY_SERIAL in exif:
            out["body_serial"] = t.value(exif[TAG_BODY_SERIAL])
        if TAG_LENS_SERIAL in exif:
            out["lens_serial"] = t.value(exif[TAG_LENS_SERIAL])
        if TAG_MAKER_NOTE in exif:
            out["maker_note_bytes"] = exif[TAG_MAKER_NOTE][1]
    return out


def inspect(data):
    info = {"bytes": len(data), "width": None, "height": None, "segments": [], "exif": None}
    for marker, pos, length in segments(data):
        payload = data[pos + 4 : pos + 2 + length]
        if marker in SOF_MARKERS:
            info["height"], info["width"] = struct.unpack(">HH", payload[1:5])
        kind = segment_kind(marker, payload)
        if 0xE0 <= marker <= 0xEF or marker == 0xFE:
            info["segments"].append({"kind": kind, "bytes": length + 2})
        if kind == "APP1:Exif" and info["exif"] is None:
            info["exif"] = parse_exif(payload)
    info["trailing_bytes"] = len(data) - end_of_image(data)
    # A serial number or GPS block anywhere in the file, including Sony's appended MPF previews.
    info["has_gps"] = bool(info["exif"] and info["exif"]["gps_tags"])
    info["has_body_serial"] = bool(info["exif"] and info["exif"]["body_serial"])
    info["trailing_has_exif"] = b"Exif\x00\x00" in data[end_of_image(data) :]
    return info


def retag(data, orientation=None, gps=False):
    from PIL import Image  # only needed for retagging

    exif = Image.Exif()
    old = None
    for marker, pos, length in segments(data):
        payload = data[pos + 4 : pos + 2 + length]
        if segment_kind(marker, payload) == "APP1:Exif":
            old = (pos, length)
            exif.load(payload)
            break
    if orientation is not None:
        exif[TAG_ORIENTATION] = orientation
    if gps:
        exif.get_ifd(TAG_GPS_IFD).update(
            {1: "S", 2: (36.0, 52.0, 30.0), 3: "E", 4: (174.0, 45.0, 30.0)}
        )
    body = exif.tobytes()
    if not body.startswith(b"Exif\x00\x00"):
        body = b"Exif\x00\x00" + body
    seg = b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body
    if old is None:
        return data[:2] + seg + data[2:]
    pos, length = old
    return data[:pos] + seg + data[pos + 2 + length :]


def main(argv):
    if argv[:1] == ["inspect"]:
        for path in argv[1:]:
            with open(path, "rb") as f:
                print(json.dumps({"file": path, **inspect(f.read())}, indent=1))
        return 0
    if argv[:1] == ["retag"] and len(argv) >= 3:
        src, dst, rest = argv[1], argv[2], argv[3:]
        orientation = int(rest[rest.index("--orientation") + 1]) if "--orientation" in rest else None
        with open(src, "rb") as f:
            out = retag(f.read(), orientation=orientation, gps="--gps" in rest)
        with open(dst, "wb") as f:
            f.write(out)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
