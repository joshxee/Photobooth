//! Parsing of Sony's "all extended device property info" dataset (`SDIO_GetAllExtDevicePropInfo`).
//!
//! The layout was reconstructed from libgphoto2 and is **not an official specification**, so the
//! parser is deliberately tolerant: it tries a small set of plausible layouts and accepts the
//! first that consumes the buffer exactly, which makes an accidental mis-parse very unlikely.
//!
//! **Confirmed on a real A7 III (firmware 4.0):** an 8-byte leading record count and **one**
//! value list per enumeration (`Layout { prefix: 8, enum_lists: 1 }`), 60 records in 1.5–1.6 KB.
//! That layout is tried first; the others are kept as a safety net for other bodies/firmware.

use crate::container::Reader;
use crate::error::{Error, Result};

/// One property record. `current` is the raw little-endian value for integer types of up to
/// 8 bytes; larger or string-typed values are skipped over and reported as `None`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PropInfo {
    pub code: u16,
    pub data_type: u16,
    pub current: Option<u64>,
}

/// A candidate on-the-wire layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// Bytes to skip before the first record (a record count, if present).
    pub prefix: usize,
    /// Number of value lists in an enumeration form (1 or 2).
    pub enum_lists: usize,
}

const LAYOUTS: [Layout; 4] = [
    // Confirmed on hardware.
    Layout {
        prefix: 8,
        enum_lists: 1,
    },
    Layout {
        prefix: 8,
        enum_lists: 2,
    },
    Layout {
        prefix: 0,
        enum_lists: 1,
    },
    Layout {
        prefix: 0,
        enum_lists: 2,
    },
];

fn read_value(r: &mut Reader<'_>, data_type: u16) -> Result<Option<u64>> {
    Ok(match data_type {
        0x0001 | 0x0002 => Some(u64::from(r.u8()?)),
        0x0003 | 0x0004 => Some(u64::from(r.u16()?)),
        0x0005 | 0x0006 => Some(u64::from(r.u32()?)),
        0x0007 | 0x0008 => Some(r.u64()?),
        0x0009 | 0x000A => {
            r.skip(16)?;
            None
        }
        0xFFFF => {
            r.string()?;
            None
        }
        other => {
            return Err(Error::Protocol(format!(
                "unknown property data type {other:#06x}"
            )))
        }
    })
}

fn parse_with(data: &[u8], layout: Layout) -> Result<Vec<PropInfo>> {
    if data.len() < layout.prefix {
        return Err(Error::Protocol(
            "property dataset shorter than prefix".to_owned(),
        ));
    }
    let mut r = Reader::new(&data[layout.prefix..]);
    let mut props = Vec::new();
    while r.remaining() > 0 {
        let code = r.u16()?;
        let data_type = r.u16()?;
        let _get_set = r.u8()?;
        let _is_enabled = r.u8()?;
        let _default = read_value(&mut r, data_type)?;
        let current = read_value(&mut r, data_type)?;
        match r.u8()? {
            0 => {}
            1 => {
                for _ in 0..3 {
                    read_value(&mut r, data_type)?; // min, max, step
                }
            }
            2 => {
                for _ in 0..layout.enum_lists {
                    let count = r.u16()?;
                    for _ in 0..count {
                        read_value(&mut r, data_type)?;
                    }
                }
            }
            other => {
                return Err(Error::Protocol(format!("unknown form flag {other}")));
            }
        }
        props.push(PropInfo {
            code,
            data_type,
            current,
        });
    }
    if props.is_empty() {
        return Err(Error::Protocol(
            "property dataset has no records".to_owned(),
        ));
    }
    Ok(props)
}

/// Parses the dataset, returning the records and the layout that matched.
pub fn parse_all_ext_prop_info(data: &[u8]) -> Result<(Vec<PropInfo>, Layout)> {
    let mut first_error = None;
    for layout in LAYOUTS {
        match parse_with(data, layout) {
            Ok(props) => return Ok((props, layout)),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    Err(first_error.expect("LAYOUTS is non-empty"))
}

/// Looks up the current value of `code` as a u16.
pub fn current_u16(data: &[u8], code: u16) -> Result<u16> {
    let (props, layout) = parse_all_ext_prop_info(data)?;
    tracing::debug!(
        ?layout,
        records = props.len(),
        "parsed extended property info"
    );
    let prop = props
        .iter()
        .find(|p| p.code == code)
        .ok_or_else(|| Error::Protocol(format!("camera did not report property {code:#06x}")))?;
    prop.current
        .and_then(|v| u16::try_from(v).ok())
        .ok_or_else(|| Error::Protocol(format!("property {code:#06x} is not a 16-bit value")))
}

/// Encodes a dataset in the layout confirmed on a real camera (8-byte count, one value list per
/// enumeration) from `(code, current)` pairs of u16 properties; used by the simulated camera.
pub fn encode_u16_props(props: &[(u16, u16)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(props.len() as u64).to_le_bytes());
    for &(code, value) in props {
        out.extend_from_slice(&code.to_le_bytes());
        out.extend_from_slice(&0x0004u16.to_le_bytes()); // UINT16
        out.push(1); // get/set
        out.push(1); // is enabled
        out.extend_from_slice(&0u16.to_le_bytes()); // factory default
        out.extend_from_slice(&value.to_le_bytes()); // current
        out.push(2); // enumeration form
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_layout_confirmed_on_real_hardware() {
        let data = encode_u16_props(&[(0xD215, 0x8001), (0xD221, 1)]);
        let (props, layout) = parse_all_ext_prop_info(&data).unwrap();
        assert_eq!(layout, LAYOUTS[0]);
        assert_eq!(props.len(), 2);
        assert_eq!(current_u16(&data, 0xD215).unwrap(), 0x8001);
        assert_eq!(current_u16(&data, 0xD221).unwrap(), 1);
    }

    #[test]
    fn a_two_list_enumeration_layout_is_still_understood() {
        // The other plausible layout stays supported as a safety net.
        let mut data = 1u64.to_le_bytes().to_vec();
        data.extend_from_slice(&[0x15, 0xD2, 0x04, 0x00, 1, 1]); // D215, UINT16
        data.extend_from_slice(&0u16.to_le_bytes()); // default
        data.extend_from_slice(&0x8001u16.to_le_bytes()); // current
        data.push(2); // enumeration
        for _ in 0..2 {
            data.extend_from_slice(&1u16.to_le_bytes());
            data.extend_from_slice(&0x8001u16.to_le_bytes());
        }
        let (props, layout) = parse_all_ext_prop_info(&data).unwrap();
        assert_eq!(layout, LAYOUTS[1]);
        assert_eq!(props[0].current, Some(0x8001));
    }

    #[test]
    fn tolerates_a_dataset_without_a_leading_count() {
        let data = encode_u16_props(&[(0xD215, 7)]);
        assert_eq!(current_u16(&data[8..], 0xD215).unwrap(), 7);
        let (_, layout) = parse_all_ext_prop_info(&data[8..]).unwrap();
        assert_eq!(layout.prefix, 0);
    }

    #[test]
    fn mixed_types_and_forms_parse() {
        let mut data = 3u64.to_le_bytes().to_vec();
        // A UINT8 range-form property.
        data.extend_from_slice(&[0x01, 0xD2, 0x02, 0x00, 1, 1, 5, 6, 1, 0, 9, 1]);
        // A UINT32 property with no form.
        data.extend_from_slice(&[0x02, 0xD2, 0x06, 0x00, 1, 1]);
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&0xDEADu32.to_le_bytes());
        data.push(0);
        // A string property.
        data.extend_from_slice(&[0x03, 0xD2, 0xFF, 0xFF, 1, 1]);
        data.extend_from_slice(&[0, 0]); // default "", current ""
        data.push(0);
        let (props, _) = parse_all_ext_prop_info(&data).unwrap();
        assert_eq!(props.len(), 3);
        assert_eq!(props[0].current, Some(6));
        assert_eq!(props[1].current, Some(0xDEAD));
        assert_eq!(props[2].current, None);
    }

    #[test]
    fn missing_or_wide_properties_are_errors() {
        let data = encode_u16_props(&[(0xD215, 1)]);
        assert!(current_u16(&data, 0xD999).is_err());
        let mut wide = 1u64.to_le_bytes().to_vec();
        wide.extend_from_slice(&[0x15, 0xD2, 0x06, 0x00, 1, 1]);
        wide.extend_from_slice(&0u32.to_le_bytes());
        wide.extend_from_slice(&0x1_0000u32.to_le_bytes());
        wide.push(0);
        assert!(current_u16(&wide, 0xD215).is_err(), "does not fit u16");
    }

    #[test]
    fn garbage_never_panics() {
        for len in 0..64 {
            let junk: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let _ = parse_all_ext_prop_info(&junk);
        }
        assert!(parse_all_ext_prop_info(&[]).is_err());
        assert!(parse_all_ext_prop_info(&[0xFF; 40]).is_err());
    }
}
