"""Tests for jpeginfo.py. Run: python -I wiki/portal/spike/scripts/test_jpeginfo.py

Builds small synthetic JPEGs with Pillow, so no fixture photo is needed.
"""

import io
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

import jpeginfo  # noqa: E402

GPS_IFD = 0x8825
EXIF_IFD = 0x8769


def jpeg(width=64, height=32, exif=None):
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), (200, 30, 30))
    if exif is None:
        img.save(buf, "JPEG", quality=80)
    else:
        img.save(buf, "JPEG", quality=80, exif=exif)
    return buf.getvalue()


def tagged_exif(orientation=None, gps=False, serial=None):
    exif = Image.Exif()
    exif[0x010F] = "SONY"
    if orientation is not None:
        exif[0x0112] = orientation
    if serial is not None:
        exif.get_ifd(EXIF_IFD)[0xA431] = serial
    if gps:
        exif.get_ifd(GPS_IFD).update({1: "S", 2: (36.0, 52.0, 0.0), 3: "E", 4: (174.0, 45.0, 0.0)})
    return exif


class InspectTest(unittest.TestCase):
    def test_plain_jpeg_has_no_exif(self):
        info = jpeginfo.inspect(jpeg())
        self.assertEqual((info["width"], info["height"]), (64, 32))
        self.assertIsNone(info["exif"])
        self.assertFalse(info["has_gps"])

    def test_reads_orientation_gps_and_serial(self):
        info = jpeginfo.inspect(jpeg(exif=tagged_exif(orientation=6, gps=True, serial="1234567")))
        self.assertEqual(info["exif"]["orientation"], 6)
        self.assertTrue(info["has_gps"])
        self.assertEqual(info["exif"]["body_serial"], "1234567")
        self.assertEqual(info["exif"]["make"], "SONY")

    def test_lists_app_segments(self):
        info = jpeginfo.inspect(jpeg(exif=tagged_exif()))
        self.assertIn("APP1:Exif", [s["kind"] for s in info["segments"]])

    def test_detects_xmp_and_trailing_data(self):
        data = jpeg()
        xmp = b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta/>"
        seg = b"\xff\xe1" + (len(xmp) + 2).to_bytes(2, "big") + xmp
        data = data[:2] + seg + data[2:] + b"TRAILING"
        info = jpeginfo.inspect(data)
        self.assertIn("APP1:XMP", [s["kind"] for s in info["segments"]])
        self.assertEqual(info["trailing_bytes"], 8)


class RetagTest(unittest.TestCase):
    def test_retag_sets_orientation_and_gps_without_reencoding(self):
        src = jpeg(exif=tagged_exif(orientation=1))
        out = jpeginfo.retag(src, orientation=6, gps=True)
        info = jpeginfo.inspect(out)
        self.assertEqual(info["exif"]["orientation"], 6)
        self.assertTrue(info["has_gps"])
        # Image data after the APP1 segment is untouched.
        self.assertEqual(jpeginfo.scan_data(out), jpeginfo.scan_data(src))


if __name__ == "__main__":
    unittest.main()
