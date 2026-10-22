//! Every input here is generated in the test: flat colour blocks encoded with `jpeg-encoder`,
//! with metadata segments spliced in by hand. No photo is read from disk.

use super::*;

// ---- input builders ---------------------------------------------------------------------

const RED: [u8; 3] = [230, 20, 20];
const GREEN: [u8; 3] = [20, 200, 20];
const BLUE: [u8; 3] = [20, 20, 230];
const YELLOW: [u8; 3] = [230, 230, 20];
const GREY: [u8; 3] = [128, 128, 128];

/// An RGB frame filled with `fill`.
fn frame(width: u32, height: u32, fill: [u8; 3]) -> Vec<u8> {
    fill.repeat(width as usize * height as usize)
}

/// Paints the four corner quarters-of-a-quarter (a quarter of each dimension) of a frame.
fn paint_corners(px: &mut [u8], width: u32, height: u32, [tl, tr, bl, br]: [[u8; 3]; 4]) {
    let (bw, bh) = (width / 4, height / 4);
    for y in 0..height {
        for x in 0..width {
            let colour = match (x < bw, x >= width - bw, y < bh, y >= height - bh) {
                (true, _, true, _) => tl,
                (_, true, true, _) => tr,
                (true, _, _, true) => bl,
                (_, true, _, true) => br,
                _ => continue,
            };
            let i = (y as usize * width as usize + x as usize) * 3;
            px[i..i + 3].copy_from_slice(&colour);
        }
    }
}

fn encode_rgb(px: &[u8], width: u32, height: u32, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(
            px,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Rgb,
        )
        .expect("test input encodes");
    out
}

fn flat_jpeg(width: u32, height: u32) -> Vec<u8> {
    encode_rgb(&frame(width, height, GREY), width, height, 90)
}

/// Inserts `segments` (marker byte, payload) straight after SOI.
fn with_segments(jpeg: &[u8], segments: &[(u8, Vec<u8>)]) -> Vec<u8> {
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    let mut out = jpeg[..2].to_vec();
    for (marker, payload) in segments {
        out.extend_from_slice(&[0xFF, *marker]);
        out.extend_from_slice(&(payload.len() as u16 + 2).to_be_bytes());
        out.extend_from_slice(payload);
    }
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// One IFD entry: tag, type, count and the value bytes (inline when ≤ 4 bytes, else stored
/// after the IFD and pointed to).
struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    value: Vec<u8>,
}

impl Entry {
    fn short(tag: u16, v: u16, big: bool) -> Self {
        let value = if big {
            v.to_be_bytes()
        } else {
            v.to_le_bytes()
        }
        .to_vec();
        Self {
            tag,
            kind: 3,
            count: 1,
            value,
        }
    }
    fn ascii(tag: u16, s: &str) -> Self {
        let mut value = s.as_bytes().to_vec();
        value.push(0);
        Self {
            tag,
            kind: 2,
            count: value.len() as u32,
            value,
        }
    }
    fn long(tag: u16, v: u32, big: bool) -> Self {
        let value = if big {
            v.to_be_bytes()
        } else {
            v.to_le_bytes()
        }
        .to_vec();
        Self {
            tag,
            kind: 4,
            count: 1,
            value,
        }
    }
    fn rationals(tag: u16, parts: &[(u32, u32)], big: bool) -> Self {
        let mut value = Vec::new();
        for (n, d) in parts {
            for x in [n, d] {
                value.extend(if big {
                    x.to_be_bytes()
                } else {
                    x.to_le_bytes()
                });
            }
        }
        Self {
            tag,
            kind: 5,
            count: parts.len() as u32,
            value,
        }
    }
}

/// Serialises one IFD at `offset` (from the TIFF header) with no next IFD; returns its bytes.
fn ifd(entries: &[Entry], offset: u32, big: bool) -> Vec<u8> {
    let u16b = |v: u16| {
        if big {
            v.to_be_bytes()
        } else {
            v.to_le_bytes()
        }
    };
    let u32b = |v: u32| {
        if big {
            v.to_be_bytes()
        } else {
            v.to_le_bytes()
        }
    };
    let mut head = u16b(entries.len() as u16).to_vec();
    let mut data = Vec::new();
    let data_start = offset + 2 + 12 * entries.len() as u32 + 4;
    for e in entries {
        head.extend(u16b(e.tag));
        head.extend(u16b(e.kind));
        head.extend(u32b(e.count));
        if e.value.len() <= 4 {
            let mut v = e.value.clone();
            v.resize(4, 0);
            head.extend(v);
        } else {
            head.extend(u32b(data_start + data.len() as u32));
            data.extend(&e.value);
            if data.len() % 2 == 1 {
                data.push(0);
            }
        }
    }
    head.extend(u32b(0));
    head.extend(data);
    head
}

/// Size of an IFD as [`ifd`] writes it (needed to place the next one).
fn ifd_len(entries: &[Entry]) -> u32 {
    ifd(entries, 0, true).len() as u32
}

const BODY_SERIAL: &str = "BODYSERIAL4711";
const LENS_SERIAL: &str = "LENSSERIAL0815";
const MAKE: &str = "TESTMAKER";
const XMP_MARK: &str = "XMPSECRET-CREATOR";
const IPTC_MARK: &str = "IPTCSECRET-BYLINE";
const COM_MARK: &str = "COMSECRET-NOTE";
/// GPS latitude 36° 51' 8.5" S; the rational bytes are searched for in the outputs.
const GPS_LAT: [(u32, u32); 3] = [(36, 1), (51, 1), (8_571_234, 1_000_000)];

/// An APP1 EXIF payload: IFD0 (Orientation if given, Make, Exif and GPS pointers), an Exif
/// IFD with body and lens serial numbers, and a GPS IFD with a latitude.
fn exif_app1(orientation: Option<u16>, big: bool) -> Vec<u8> {
    let mut ifd0_entries = Vec::new();
    if let Some(o) = orientation {
        ifd0_entries.push(Entry::short(0x0112, o, big));
    }
    ifd0_entries.push(Entry::ascii(0x010F, MAKE));
    // Pointers are patched below once the IFD sizes are known.
    ifd0_entries.push(Entry::long(0x8769, 0, big));
    ifd0_entries.push(Entry::long(0x8825, 0, big));
    let exif_entries = [
        Entry::ascii(0xA431, BODY_SERIAL),
        Entry::ascii(0xA435, LENS_SERIAL),
    ];
    let gps_entries = [
        Entry::ascii(0x0001, "S"),
        Entry::rationals(0x0002, &GPS_LAT, big),
    ];
    let ifd0_at = 8;
    let exif_at = ifd0_at + ifd_len(&ifd0_entries);
    let gps_at = exif_at + ifd_len(&exif_entries);
    let n = ifd0_entries.len();
    ifd0_entries[n - 2] = Entry::long(0x8769, exif_at, big);
    ifd0_entries[n - 1] = Entry::long(0x8825, gps_at, big);

    let mut tiff = if big {
        b"MM\0\x2a".to_vec()
    } else {
        b"II\x2a\0".to_vec()
    };
    tiff.extend(if big {
        8u32.to_be_bytes()
    } else {
        8u32.to_le_bytes()
    });
    tiff.extend(ifd(&ifd0_entries, ifd0_at, big));
    tiff.extend(ifd(&exif_entries, exif_at, big));
    tiff.extend(ifd(&gps_entries, gps_at, big));
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend(tiff);
    app1
}

fn gps_bytes() -> Vec<u8> {
    let mut v = Vec::new();
    for (n, d) in GPS_LAT {
        v.extend(n.to_be_bytes());
        v.extend(d.to_be_bytes());
    }
    v
}

fn xmp_app1() -> Vec<u8> {
    let mut v = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
    v.extend(format!("<x:xmpmeta><dc:creator>{XMP_MARK}</dc:creator></x:xmpmeta>").bytes());
    v
}

fn iptc_app13() -> Vec<u8> {
    let mut v = b"Photoshop 3.0\08BIM\x04\x04\0\0".to_vec();
    let record = format!("\x1c\x02\x50\0{}{IPTC_MARK}", IPTC_MARK.len() as u8 as char);
    v.extend((record.len() as u32).to_be_bytes());
    v.extend(record.bytes());
    v
}

/// An upright `width`×`height` scene (TL red, TR green, BL blue, BR yellow), stored the way a
/// camera with EXIF `orientation` stores it. The table is the EXIF definition of where the
/// stored 0th row and 0th column are, written out per stored corner (TL, TR, BL, BR), so it is
/// independent of the code under test.
fn oriented_input(width: u32, height: u32, orientation: u16) -> Vec<u8> {
    const TL: [u8; 3] = RED;
    const TR: [u8; 3] = GREEN;
    const BL: [u8; 3] = BLUE;
    const BR: [u8; 3] = YELLOW;
    let stored_corners = match orientation {
        1 => [TL, TR, BL, BR],
        2 => [TR, TL, BR, BL],
        3 => [BR, BL, TR, TL],
        4 => [BL, BR, TL, TR],
        5 => [TL, BL, TR, BR],
        6 => [TR, BR, TL, BL],
        7 => [BR, TR, BL, TL],
        8 => [BL, TL, BR, TR],
        _ => unreachable!(),
    };
    let (sw, sh) = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    let mut px = frame(sw, sh, GREY);
    paint_corners(&mut px, sw, sh, stored_corners);
    let jpeg = encode_rgb(&px, sw, sh, 92);
    with_segments(
        &jpeg,
        &[(0xE1, exif_app1(Some(orientation), orientation > 4))],
    )
}

// ---- output readers ---------------------------------------------------------------------

fn decode(jpeg: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut d = jpeg_decoder::Decoder::new(jpeg);
    let px = d.decode().expect("output decodes");
    let info = d.info().expect("info");
    assert_eq!(info.pixel_format, jpeg_decoder::PixelFormat::RGB24);
    (u32::from(info.width), u32::from(info.height), px)
}

fn size(jpeg: &[u8]) -> (u32, u32) {
    let (w, h, _) = decode(jpeg);
    (w, h)
}

fn pixel(px: &[u8], width: u32, x: u32, y: u32) -> [u8; 3] {
    let i = (y as usize * width as usize + x as usize) * 3;
    [px[i], px[i + 1], px[i + 2]]
}

fn close(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 24)
}

/// Checks the colour at the centre of each corner block of an upright output.
fn assert_upright(jpeg: &[u8], label: &str) {
    let (w, h, px) = decode(jpeg);
    let (cx, cy) = (w / 8, h / 8);
    let at = |x, y| pixel(&px, w, x, y);
    for (got, want, corner) in [
        (at(cx, cy), RED, "top-left"),
        (at(w - 1 - cx, cy), GREEN, "top-right"),
        (at(cx, h - 1 - cy), BLUE, "bottom-left"),
        (at(w - 1 - cx, h - 1 - cy), YELLOW, "bottom-right"),
    ] {
        assert!(
            close(got, want),
            "{label}: {corner} is {got:?}, expected {want:?}"
        );
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn segment_markers(jpeg: &[u8]) -> Vec<u8> {
    let mut markers = Vec::new();
    let mut i = 2;
    while i + 4 <= jpeg.len() && jpeg[i] == 0xFF {
        let m = jpeg[i + 1];
        markers.push(m);
        if m == 0xDA {
            break;
        }
        i += 2 + usize::from(u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]));
    }
    markers
}

// ---- encode_variants ---------------------------------------------------------------------

#[test]
fn every_orientation_comes_out_upright_with_the_oriented_size() {
    for orientation in 1..=8u16 {
        let input = oriented_input(600, 400, orientation);
        assert_eq!(exif_orientation(&input), orientation, "parsed orientation");
        let shot = encode_variants(&input).unwrap_or_else(|e| panic!("{orientation}: {e}"));
        // Smaller than 2560: HD keeps the upright size; the thumb fits 480.
        assert_eq!(
            (shot.width, shot.height),
            (600, 400),
            "orientation {orientation}"
        );
        assert_eq!(size(&shot.hd), (600, 400));
        assert_eq!(size(&shot.thumb), (480, 320));
        assert_upright(&shot.hd, &format!("hd, orientation {orientation}"));
        assert_upright(&shot.thumb, &format!("thumb, orientation {orientation}"));
    }
}

#[test]
fn a_24_mp_landscape_fits_2560_and_480() {
    let shot = encode_variants(&flat_jpeg(6000, 4000)).unwrap();
    assert_eq!((shot.width, shot.height), (2560, 1707));
    assert_eq!(size(&shot.hd), (2560, 1707));
    assert_eq!(size(&shot.thumb), (480, 320));
}

#[test]
fn a_portrait_input_gives_the_transpose() {
    let shot = encode_variants(&flat_jpeg(4000, 6000)).unwrap();
    assert_eq!((shot.width, shot.height), (1707, 2560));
    assert_eq!(size(&shot.hd), (1707, 2560));
    assert_eq!(size(&shot.thumb), (320, 480));
}

#[test]
fn an_orientation_6_landscape_capture_comes_out_portrait() {
    let input = with_segments(&flat_jpeg(6000, 4000), &[(0xE1, exif_app1(Some(6), true))]);
    let shot = encode_variants(&input).unwrap();
    assert_eq!((shot.width, shot.height), (1707, 2560));
    assert_eq!(size(&shot.thumb), (320, 480));
}

#[test]
fn small_inputs_are_never_upscaled() {
    let shot = encode_variants(&flat_jpeg(400, 300)).unwrap();
    assert_eq!((shot.width, shot.height), (400, 300));
    assert_eq!(size(&shot.hd), (400, 300));
    assert_eq!(size(&shot.thumb), (400, 300));

    // Between the two edges: the thumb shrinks, HD keeps its size.
    let shot = encode_variants(&flat_jpeg(2000, 1000)).unwrap();
    assert_eq!((shot.width, shot.height), (2000, 1000));
    assert_eq!(size(&shot.thumb), (480, 240));
}

#[test]
fn a_greyscale_input_is_encoded_as_rgb() {
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 90)
        .encode(&[90u8; 64 * 48], 64, 48, jpeg_encoder::ColorType::Luma)
        .unwrap();
    let shot = encode_variants(&out).unwrap();
    assert_eq!((shot.width, shot.height), (64, 48));
    check_segments(&shot.hd).unwrap();
}

#[test]
fn metadata_in_the_input_never_reaches_the_variants() {
    let input = with_segments(
        &flat_jpeg(3000, 2000),
        &[
            (0xE1, exif_app1(Some(1), true)),
            (0xE1, xmp_app1()),
            (0xED, iptc_app13()),
            (0xFE, COM_MARK.as_bytes().to_vec()),
        ],
    );
    // The fixture really carries what the test claims.
    for needle in [
        BODY_SERIAL.as_bytes(),
        LENS_SERIAL.as_bytes(),
        MAKE.as_bytes(),
        &gps_bytes(),
        XMP_MARK.as_bytes(),
        IPTC_MARK.as_bytes(),
        COM_MARK.as_bytes(),
    ] {
        assert!(contains(&input, needle));
    }
    let shot = encode_variants(&input).unwrap();
    for (name, out) in [("thumb", &shot.thumb), ("hd", &shot.hd)] {
        check_segments(out).unwrap_or_else(|e| panic!("{name}: {e}"));
        let mut markers = segment_markers(out);
        markers.dedup();
        assert_eq!(
            markers,
            [0xE0, 0xC0, 0xDB, 0xC4, 0xDA],
            "{name}: APP0, SOF0, DQT, DHT, SOS only"
        );
        for needle in [
            BODY_SERIAL.as_bytes(),
            LENS_SERIAL.as_bytes(),
            MAKE.as_bytes(),
            &gps_bytes(),
            XMP_MARK.as_bytes(),
            IPTC_MARK.as_bytes(),
            COM_MARK.as_bytes(),
            b"Exif\0\0",
            b"http://ns.adobe.com",
            b"Photoshop 3.0",
        ] {
            assert!(
                !contains(out, needle),
                "{name} contains {:?}",
                String::from_utf8_lossy(needle)
            );
        }
    }
}

#[test]
fn corrupt_or_truncated_inputs_are_errors_not_panics() {
    let good = flat_jpeg(640, 480);
    let mut flipped = good.clone();
    for b in flipped.iter_mut().skip(200).step_by(7) {
        *b ^= 0x5A;
    }
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("not a JPEG", b"GIF89a not a jpeg at all".to_vec()),
        ("SOI only", vec![0xFF, 0xD8]),
        ("header only", good[..good.len().min(300)].to_vec()),
        ("half", good[..good.len() / 2].to_vec()),
        ("no EOI", good[..good.len() - 2].to_vec()),
        ("bit flips", flipped),
        (
            "garbage EXIF",
            with_segments(
                &good,
                &[(0xE1, b"Exif\0\0MM\0\x2a\xff\xff\xff\xff".to_vec())],
            ),
        ),
    ];
    for (label, input) in cases {
        // Some damage is still decodable (a decoder may fill in a truncated scan); what
        // matters is no panic, and any output that is produced passes the header rules.
        match encode_variants(&input) {
            Err(_) => {}
            Ok(shot) => {
                check_segments(&shot.thumb).unwrap_or_else(|e| panic!("{label}: {e}"));
                check_segments(&shot.hd).unwrap_or_else(|e| panic!("{label}: {e}"));
            }
        }
    }
    assert!(encode_variants(&[]).is_err());
    assert!(encode_variants(b"GIF89a not a jpeg at all").is_err());
    assert!(encode_variants(&good[..good.len().min(300)]).is_err());
}

#[test]
fn the_report_carries_sizes_and_timings() {
    let input = with_segments(&flat_jpeg(3000, 2000), &[(0xE1, exif_app1(Some(8), true))]);
    let (shot, report) = encode_variants_with_report(&input).unwrap();
    assert_eq!(report.input_bytes, input.len());
    assert_eq!((report.input_width, report.input_height), (3000, 2000));
    assert_eq!(report.orientation, 8);
    assert_eq!(
        (shot.width, shot.height),
        (1707, 2560),
        "orientation 8 is portrait"
    );
    assert_eq!(report.thumb_bytes, shot.thumb.len());
    assert_eq!(report.hd_bytes, shot.hd.len());
    assert!(report.total() >= report.decode);
}

// ---- exif_orientation ---------------------------------------------------------------------

#[test]
fn orientation_is_read_from_big_and_little_endian_exif() {
    let jpeg = flat_jpeg(16, 16);
    for o in 1..=8 {
        for big in [true, false] {
            let input = with_segments(&jpeg, &[(0xE1, exif_app1(Some(o), big))]);
            assert_eq!(
                exif_orientation(&input),
                o,
                "orientation {o}, big-endian {big}"
            );
        }
    }
}

#[test]
fn orientation_defaults_to_1_when_missing_or_invalid() {
    let jpeg = flat_jpeg(16, 16);
    assert_eq!(exif_orientation(&jpeg), 1, "no APP1");
    assert_eq!(exif_orientation(&[]), 1, "empty");
    assert_eq!(exif_orientation(b"not a jpeg"), 1);
    let no_tag = with_segments(&jpeg, &[(0xE1, exif_app1(None, true))]);
    assert_eq!(exif_orientation(&no_tag), 1, "no orientation tag");
    for bad in [0, 9, 0xFFFF] {
        let input = with_segments(&jpeg, &[(0xE1, exif_app1(Some(bad), true))]);
        assert_eq!(exif_orientation(&input), 1, "value {bad}");
    }
    // XMP before the EXIF APP1 is skipped, not mistaken for it.
    let xmp_first = with_segments(
        &jpeg,
        &[(0xE1, xmp_app1()), (0xE1, exif_app1(Some(6), false))],
    );
    assert_eq!(exif_orientation(&xmp_first), 6);
    // Every truncation of the EXIF payload is handled.
    let full = exif_app1(Some(3), true);
    for cut in 0..full.len() {
        let input = with_segments(&jpeg, &[(0xE1, full[..cut].to_vec())]);
        let o = exif_orientation(&input);
        assert!(o == 1 || o == 3, "cut at {cut} gave {o}");
    }
    // A segment length running past the end of the file.
    let mut overrun = jpeg[..2].to_vec();
    overrun.extend([0xFF, 0xE1, 0xFF, 0xFF, b'E', b'x']);
    assert_eq!(exif_orientation(&overrun), 1);
}

// ---- check_segments -----------------------------------------------------------------------

/// A valid encoder output to mutate.
fn baseline() -> Vec<u8> {
    flat_jpeg(64, 48)
}

/// Replaces the first marker `from` (segment start) with `to`.
fn retag(jpeg: &[u8], from: u8, to: u8) -> Vec<u8> {
    let mut out = jpeg.to_vec();
    let at = out
        .windows(2)
        .position(|w| w == [0xFF, from])
        .expect("marker present");
    out[at + 1] = to;
    out
}

#[test]
fn check_segments_accepts_the_encoder_output_and_reports_its_size() {
    assert_eq!(check_segments(&baseline()), Ok((64, 48)));
    // APP14 and DRI are on the Worker's allowlist too.
    let extra = with_segments(&baseline(), &[(0xEE, b"Adobe\0\x64\0\0\0\0\x01".to_vec())]);
    assert_eq!(check_segments(&extra), Ok((64, 48)));
}

#[test]
fn check_segments_rejects_metadata_segments() {
    for marker in [0xE1, 0xE2, 0xED, 0xFE, 0xE3, 0xEF] {
        let input = with_segments(&baseline(), &[(marker, b"payload".to_vec())]);
        assert_eq!(
            check_segments(&input),
            Err(SegmentError::NotAllowed(marker)),
            "marker {marker:#04x}"
        );
    }
}

#[test]
fn check_segments_requires_a_single_baseline_frame() {
    for sof in [0xC1, 0xC2, 0xC3, 0xC9] {
        assert_eq!(
            check_segments(&retag(&baseline(), 0xC0, sof)),
            Err(SegmentError::NotAllowed(sof))
        );
    }
    // A second SOF0 before the scan.
    let jpeg = baseline();
    let sof_at = jpeg.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
    let len = usize::from(u16::from_be_bytes([jpeg[sof_at + 2], jpeg[sof_at + 3]]));
    let sof = jpeg[sof_at..sof_at + 2 + len].to_vec();
    let mut twice = jpeg[..sof_at].to_vec();
    twice.extend(&sof);
    twice.extend(&jpeg[sof_at..]);
    assert_eq!(
        check_segments(&twice),
        Err(SegmentError::Frame("more than one SOF"))
    );
    // No frame at all.
    let mut no_sof = jpeg[..sof_at].to_vec();
    no_sof.extend(&jpeg[sof_at + 2 + len..]);
    assert_eq!(
        check_segments(&no_sof),
        Err(SegmentError::Frame("SOS before SOF"))
    );
}

#[test]
fn check_segments_requires_one_scan_ending_in_eoi() {
    let jpeg = baseline();
    let mut trailing = jpeg.clone();
    trailing.extend(b"trailer");
    assert_eq!(check_segments(&trailing), Err(SegmentError::Ending));
    let mut appended = jpeg.clone();
    appended.extend(&jpeg);
    assert_eq!(
        check_segments(&appended),
        Err(SegmentError::Ending),
        "a second image after EOI"
    );
    assert_eq!(
        check_segments(&jpeg[..jpeg.len() - 2]),
        Err(SegmentError::Ending)
    );
    // A second scan: a marker other than RSTn inside the entropy-coded data.
    let mut two_scans = jpeg[..jpeg.len() - 2].to_vec();
    let sos_at = jpeg.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap();
    two_scans.extend(&jpeg[sos_at..]);
    assert_eq!(check_segments(&two_scans), Err(SegmentError::Scan(0xDA)));
}

#[test]
fn check_segments_rejects_malformed_headers() {
    assert_eq!(check_segments(&[]), Err(SegmentError::NoSoi));
    assert_eq!(check_segments(b"GIF89a"), Err(SegmentError::NoSoi));
    let jpeg = baseline();
    for cut in [2, 3, 5, 21, 40] {
        assert!(check_segments(&jpeg[..cut]).is_err(), "cut at {cut}");
    }
    // The scan must start within the first 64 KB, as the Worker reads only that much.
    let pad = vec![0u8; 40_000];
    let late = with_segments(&jpeg, &[(0xE0, pad.clone()), (0xE0, pad)]);
    assert_eq!(check_segments(&late), Err(SegmentError::ScanTooLate));
}
