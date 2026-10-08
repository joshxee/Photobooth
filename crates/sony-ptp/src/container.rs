//! PTP-over-USB containers and the small datasets the engine needs to read.

use crate::error::{Error, Result};

/// Size of the fixed container header: length (u32), type (u16), code (u16), txid (u32).
pub const HEADER_LEN: usize = 12;

/// Maximum number of u32 parameters in a command, response or event container.
pub const MAX_PARAMS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerType {
    Command = 1,
    Data = 2,
    Response = 3,
    Event = 4,
}

impl ContainerType {
    fn from_u16(v: u16) -> Result<Self> {
        Ok(match v {
            1 => Self::Command,
            2 => Self::Data,
            3 => Self::Response,
            4 => Self::Event,
            other => return Err(Error::Protocol(format!("unknown container type {other}"))),
        })
    }
}

/// A fully reassembled container.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Container {
    pub kind: ContainerType,
    pub code: u16,
    pub txid: u32,
    /// Everything after the 12-byte header: parameters for command/response/event
    /// containers, the data payload for data containers.
    pub payload: Vec<u8>,
}

impl Container {
    /// Parses one complete container from `bytes` (exactly `len` bytes, per its own header).
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN {
            return Err(Error::Protocol(format!(
                "container shorter than header ({} bytes)",
                bytes.len()
            )));
        }
        let len = u32_le(bytes, 0) as usize;
        if len < HEADER_LEN || len > bytes.len() {
            return Err(Error::Protocol(format!(
                "container length {len} inconsistent with {} bytes received",
                bytes.len()
            )));
        }
        Ok(Self {
            kind: ContainerType::from_u16(u16_le(bytes, 4))?,
            code: u16_le(bytes, 6),
            txid: u32_le(bytes, 8),
            payload: bytes[HEADER_LEN..len].to_vec(),
        })
    }

    /// The u32 parameters of a command/response/event container.
    pub fn params(&self) -> Vec<u32> {
        self.payload
            .chunks_exact(4)
            .take(MAX_PARAMS)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }
}

/// Total length declared by the header at the start of `bytes`, if there are enough bytes.
pub fn declared_len(bytes: &[u8]) -> Option<usize> {
    (bytes.len() >= 4).then(|| u32_le(bytes, 0) as usize)
}

fn header(len: usize, kind: ContainerType, code: u16, txid: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.extend_from_slice(&(kind as u16).to_le_bytes());
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&txid.to_le_bytes());
    out
}

/// Encodes a command container with up to five parameters.
pub fn encode_command(code: u16, txid: u32, params: &[u32]) -> Vec<u8> {
    assert!(
        params.len() <= MAX_PARAMS,
        "PTP allows at most 5 parameters"
    );
    let mut out = header(
        HEADER_LEN + 4 * params.len(),
        ContainerType::Command,
        code,
        txid,
    );
    for p in params {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out
}

/// Encodes a data container carrying `data` for operation `code`.
pub fn encode_data(code: u16, txid: u32, data: &[u8]) -> Vec<u8> {
    let mut out = header(HEADER_LEN + data.len(), ContainerType::Data, code, txid);
    out.extend_from_slice(data);
    out
}

/// Encodes a response container (used by the simulated camera in tests).
pub fn encode_response(code: u16, txid: u32, params: &[u32]) -> Vec<u8> {
    let mut out = header(
        HEADER_LEN + 4 * params.len(),
        ContainerType::Response,
        code,
        txid,
    );
    for p in params {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out
}

/// Encodes an event container (used by the simulated camera in tests).
pub fn encode_event(code: u16, txid: u32, params: &[u32]) -> Vec<u8> {
    let mut out = header(
        HEADER_LEN + 4 * params.len(),
        ContainerType::Event,
        code,
        txid,
    );
    for p in params {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out
}

pub(crate) fn u16_le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

pub(crate) fn u32_le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

// ---------------------------------------------------------------------------------------
// Dataset readers
// ---------------------------------------------------------------------------------------

/// A forward-only little-endian reader that reports truncation as a protocol error.
pub(crate) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.remaining() < n {
            return Err(Error::Protocol(format!(
                "dataset truncated: needed {n} bytes at offset {}, {} left",
                self.pos,
                self.remaining()
            )));
        }
        let slice = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    pub fn skip(&mut self, n: usize) -> Result<()> {
        self.take(n).map(|_| ())
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn u64(&mut self) -> Result<u64> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_le_bytes(a))
    }

    /// A PTP string: a u8 character count (including the terminator) then UTF-16LE.
    pub fn string(&mut self) -> Result<String> {
        let chars = self.u8()? as usize;
        let raw = self.take(chars * 2)?;
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        Ok(String::from_utf16_lossy(&units))
    }

    /// A PTP array of u16: a u32 count then that many values.
    pub fn u16_array(&mut self) -> Result<Vec<u16>> {
        let n = self.u32()? as usize;
        if n.checked_mul(2)
            .is_none_or(|bytes| bytes > self.remaining())
        {
            return Err(Error::Protocol(format!(
                "array of {n} u16 overruns dataset"
            )));
        }
        (0..n).map(|_| self.u16()).collect()
    }
}

/// Encodes a PTP string (used by the simulated camera in tests).
pub fn encode_string(s: &str) -> Vec<u8> {
    if s.is_empty() {
        return vec![0];
    }
    let units: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out = vec![units.len() as u8];
    for u in units {
        out.extend_from_slice(&u.to_le_bytes());
    }
    out
}

/// The parts of the PTP `DeviceInfo` dataset the engine uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceInfo {
    pub vendor_extension_desc: String,
    pub operations: Vec<u16>,
    pub events: Vec<u16>,
    pub manufacturer: String,
    pub model: String,
    pub device_version: String,
    pub serial_number: String,
}

impl DeviceInfo {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let mut r = Reader::new(data);
        r.skip(2)?; // StandardVersion
        r.skip(4)?; // VendorExtensionID
        r.skip(2)?; // VendorExtensionVersion
        let vendor_extension_desc = r.string()?;
        r.skip(2)?; // FunctionalMode
        let operations = r.u16_array()?;
        let events = r.u16_array()?;
        let _device_props = r.u16_array()?;
        let _capture_formats = r.u16_array()?;
        let _image_formats = r.u16_array()?;
        Ok(Self {
            vendor_extension_desc,
            operations,
            events,
            manufacturer: r.string()?,
            model: r.string()?,
            device_version: r.string()?,
            serial_number: r.string()?,
        })
    }

    pub fn supports(&self, operation: u16) -> bool {
        self.operations.contains(&operation)
    }
}

/// The parts of the PTP `ObjectInfo` dataset the engine uses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ObjectInfo {
    pub format: u16,
    pub compressed_size: u32,
    pub width: u32,
    pub height: u32,
    pub filename: String,
}

impl ObjectInfo {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let mut r = Reader::new(data);
        r.skip(4)?; // StorageID
        let format = r.u16()?;
        r.skip(2)?; // ProtectionStatus
        let compressed_size = r.u32()?;
        r.skip(2)?; // ThumbFormat
        r.skip(4)?; // ThumbCompressedSize
        r.skip(4)?; // ThumbPixWidth
        r.skip(4)?; // ThumbPixHeight
        let width = r.u32()?;
        let height = r.u32()?;
        r.skip(4)?; // ImageBitDepth
        r.skip(4)?; // ParentObject
        r.skip(2)?; // AssociationType
        r.skip(4)?; // AssociationDesc
        r.skip(4)?; // SequenceNumber
        let filename = r.string()?;
        Ok(Self {
            format,
            compressed_size,
            width,
            height,
            filename,
        })
    }

    /// Encodes an `ObjectInfo` dataset (used by the simulated camera in tests).
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&0x0001_0001u32.to_le_bytes()); // StorageID
        out.extend_from_slice(&self.format.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // ProtectionStatus
        out.extend_from_slice(&self.compressed_size.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // ThumbFormat
        out.extend_from_slice(&[0; 12]); // thumb size/width/height
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
        out.extend_from_slice(&[0; 4]); // ImageBitDepth
        out.extend_from_slice(&[0; 4]); // ParentObject
        out.extend_from_slice(&[0; 2]); // AssociationType
        out.extend_from_slice(&[0; 4]); // AssociationDesc
        out.extend_from_slice(&[0; 4]); // SequenceNumber
        out.extend_from_slice(&encode_string(&self.filename));
        out.extend_from_slice(&[0, 0, 0]); // empty CaptureDate, ModificationDate, Keywords
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_header_layout_is_little_endian() {
        let bytes = encode_command(0x1002, 7, &[1]);
        assert_eq!(
            bytes,
            [
                16, 0, 0, 0, // length
                1, 0, // type: command
                0x02, 0x10, // code 0x1002
                7, 0, 0, 0, // txid
                1, 0, 0, 0, // param
            ]
        );
    }

    #[test]
    fn container_round_trips_all_kinds() {
        for (bytes, kind) in [
            (
                encode_command(0x9201, 3, &[1, 0, 0]),
                ContainerType::Command,
            ),
            (encode_data(0x1009, 4, &[9, 8, 7]), ContainerType::Data),
            (encode_response(0x2001, 5, &[]), ContainerType::Response),
            (
                encode_event(0xC201, 0, &[0xFFFF_C001]),
                ContainerType::Event,
            ),
        ] {
            let c = Container::parse(&bytes).unwrap();
            assert_eq!(c.kind, kind);
            assert_eq!(declared_len(&bytes), Some(bytes.len()));
        }
        let c = Container::parse(&encode_command(0x9201, 3, &[1, 2, 3])).unwrap();
        assert_eq!(c.params(), vec![1, 2, 3]);
        assert_eq!(c.txid, 3);
        assert_eq!(c.code, 0x9201);
    }

    #[test]
    fn parse_rejects_short_and_inconsistent_containers() {
        assert!(Container::parse(&[1, 2, 3]).is_err());
        let mut bad = encode_response(0x2001, 1, &[]);
        bad[0] = 200; // declares more than present
        assert!(Container::parse(&bad).is_err());
        let mut bad_type = encode_response(0x2001, 1, &[]);
        bad_type[4] = 9;
        assert!(Container::parse(&bad_type).is_err());
    }

    #[test]
    fn ptp_strings_round_trip() {
        for s in ["", "A", "ILCE-7M3", "naïve ✓"] {
            let enc = encode_string(s);
            assert_eq!(Reader::new(&enc).string().unwrap(), s);
        }
    }

    #[test]
    fn object_info_round_trips() {
        let info = ObjectInfo {
            format: 0x3801,
            compressed_size: 6_123_456,
            width: 6000,
            height: 4000,
            filename: "DSC00001.JPG".to_owned(),
        };
        assert_eq!(ObjectInfo::parse(&info.encode()).unwrap(), info);
    }

    #[test]
    fn truncated_datasets_are_protocol_errors_not_panics() {
        let enc = ObjectInfo::default().encode();
        for cut in 0..enc.len() - 3 {
            assert!(ObjectInfo::parse(&enc[..cut]).is_err(), "cut at {cut}");
        }
        assert!(DeviceInfo::parse(&[0; 5]).is_err());
    }

    #[test]
    fn huge_array_counts_do_not_allocate_or_panic() {
        let mut data = vec![0u8; 2 + 4 + 2];
        data.push(0); // empty vendor desc
        data.extend_from_slice(&[0, 0]); // functional mode
        data.extend_from_slice(&u32::MAX.to_le_bytes()); // absurd operations count
        assert!(DeviceInfo::parse(&data).is_err());
    }
}
