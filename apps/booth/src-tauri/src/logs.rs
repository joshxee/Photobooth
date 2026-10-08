//! In-memory ring buffer of recent log lines, fed by `tracing`.
//!
//! `tracing_subscriber`'s fmt writer may call `write()` any number of times per event — in
//! pieces, not once per line. Each event gets its own [`RingWriter`], which accumulates its
//! pieces privately and records an entry only when it sees a newline (or is dropped with an
//! unterminated tail). Keeping the partial text per writer, not in the shared buffer, is what
//! stops pieces from different threads interleaving into corrupt lines.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;

struct Ring {
    capacity: usize,
    lines: VecDeque<String>,
}

impl Ring {
    fn push_line(&mut self, line: String) {
        if self.lines.len() == self.capacity {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }
}

#[derive(Clone)]
pub struct LogRingBuffer {
    inner: Arc<Mutex<Ring>>,
}

impl LogRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Ring {
                capacity: capacity.max(1),
                lines: VecDeque::new(),
            })),
        }
    }

    fn ring(&self) -> MutexGuard<'_, Ring> {
        // A panic while logging must not take logging down with it.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn push(&self, raw: &[u8]) {
        let text = String::from_utf8_lossy(raw);
        self.ring()
            .push_line(text.trim_end_matches(['\r', '\n']).to_owned());
    }

    /// The most recent `limit` complete lines, oldest first.
    pub fn recent(&self, limit: usize) -> Vec<String> {
        let ring = self.ring();
        let skip = ring.lines.len().saturating_sub(limit);
        ring.lines.iter().skip(skip).cloned().collect()
    }
}

pub struct RingWriter {
    buffer: LogRingBuffer,
    partial: Vec<u8>,
}

impl io::Write for RingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.partial.extend_from_slice(buf);
        while let Some(end) = self.partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            self.buffer.push(&line);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for RingWriter {
    fn drop(&mut self) {
        if !self.partial.is_empty() {
            self.buffer.push(&self.partial);
        }
    }
}

impl<'a> MakeWriter<'a> for LogRingBuffer {
    type Writer = RingWriter;

    fn make_writer(&'a self) -> Self::Writer {
        RingWriter {
            buffer: self.clone(),
            partial: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tracing_subscriber::fmt;

    #[test]
    fn partial_writes_are_joined_until_a_newline() {
        let logs = LogRingBuffer::new(10);
        let mut w = logs.make_writer();
        w.write_all(b"INFO app: start").unwrap();
        assert!(
            logs.recent(10).is_empty(),
            "no newline yet, nothing recorded"
        );
        w.write_all(b"ed key=value").unwrap();
        w.write_all(b"\nWARN app: second\n").unwrap();
        assert_eq!(
            logs.recent(10),
            vec!["INFO app: started key=value", "WARN app: second"]
        );
    }

    #[test]
    fn a_trailing_fragment_waits_for_its_newline() {
        let logs = LogRingBuffer::new(10);
        let mut w = logs.make_writer();
        w.write_all(b"one\ntw").unwrap();
        assert_eq!(logs.recent(10), vec!["one"]);
        w.write_all(b"o\r\n").unwrap();
        assert_eq!(logs.recent(10), vec!["one", "two"]);
    }

    #[test]
    fn an_unterminated_tail_is_kept_when_the_writer_is_dropped() {
        let logs = LogRingBuffer::new(10);
        {
            let mut w = logs.make_writer();
            w.write_all(b"no newline at all").unwrap();
        }
        assert_eq!(logs.recent(10), vec!["no newline at all"]);
    }

    #[test]
    fn interleaved_writers_keep_their_own_text_apart() {
        let logs = LogRingBuffer::new(10);
        let mut a = logs.make_writer();
        let mut b = logs.make_writer();
        a.write_all(b"AAA-").unwrap();
        b.write_all(b"BBB-").unwrap();
        a.write_all(b"aaa\n").unwrap();
        b.write_all(b"bbb\n").unwrap();
        assert_eq!(logs.recent(10), vec!["AAA-aaa", "BBB-bbb"]);
    }

    #[test]
    fn oldest_lines_are_evicted() {
        let logs = LogRingBuffer::new(3);
        let mut w = logs.make_writer();
        for i in 0..5 {
            writeln!(w, "line {i}").unwrap();
        }
        assert_eq!(logs.recent(10), vec!["line 2", "line 3", "line 4"]);
        assert_eq!(logs.recent(2), vec!["line 3", "line 4"]);
        assert!(logs.recent(0).is_empty());
    }

    #[test]
    fn invalid_utf8_does_not_panic() {
        let logs = LogRingBuffer::new(3);
        let mut w = logs.make_writer();
        w.write_all(&[b'a', 0xFF, b'b', b'\n']).unwrap();
        assert_eq!(logs.recent(1).len(), 1);
    }

    /// The case the buffer exists for: a real tracing event with several fields.
    #[test]
    fn multi_field_tracing_events_arrive_as_whole_lines() {
        let logs = LogRingBuffer::new(10);
        let subscriber = fmt()
            .with_writer(logs.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(camera = "test", attempt = 3, ok = true, "capture finished");
            tracing::warn!(reason = "x", "second event");
        });
        let lines = logs.recent(10);
        assert_eq!(lines.len(), 2, "{lines:?}");
        for needle in [
            "capture finished",
            "camera=\"test\"",
            "attempt=3",
            "ok=true",
        ] {
            assert!(
                lines[0].contains(needle),
                "{needle} missing from {:?}",
                lines[0]
            );
        }
        assert!(lines[1].contains("second event") && lines[1].contains("reason=\"x\""));
    }

    #[test]
    fn concurrent_writers_never_lose_or_corrupt_lines() {
        let logs = LogRingBuffer::new(1000);
        let threads: Vec<_> = (0..4)
            .map(|t| {
                let logs = logs.clone();
                std::thread::spawn(move || {
                    for i in 0..100 {
                        let mut w = logs.make_writer();
                        // `writeln!` writes in several pieces, like a fmt writer can.
                        writeln!(w, "t{t}-{i}").unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let lines = logs.recent(1000);
        assert_eq!(lines.len(), 400);
        for line in &lines {
            let (t, i) = line
                .strip_prefix('t')
                .and_then(|r| r.split_once('-'))
                .unwrap_or_else(|| panic!("corrupt line {line:?}"));
            assert!(
                t.parse::<u8>().is_ok() && i.parse::<u8>().is_ok(),
                "{line:?}"
            );
        }
    }
}
