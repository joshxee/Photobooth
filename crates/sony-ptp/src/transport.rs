//! The byte pipe to the camera, plus record/replay wrappers that turn a real session into a
//! hardware-free regression test.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A blocking USB-like byte transport. Implementations: `RusbTransport` (desktop and Android
/// fd), `RecordingTransport`, `ReplayTransport`, and the simulated camera used in tests.
///
/// A read returns the bytes of **one USB transfer** (at most `buf.len()`); the PTP layer
/// reassembles containers that span several. A read that times out must return
/// [`Error::Timeout`], not `Ok(0)`.
pub trait Transport: Send {
    fn write_bulk(&mut self, buf: &[u8], timeout: Duration) -> Result<usize>;
    fn read_bulk(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize>;
    fn read_interrupt(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize>;
    fn reset(&mut self) -> Result<()>;
}

impl<T: Transport + ?Sized> Transport for Box<T> {
    fn write_bulk(&mut self, buf: &[u8], timeout: Duration) -> Result<usize> {
        (**self).write_bulk(buf, timeout)
    }
    fn read_bulk(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        (**self).read_bulk(buf, timeout)
    }
    fn read_interrupt(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        (**self).read_interrupt(buf, timeout)
    }
    fn reset(&mut self) -> Result<()> {
        (**self).reset()
    }
}

// ---------------------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------------------

/// One transport call and what it produced. Bytes are lower-case hex so transcripts are
/// readable and diffable in review.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Entry {
    WriteBulk { data: String },
    ReadBulk { data: String },
    ReadInterrupt { data: String },
    ReadBulkTimeout,
    ReadInterruptTimeout,
    Reset,
}

/// A recorded session.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript {
    pub version: u32,
    #[serde(default)]
    pub description: String,
    pub entries: Vec<Entry>,
}

impl Transcript {
    pub const VERSION: u32 = 1;

    pub fn new(description: impl Into<String>) -> Self {
        Self {
            version: Self::VERSION,
            description: description.into(),
            entries: Vec::new(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("a transcript always serializes")
    }

    pub fn from_json(json: &str) -> Result<Self> {
        let transcript: Self = serde_json::from_str(json)
            .map_err(|e| Error::Replay(format!("transcript is not valid JSON: {e}")))?;
        if transcript.version != Self::VERSION {
            return Err(Error::Replay(format!(
                "unsupported transcript version {}",
                transcript.version
            )));
        }
        Ok(transcript)
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xF) as usize] as char);
    }
    s
}

pub fn from_hex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(Error::Replay("odd-length hex string".to_owned()));
    }
    let nibble = |c: u8| -> Result<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(Error::Replay(format!("invalid hex digit {:?}", c as char))),
        }
    };
    s.as_bytes()
        .chunks_exact(2)
        .map(|p| Ok(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect()
}

// ---------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------

/// Wraps a real transport and records every call into a [`Transcript`].
pub struct RecordingTransport<T: Transport> {
    inner: T,
    transcript: Transcript,
}

impl<T: Transport> RecordingTransport<T> {
    pub fn new(inner: T, description: impl Into<String>) -> Self {
        Self {
            inner,
            transcript: Transcript::new(description),
        }
    }

    pub fn transcript(&self) -> &Transcript {
        &self.transcript
    }

    pub fn into_parts(self) -> (T, Transcript) {
        (self.inner, self.transcript)
    }
}

impl<T: Transport> Transport for RecordingTransport<T> {
    fn write_bulk(&mut self, buf: &[u8], timeout: Duration) -> Result<usize> {
        let n = self.inner.write_bulk(buf, timeout)?;
        self.transcript.entries.push(Entry::WriteBulk {
            data: to_hex(&buf[..n]),
        });
        Ok(n)
    }

    fn read_bulk(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        match self.inner.read_bulk(buf, timeout) {
            Ok(n) => {
                self.transcript.entries.push(Entry::ReadBulk {
                    data: to_hex(&buf[..n]),
                });
                Ok(n)
            }
            Err(Error::Timeout(what)) => {
                self.transcript.entries.push(Entry::ReadBulkTimeout);
                Err(Error::Timeout(what))
            }
            Err(e) => Err(e),
        }
    }

    fn read_interrupt(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        match self.inner.read_interrupt(buf, timeout) {
            Ok(n) => {
                self.transcript.entries.push(Entry::ReadInterrupt {
                    data: to_hex(&buf[..n]),
                });
                Ok(n)
            }
            Err(Error::Timeout(what)) => {
                self.transcript.entries.push(Entry::ReadInterruptTimeout);
                Err(Error::Timeout(what))
            }
            Err(e) => Err(e),
        }
    }

    fn reset(&mut self) -> Result<()> {
        self.inner.reset()?;
        self.transcript.entries.push(Entry::Reset);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------

/// Plays a [`Transcript`] back. Strict: every call must be the next recorded one, and writes
/// must match byte for byte, so any change in the engine's wire behaviour fails loudly.
pub struct ReplayTransport {
    entries: std::vec::IntoIter<Entry>,
    consumed: usize,
}

impl ReplayTransport {
    pub fn new(transcript: Transcript) -> Self {
        Self {
            entries: transcript.entries.into_iter(),
            consumed: 0,
        }
    }

    /// Number of recorded calls not yet replayed.
    pub fn remaining(&self) -> usize {
        self.entries.len()
    }

    /// Errors unless the whole transcript was consumed.
    pub fn assert_finished(&self) -> Result<()> {
        match self.remaining() {
            0 => Ok(()),
            n => Err(Error::Replay(format!(
                "{n} recorded call(s) were never replayed (stopped after {})",
                self.consumed
            ))),
        }
    }

    fn next(&mut self, wanted: &str) -> Result<Entry> {
        let entry = self.entries.next().ok_or_else(|| {
            Error::Replay(format!(
                "transcript exhausted after {} calls; engine attempted {wanted}",
                self.consumed
            ))
        })?;
        self.consumed += 1;
        Ok(entry)
    }

    fn mismatch(&self, wanted: &str, got: &Entry) -> Error {
        Error::Replay(format!(
            "call #{}: engine attempted {wanted} but transcript has {got:?}",
            self.consumed
        ))
    }

    fn deliver(&self, data: &str, buf: &mut [u8]) -> Result<usize> {
        let bytes = from_hex(data)?;
        if bytes.len() > buf.len() {
            return Err(Error::Replay(format!(
                "call #{}: recorded read of {} bytes does not fit the engine's {}-byte buffer",
                self.consumed,
                bytes.len(),
                buf.len()
            )));
        }
        buf[..bytes.len()].copy_from_slice(&bytes);
        Ok(bytes.len())
    }
}

impl Transport for ReplayTransport {
    fn write_bulk(&mut self, buf: &[u8], _timeout: Duration) -> Result<usize> {
        match self.next("write_bulk")? {
            Entry::WriteBulk { data } => {
                let expected = from_hex(&data)?;
                if expected != buf {
                    return Err(Error::Replay(format!(
                        "call #{}: write differs\n  expected {}\n  actual   {}",
                        self.consumed,
                        data,
                        to_hex(buf)
                    )));
                }
                Ok(buf.len())
            }
            other => Err(self.mismatch("write_bulk", &other)),
        }
    }

    fn read_bulk(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        match self.next("read_bulk")? {
            Entry::ReadBulk { data } => self.deliver(&data, buf),
            Entry::ReadBulkTimeout => Err(Error::Timeout("bulk read")),
            other => Err(self.mismatch("read_bulk", &other)),
        }
    }

    fn read_interrupt(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        match self.next("read_interrupt")? {
            Entry::ReadInterrupt { data } => self.deliver(&data, buf),
            Entry::ReadInterruptTimeout => Err(Error::Timeout("interrupt read")),
            other => Err(self.mismatch("read_interrupt", &other)),
        }
    }

    fn reset(&mut self) -> Result<()> {
        match self.next("reset")? {
            Entry::Reset => Ok(()),
            other => Err(self.mismatch("reset", &other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_millis(1);

    #[test]
    fn hex_round_trips_and_rejects_garbage() {
        let bytes = [0x00, 0x0F, 0xA5, 0xFF];
        assert_eq!(to_hex(&bytes), "000fa5ff");
        assert_eq!(from_hex("000fa5ff").unwrap(), bytes);
        assert_eq!(from_hex("000FA5FF").unwrap(), bytes);
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }

    fn sample() -> Transcript {
        let mut t = Transcript::new("unit");
        t.entries = vec![
            Entry::WriteBulk {
                data: "0102".into(),
            },
            Entry::ReadBulk {
                data: "0a0b0c".into(),
            },
            Entry::ReadInterruptTimeout,
            Entry::Reset,
        ];
        t
    }

    #[test]
    fn transcript_json_round_trips() {
        let t = sample();
        assert_eq!(Transcript::from_json(&t.to_json()).unwrap(), t);
        assert!(Transcript::from_json("{").is_err());
        assert!(Transcript::from_json(r#"{"version":99,"entries":[]}"#).is_err());
    }

    #[test]
    fn replay_serves_the_recorded_calls_in_order() {
        let mut r = ReplayTransport::new(sample());
        assert_eq!(r.write_bulk(&[1, 2], T).unwrap(), 2);
        let mut buf = [0u8; 8];
        assert_eq!(r.read_bulk(&mut buf, T).unwrap(), 3);
        assert_eq!(&buf[..3], &[0x0a, 0x0b, 0x0c]);
        assert!(matches!(
            r.read_interrupt(&mut buf, T),
            Err(Error::Timeout(_))
        ));
        r.reset().unwrap();
        r.assert_finished().unwrap();
    }

    #[test]
    fn replay_fails_loudly_on_any_divergence() {
        // Wrong bytes written.
        let mut r = ReplayTransport::new(sample());
        assert!(matches!(r.write_bulk(&[9, 9], T), Err(Error::Replay(_))));
        // Wrong kind of call.
        let mut r = ReplayTransport::new(sample());
        let mut buf = [0u8; 8];
        assert!(matches!(r.read_bulk(&mut buf, T), Err(Error::Replay(_))));
        // Buffer too small for the recorded read.
        let mut r = ReplayTransport::new(sample());
        r.write_bulk(&[1, 2], T).unwrap();
        let mut tiny = [0u8; 1];
        assert!(matches!(r.read_bulk(&mut tiny, T), Err(Error::Replay(_))));
        // Exhausted, and not fully consumed.
        let mut r = ReplayTransport::new(Transcript::new("empty"));
        assert!(matches!(r.reset(), Err(Error::Replay(_))));
        let r = ReplayTransport::new(sample());
        assert!(matches!(r.assert_finished(), Err(Error::Replay(_))));
    }

    struct Scripted {
        reads: Vec<Result<Vec<u8>>>,
    }

    impl Transport for Scripted {
        fn write_bulk(&mut self, buf: &[u8], _: Duration) -> Result<usize> {
            Ok(buf.len())
        }
        fn read_bulk(&mut self, buf: &mut [u8], _: Duration) -> Result<usize> {
            match self.reads.remove(0) {
                Ok(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    Ok(bytes.len())
                }
                Err(e) => Err(e),
            }
        }
        fn read_interrupt(&mut self, _: &mut [u8], _: Duration) -> Result<usize> {
            Err(Error::Timeout("interrupt read"))
        }
        fn reset(&mut self) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn recording_captures_data_and_timeouts_and_replays_identically() {
        let inner = Scripted {
            reads: vec![Ok(vec![7, 8, 9]), Err(Error::Timeout("bulk read"))],
        };
        let mut rec = RecordingTransport::new(inner, "round trip");
        let mut buf = [0u8; 16];
        rec.write_bulk(&[1], T).unwrap();
        assert_eq!(rec.read_bulk(&mut buf, T).unwrap(), 3);
        assert!(rec.read_bulk(&mut buf, T).is_err());
        assert!(rec.read_interrupt(&mut buf, T).is_err());
        rec.reset().unwrap();
        let (_, transcript) = rec.into_parts();
        assert_eq!(transcript.entries.len(), 5);

        let mut replay =
            ReplayTransport::new(Transcript::from_json(&transcript.to_json()).unwrap());
        replay.write_bulk(&[1], T).unwrap();
        assert_eq!(replay.read_bulk(&mut buf, T).unwrap(), 3);
        assert!(replay.read_bulk(&mut buf, T).is_err());
        assert!(replay.read_interrupt(&mut buf, T).is_err());
        replay.reset().unwrap();
        replay.assert_finished().unwrap();
    }
}
