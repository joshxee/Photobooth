//! The booth's variant encoder (DESIGN D14, §7): a camera JPEG in, the two variants the
//! portal stores out, with the EXIF orientation applied and no metadata.
//!
//! | Variant | Fit (long edge, never upscaled) | Quality |
//! |---|---|---|
//! | thumb | 480 px | 75 |
//! | hd | 2560 px | 85 |
//!
//! Pipeline, with at most one decoded frame in memory:
//!
//! 1. Read the EXIF orientation (`orientation.rs`, own parser; missing or invalid means 1).
//! 2. Decode with `jpeg-decoder`, DCT-scaled to the smallest of 1/1, 1/2, 1/4, 1/8 that still
//!    has a long edge ≥ 2560 (a 6000×4000 Sony frame decodes at 3000×2000).
//! 3. Lanczos3 resize (`fast_image_resize`) to the HD size; the decoded frame is dropped.
//! 4. Rotate or flip the HD pixels upright.
//! 5. Encode HD with `jpeg-encoder` (baseline, one interleaved scan, 4:2:0 with averaged
//!    chroma), then resize HD to the thumb and encode it.
//! 6. Run [`check_segments`] on both outputs. The encoder writes only SOI, APP0 (JFIF), SOF0,
//!    DQT, DHT, SOS and EOI, so a failure is an encoder bug and becomes a [`VariantError`]:
//!    a bad variant never reaches the outbox.
//!
//! Nothing from the input's headers is copied: EXIF, XMP, IPTC, ICC, MPF previews and
//! comments are all dropped by re-encoding the pixels. No ICC profile is written; the camera
//! shoots sRGB (DESIGN §7).

mod orientation;
mod segments;

#[cfg(test)]
mod tests;

use std::time::{Duration, Instant};

use fast_image_resize::images::Image;
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use jpeg_decoder::PixelFormat;
use jpeg_encoder::{ChromaSubsamplingMethod, ColorType, Encoder, SamplingFactor};
use thiserror::Error;

use crate::outbox::{EncodedShot, Variant};

pub use orientation::exif_orientation;
pub use segments::{check_segments, SegmentError, HEADER_WINDOW};

/// Thumb: fit 480×480, quality 75.
pub const THUMB_EDGE: u32 = 480;
pub const THUMB_QUALITY: u8 = 75;
/// HD: fit 2560×2560, quality 85.
pub const HD_EDGE: u32 = 2560;
pub const HD_QUALITY: u8 = 85;

/// Inputs above this many pixels are refused before decoding, so a damaged header can't ask
/// for a huge buffer. The Sony A7 III shoots 24 MP.
pub const MAX_INPUT_PIXELS: u64 = 64_000_000;

#[derive(Debug, Error)]
pub enum VariantError {
    #[error("cannot decode the camera JPEG: {0}")]
    Decode(String),
    #[error("unsupported camera JPEG: {0}")]
    Unsupported(String),
    #[error("cannot resize: {0}")]
    Resize(String),
    #[error("cannot encode the {} variant: {reason}", .variant.as_str())]
    Encode { variant: Variant, reason: String },
    /// The encoder produced something the portal would reject: a bug, never uploaded.
    #[error("the {} variant fails the header rules: {reason}", .variant.as_str())]
    InvalidOutput { variant: Variant, reason: String },
}

/// What one encode did, for the debug probe's log line (and session 10's).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EncodeReport {
    pub input_bytes: usize,
    /// As stored in the file, before orientation.
    pub input_width: u32,
    pub input_height: u32,
    pub orientation: u16,
    /// Reading the orientation and the (scaled) decode.
    pub decode: Duration,
    /// Both Lanczos resizes.
    pub resize: Duration,
    /// Rotating or flipping the HD pixels upright.
    pub orient: Duration,
    /// Both encodes and their header checks.
    pub encode: Duration,
    pub thumb_bytes: usize,
    pub hd_bytes: usize,
}

impl EncodeReport {
    pub fn total(&self) -> Duration {
        self.decode + self.resize + self.orient + self.encode
    }
}

/// Encodes the thumb and HD variants of a camera JPEG. See the module docs.
pub fn encode_variants(jpeg: &[u8]) -> Result<EncodedShot, VariantError> {
    encode_variants_with_report(jpeg).map(|(shot, _)| shot)
}

/// [`encode_variants`], plus sizes and per-stage timings.
pub fn encode_variants_with_report(
    jpeg: &[u8],
) -> Result<(EncodedShot, EncodeReport), VariantError> {
    let started = Instant::now();
    let orientation = exif_orientation(jpeg);
    let (decoded, (input_width, input_height)) = decode(jpeg)?;
    let decode_time = started.elapsed();

    // Sizes come from the stored size, not the scaled decode, so they are exact.
    let (hd_w, hd_h) = fit(input_width, input_height, HD_EDGE);
    let (upright_w, upright_h) = if orientation >= 5 {
        (input_height, input_width)
    } else {
        (input_width, input_height)
    };
    let (thumb_w, thumb_h) = fit(upright_w, upright_h, THUMB_EDGE);

    let t = Instant::now();
    let hd = resize(decoded, hd_w, hd_h)?;
    let mut resize_time = t.elapsed();

    let t = Instant::now();
    let (hd_px, hd_w, hd_h) = orientation::orient(hd.px, hd.width, hd.height, orientation);
    let hd = Frame {
        px: hd_px,
        width: hd_w,
        height: hd_h,
    };
    let orient_time = t.elapsed();

    let t = Instant::now();
    let hd_jpeg = encode(&hd, Variant::Hd, HD_QUALITY)?;
    let mut encode_time = t.elapsed();

    let t = Instant::now();
    let thumb = resize(hd, thumb_w, thumb_h)?;
    resize_time += t.elapsed();

    let t = Instant::now();
    let thumb_jpeg = encode(&thumb, Variant::Thumb, THUMB_QUALITY)?;
    encode_time += t.elapsed();

    let report = EncodeReport {
        input_bytes: jpeg.len(),
        input_width,
        input_height,
        orientation,
        decode: decode_time,
        resize: resize_time,
        orient: orient_time,
        encode: encode_time,
        thumb_bytes: thumb_jpeg.len(),
        hd_bytes: hd_jpeg.len(),
    };
    let shot = EncodedShot {
        thumb: thumb_jpeg,
        hd: hd_jpeg,
        width: hd_w,
        height: hd_h,
    };
    Ok((shot, report))
}

/// A packed RGB frame.
struct Frame {
    px: Vec<u8>,
    width: u32,
    height: u32,
}

/// Fits `width`×`height` inside `edge`×`edge`, keeping the aspect ratio (rounded) and never
/// upscaling.
fn fit(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= edge {
        return (width, height);
    }
    let scale = |x: u32| {
        let scaled = (u64::from(x) * u64::from(edge) + u64::from(long) / 2) / u64::from(long);
        (scaled as u32).max(1)
    };
    (scale(width), scale(height))
}

/// Decodes `jpeg` to RGB, DCT-scaled as far as HD allows. Returns the frame and the stored
/// (unscaled) size.
fn decode(jpeg: &[u8]) -> Result<(Frame, (u32, u32)), VariantError> {
    let err = |e: jpeg_decoder::Error| VariantError::Decode(e.to_string());
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    decoder.read_info().map_err(err)?;
    let info = decoder
        .info()
        .ok_or_else(|| VariantError::Decode("no frame header".into()))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    if width == 0 || height == 0 {
        return Err(VariantError::Decode("zero-sized frame".into()));
    }
    if u64::from(width) * u64::from(height) > MAX_INPUT_PIXELS {
        return Err(VariantError::Unsupported(format!(
            "{width}x{height} is over {MAX_INPUT_PIXELS} pixels"
        )));
    }
    if width.max(height) > HD_EDGE {
        // The smallest DCT scale with either side ≥ HD_EDGE, i.e. the long edge.
        decoder.scale(HD_EDGE as u16, HD_EDGE as u16).map_err(err)?;
    }
    let px = decoder.decode().map_err(err)?;
    let info = decoder
        .info()
        .ok_or_else(|| VariantError::Decode("no frame header".into()))?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    let px = match info.pixel_format {
        PixelFormat::RGB24 => px,
        PixelFormat::L8 => px.iter().flat_map(|&l| [l, l, l]).collect(),
        other => return Err(VariantError::Unsupported(format!("{other:?} pixels"))),
    };
    if px.len() != w as usize * h as usize * 3 {
        return Err(VariantError::Decode("short pixel buffer".into()));
    }
    Ok((
        Frame {
            px,
            width: w,
            height: h,
        },
        (width, height),
    ))
}

/// Lanczos3 resize to `width`×`height`; the same size returns the frame untouched.
fn resize(frame: Frame, width: u32, height: u32) -> Result<Frame, VariantError> {
    if (frame.width, frame.height) == (width, height) {
        return Ok(frame);
    }
    let err = |e: &dyn std::fmt::Display| VariantError::Resize(e.to_string());
    let src = Image::from_vec_u8(frame.width, frame.height, frame.px, PixelType::U8x3)
        .map_err(|e| err(&e))?;
    let mut dst = Image::new(width, height, PixelType::U8x3);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)),
        )
        .map_err(|e| err(&e))?;
    Ok(Frame {
        px: dst.into_vec(),
        width,
        height,
    })
}

/// Encodes one variant and checks it against the header rules and its expected size.
fn encode(frame: &Frame, variant: Variant, quality: u8) -> Result<Vec<u8>, VariantError> {
    let encode_err = |reason: String| VariantError::Encode { variant, reason };
    let (Ok(w), Ok(h)) = (u16::try_from(frame.width), u16::try_from(frame.height)) else {
        return Err(encode_err(format!(
            "{}x{} is too large",
            frame.width, frame.height
        )));
    };
    let mut out = Vec::with_capacity(frame.px.len() / 8);
    let mut encoder = Encoder::new(&mut out, quality);
    // Interleaved baseline: standard Huffman tables, because optimised tables make
    // jpeg-encoder write one scan per component, which the header rules refuse.
    encoder.set_sampling_factor(SamplingFactor::F_2_2);
    encoder.set_chroma_subsampling_method(ChromaSubsamplingMethod::Average);
    encoder
        .encode(&frame.px, w, h, ColorType::Rgb)
        .map_err(|e| encode_err(e.to_string()))?;
    let invalid = |reason: String| VariantError::InvalidOutput { variant, reason };
    let size = check_segments(&out).map_err(|e| invalid(e.to_string()))?;
    if size != (frame.width, frame.height) {
        return Err(invalid(format!(
            "frame is {}x{}, expected {}x{}",
            size.0, size.1, frame.width, frame.height
        )));
    }
    Ok(out)
}
