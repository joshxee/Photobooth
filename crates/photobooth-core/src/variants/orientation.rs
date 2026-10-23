//! EXIF orientation: reading tag 0x0112 from the APP1 TIFF block, and applying it to pixels.
//!
//! A small parser rather than a crate: only one tag of IFD0 is needed, and every read is
//! bounds-checked, so a damaged or hostile block gives orientation 1, never a panic.

/// The EXIF orientation of `jpeg` (1–8). Missing, unreadable or out-of-range means 1.
///
/// Only the first APP1 that starts with `Exif\0\0` is read; other APP1 segments (XMP) are
/// skipped. The walk stops at the first SOS, since EXIF must come before the scan.
pub fn exif_orientation(jpeg: &[u8]) -> u16 {
    exif_tiff(jpeg)
        .and_then(tiff_orientation)
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1)
}

/// The TIFF block of the first EXIF APP1 segment.
fn exif_tiff(jpeg: &[u8]) -> Option<&[u8]> {
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    loop {
        if *jpeg.get(i)? != 0xFF {
            return None;
        }
        let marker = *jpeg.get(i + 1)?;
        match marker {
            // Fill byte: the marker follows.
            0xFF => {
                i += 1;
                continue;
            }
            // SOS, EOI: no EXIF before the scan.
            0xDA | 0xD9 => return None,
            // Markers without a length.
            0x01 | 0xD0..=0xD7 => {
                i += 2;
                continue;
            }
            _ => {}
        }
        let len = usize::from(u16::from_be_bytes([*jpeg.get(i + 2)?, *jpeg.get(i + 3)?]));
        let payload = jpeg.get(i + 4..(i + 2).checked_add(len)?)?;
        if marker == 0xE1 {
            if let Some(tiff) = payload.strip_prefix(b"Exif\0\0") {
                return Some(tiff);
            }
        }
        i += 2 + len;
    }
}

/// Tag 0x0112 of IFD0, if it is a SHORT.
fn tiff_orientation(tiff: &[u8]) -> Option<u16> {
    let big = match tiff.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(at..at.checked_add(2)?)?.try_into().ok()?;
        Some(if big {
            u16::from_be_bytes(b)
        } else {
            u16::from_le_bytes(b)
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(at..at.checked_add(4)?)?.try_into().ok()?;
        Some(if big {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd0 = usize::try_from(u32_at(4)?).ok()?;
    let entries = usize::from(u16_at(ifd0)?);
    (0..entries).find_map(|k| {
        let entry = ifd0.checked_add(2 + 12 * k)?;
        const SHORT: u16 = 3;
        (u16_at(entry)? == 0x0112 && u16_at(entry + 2)? == SHORT && u32_at(entry + 4)? >= 1)
            .then(|| u16_at(entry + 8))
            .flatten()
    })
}

/// Applies `orientation` to a packed RGB frame and returns it upright with its new size.
/// Orientations 5–8 swap width and height. Anything outside 2–8 returns the frame unchanged.
pub(crate) fn orient(
    px: Vec<u8>,
    width: u32,
    height: u32,
    orientation: u16,
) -> (Vec<u8>, u32, u32) {
    let (w, h) = (width as usize, height as usize);
    // For output pixel (x, y), the stored pixel it comes from (EXIF 2.32, tag 0x0112).
    let source: fn(usize, usize, usize, usize) -> (usize, usize) = match orientation {
        2 => |x, y, w, _| (w - 1 - x, y),
        3 => |x, y, w, h| (w - 1 - x, h - 1 - y),
        4 => |x, y, _, h| (x, h - 1 - y),
        5 => |x, y, _, _| (y, x),
        6 => |x, y, _, h| (y, h - 1 - x),
        7 => |x, y, w, h| (w - 1 - y, h - 1 - x),
        8 => |x, y, w, _| (w - 1 - y, x),
        _ => return (px, width, height),
    };
    let (ow, oh) = if orientation >= 5 { (h, w) } else { (w, h) };
    let mut out = vec![0u8; px.len()];
    for y in 0..oh {
        let row = &mut out[y * ow * 3..(y + 1) * ow * 3];
        for (x, dst) in row.chunks_exact_mut(3).enumerate() {
            let (sx, sy) = source(x, y, w, h);
            let at = (sy * w + sx) * 3;
            dst.copy_from_slice(&px[at..at + 3]);
        }
    }
    (out, ow as u32, oh as u32)
}
