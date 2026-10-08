//! Sends `tracing` output to Android's logcat (`adb logcat -s Photobooth`).
//!
//! Like the in-memory ring buffer, each event's writer accumulates pieces privately and emits one
//! logcat line per newline, so multi-write events are not split or interleaved.

use std::ffi::CString;
use std::io;
use std::os::raw::c_int;

use tracing_subscriber::fmt::MakeWriter;

const TAG: &[u8] = b"Photobooth\0";
const ANDROID_LOG_INFO: c_int = 4;

#[derive(Clone, Copy)]
pub struct Logcat;

pub struct LogcatWriter {
    partial: Vec<u8>,
}

fn emit(line: &[u8]) {
    let text = String::from_utf8_lossy(line).replace('\0', " ");
    if let Ok(text) = CString::new(text) {
        // SAFETY: `TAG` and `text` are valid NUL-terminated strings that outlive the call.
        unsafe {
            android_log_sys::__android_log_write(
                ANDROID_LOG_INFO,
                TAG.as_ptr().cast(),
                text.as_ptr(),
            );
        }
    }
}

impl io::Write for LogcatWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.partial.extend_from_slice(buf);
        while let Some(end) = self.partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=end).collect();
            emit(line.trim_ascii_end());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for LogcatWriter {
    fn drop(&mut self) {
        if !self.partial.is_empty() {
            emit(self.partial.trim_ascii_end());
        }
    }
}

impl<'a> MakeWriter<'a> for Logcat {
    type Writer = LogcatWriter;

    fn make_writer(&'a self) -> Self::Writer {
        LogcatWriter {
            partial: Vec::new(),
        }
    }
}
