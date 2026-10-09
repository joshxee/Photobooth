//! Small JPEG helpers: pulling the picture out of Sony's live-view envelope and reading
//! pixel dimensions without a decoder.

const SOI: [u8; 2] = [0xFF, 0xD8];
const EOI: [u8; 2] = [0xFF, 0xD9];

/// Extracts the JPEG from a live-view object.
///
/// Sony wraps the frame in a small header (the first two little-endian u32s are believed to
/// be the JPEG's offset and size, followed after the JPEG by focus-frame data). Because that
/// layout is not documented, the header is trusted only if it points at a well-formed JPEG;
/// otherwise the JPEG is found by scanning for the first SOI (`FFD8`) and the last EOI
/// (`FFD9`) after it.
pub fn extract_jpeg(data: &[u8]) -> Option<&[u8]> {
    if data.len() >= 8 {
        let offset = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
        if let Some(end) = offset.checked_add(size) {
            if size >= 4 && end <= data.len() {
                let candidate = &data[offset..end];
                if candidate.starts_with(&SOI) && candidate.ends_with(&EOI) {
                    return Some(candidate);
                }
            }
        }
    }
    let start = data.windows(2).position(|w| w == SOI)?;
    let end = data[start..].windows(2).rposition(|w| w == EOI)? + start + 2;
    (end > start + 2).then(|| &data[start..end])
}

/// Reads `(width, height)` from the first start-of-frame marker.
pub fn dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    if !jpeg.starts_with(&SOI) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        match marker {
            // Fill byte, or markers that carry no length.
            0xFF => {
                i += 1;
                continue;
            }
            0x01 | 0xD0..=0xD8 => {
                i += 2;
                continue;
            }
            0xD9 => return None,
            _ => {}
        }
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            let body = jpeg.get(i + 4..i + 4 + 5)?;
            let height = u32::from(u16::from_be_bytes([body[1], body[2]]));
            let width = u32::from(u16::from_be_bytes([body[3], body[4]]));
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_jpeg(payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(payload);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn extracts_via_header_offsets() {
        let jpeg = fake_jpeg(b"picture");
        let mut data = Vec::new();
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
        data.extend_from_slice(&[0xAB; 8]); // rest of header
        data.extend_from_slice(&jpeg);
        data.extend_from_slice(b"focus frame data");
        assert_eq!(extract_jpeg(&data).unwrap(), &jpeg[..]);
    }

    #[test]
    fn falls_back_to_marker_scan_when_header_is_not_trustworthy() {
        let jpeg = fake_jpeg(b"picture");
        let mut data = vec![0x00; 12]; // header that does not describe a JPEG
        data.extend_from_slice(&jpeg);
        data.extend_from_slice(&[0x11, 0x22]);
        assert_eq!(extract_jpeg(&data).unwrap(), &jpeg[..]);
    }

    #[test]
    fn scan_keeps_nested_markers_by_using_the_last_eoi() {
        // An embedded thumbnail has its own SOI/EOI inside the main image.
        let inner = fake_jpeg(b"thumb");
        let mut payload = b"exif".to_vec();
        payload.extend_from_slice(&inner);
        payload.extend_from_slice(b"main");
        let jpeg = fake_jpeg(&payload);
        let mut data = vec![0u8; 3];
        data.extend_from_slice(&jpeg);
        assert_eq!(extract_jpeg(&data).unwrap(), &jpeg[..]);
    }

    #[test]
    fn returns_none_without_a_complete_jpeg() {
        assert!(extract_jpeg(&[]).is_none());
        assert!(extract_jpeg(&[1, 2, 3, 4]).is_none());
        assert!(extract_jpeg(&[0xFF, 0xD8, 1, 2, 3]).is_none(), "no EOI");
        assert!(
            extract_jpeg(&[0xFF, 0xD9, 1, 0xFF, 0xD8]).is_none(),
            "EOI before SOI"
        );
    }

    #[test]
    fn header_pointing_outside_the_buffer_is_ignored_safely() {
        let jpeg = fake_jpeg(b"x");
        let mut data = Vec::new();
        data.extend_from_slice(&u32::MAX.to_le_bytes());
        data.extend_from_slice(&u32::MAX.to_le_bytes());
        data.extend_from_slice(&jpeg);
        assert_eq!(extract_jpeg(&data).unwrap(), &jpeg[..]);
    }

    #[test]
    fn dimensions_come_from_the_sof_marker() {
        // SOI, APP0 (len 4), SOF0 (len 11): precision 8, height 4000, width 6000.
        let mut j = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00];
        j.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
        j.extend_from_slice(&4000u16.to_be_bytes());
        j.extend_from_slice(&6000u16.to_be_bytes());
        j.extend_from_slice(&[0x01, 0x01, 0x11, 0x00, 0xFF, 0xD9]);
        assert_eq!(dimensions(&j), Some((6000, 4000)));
    }

    #[test]
    fn dimensions_reject_non_jpegs_and_truncation() {
        assert_eq!(dimensions(&[]), None);
        assert_eq!(dimensions(b"not a jpeg"), None);
        assert_eq!(
            dimensions(&[0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x0B, 0x08]),
            None
        );
        assert_eq!(dimensions(&[0xFF, 0xD8, 0xFF, 0xD9]), None);
    }
}
