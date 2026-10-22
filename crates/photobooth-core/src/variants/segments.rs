//! The header rules a variant must pass: the same rules as the portal Worker's header walk
//! (DESIGN §9.1), plus a walk of the scan, which the Worker cannot afford and the booth can.

use thiserror::Error;

/// The Worker reads only this much of an object, so the scan must start inside it.
pub const HEADER_WINDOW: usize = 64 * 1024;

/// Why a JPEG fails [`check_segments`].
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SegmentError {
    #[error("does not start with SOI")]
    NoSoi,
    #[error("ends inside a segment")]
    Truncated,
    #[error("expected a marker at byte {0}")]
    Malformed(usize),
    #[error("segment {0:#04x} is not allowed")]
    NotAllowed(u8),
    #[error("frame: {0}")]
    Frame(&'static str),
    #[error("the scan starts after the first {HEADER_WINDOW} bytes")]
    ScanTooLate,
    #[error("marker {0:#04x} inside the scan (more than one scan)")]
    Scan(u8),
    #[error("does not end with EOI right after the scan")]
    Ending,
}

/// Checks a variant against the portal's header rules and returns its frame size
/// (width, height):
///
/// - SOI first; before the scan only APP0, APP14, DQT, DHT, DRI and exactly one SOF0
///   (8-bit baseline). Any other segment, including APP1 (EXIF, XMP), APP2 (ICC, MPF), APP13
///   (IPTC) and COM, fails, and so does a progressive, extended or lossless frame.
/// - The SOS header ends within the first [`HEADER_WINDOW`] bytes.
/// - Stricter than the Worker: the entropy-coded data holds only stuffed bytes and RSTn, so
///   there is exactly one scan, and the first EOI is the last two bytes of the file (the
///   Worker only checks the last two bytes).
pub fn check_segments(jpeg: &[u8]) -> Result<(u32, u32), SegmentError> {
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return Err(SegmentError::NoSoi);
    }
    let mut frame = None;
    let mut i = 2;
    let scan_start = loop {
        let Some(header) = jpeg.get(i..i + 4) else {
            return Err(SegmentError::Truncated);
        };
        if header[0] != 0xFF {
            return Err(SegmentError::Malformed(i));
        }
        let marker = header[1];
        let len = usize::from(u16::from_be_bytes([header[2], header[3]]));
        if len < 2 {
            return Err(SegmentError::Malformed(i + 2));
        }
        let end = i + 2 + len;
        let Some(payload) = jpeg.get(i + 4..end) else {
            return Err(SegmentError::Truncated);
        };
        match marker {
            // APP0 (JFIF), APP14 (Adobe), DQT, DHT, DRI.
            0xE0 | 0xEE | 0xDB | 0xC4 | 0xDD => {}
            0xC0 => {
                if frame.is_some() {
                    return Err(SegmentError::Frame("more than one SOF"));
                }
                let [precision, h0, h1, w0, w1, ..] = *payload else {
                    return Err(SegmentError::Truncated);
                };
                if precision != 8 {
                    return Err(SegmentError::Frame("not 8-bit"));
                }
                let (width, height) = (u16::from_be_bytes([w0, w1]), u16::from_be_bytes([h0, h1]));
                if width == 0 || height == 0 {
                    return Err(SegmentError::Frame("zero size"));
                }
                frame = Some((u32::from(width), u32::from(height)));
            }
            0xDA => {
                if frame.is_none() {
                    return Err(SegmentError::Frame("SOS before SOF"));
                }
                if end > HEADER_WINDOW {
                    return Err(SegmentError::ScanTooLate);
                }
                break end;
            }
            other => return Err(SegmentError::NotAllowed(other)),
        }
        i = end;
    };
    check_scan(&jpeg[scan_start..])?;
    frame.ok_or(SegmentError::Frame("SOS before SOF"))
}

/// The entropy-coded data after the SOS header: stuffed `FF 00` and `FF D0`–`FF D7` are the
/// only markers allowed, and `FF D9` must be the last two bytes.
fn check_scan(scan: &[u8]) -> Result<(), SegmentError> {
    let mut i = 0;
    while let Some(at) = scan[i..].iter().position(|&b| b == 0xFF) {
        let at = i + at;
        match scan.get(at + 1) {
            Some(0x00 | 0xD0..=0xD7) => i = at + 2,
            Some(0xD9) if at + 2 == scan.len() => return Ok(()),
            Some(0xD9) | None => return Err(SegmentError::Ending),
            Some(&other) => return Err(SegmentError::Scan(other)),
        }
    }
    Err(SegmentError::Ending)
}
