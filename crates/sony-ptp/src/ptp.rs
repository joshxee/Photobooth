//! The PTP transaction layer: command → optional data phase → response, over a
//! [`Transport`]. Knows nothing about Sony.

use std::time::Duration;

use crate::codes::{op, operation_name, rc};
use crate::container::{
    declared_len, encode_command, encode_data, Container, ContainerType, HEADER_LEN,
};
use crate::error::{Error, Result};
use crate::transport::Transport;

/// Largest container we will accept; guards against garbage length fields.
const MAX_CONTAINER_LEN: usize = 256 * 1024 * 1024;
/// Per-read buffer. A multiple of every USB bulk packet size (64/512/1024).
const READ_CHUNK: usize = 128 * 1024;
/// Consecutive zero-length packets tolerated before giving up.
const MAX_EMPTY_READS: u32 = 4;

#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    /// Waiting for a response to a command with no bulk payload.
    pub command: Duration,
    /// Waiting for each transfer of a data phase (images are large).
    pub data: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            command: Duration::from_secs(5),
            data: Duration::from_secs(15),
        }
    }
}

/// What the camera answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Response {
    pub code: u16,
    pub params: Vec<u32>,
    /// The data phase payload, empty if the operation had none.
    pub data: Vec<u8>,
}

impl Response {
    pub fn is_ok(&self) -> bool {
        self.code == rc::OK
    }
}

/// A PTP event read from the interrupt endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    pub code: u16,
    pub params: Vec<u32>,
}

pub struct Ptp<T: Transport> {
    transport: T,
    txid: u32,
    session_open: bool,
    leftover: Vec<u8>,
    buf: Vec<u8>,
    timeouts: Timeouts,
}

impl<T: Transport> Ptp<T> {
    pub fn new(transport: T, timeouts: Timeouts) -> Self {
        Self {
            transport,
            txid: 0,
            session_open: false,
            leftover: Vec::new(),
            buf: vec![0; READ_CHUNK],
            timeouts,
        }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    pub fn session_open(&self) -> bool {
        self.session_open
    }

    /// Opens a PTP session. Transaction ids restart at 1 afterwards.
    pub fn open_session(&mut self, session_id: u32) -> Result<()> {
        let response = self.transaction(op::OPEN_SESSION, &[session_id], None)?;
        match response.code {
            rc::OK => {}
            rc::SESSION_ALREADY_OPEN => {
                tracing::debug!("session already open; closing and reopening");
                self.session_open = true;
                self.close_session()?;
                return self.open_session(session_id);
            }
            code => return Err(Error::response(operation_name(op::OPEN_SESSION), code)),
        }
        self.session_open = true;
        self.txid = 0;
        Ok(())
    }

    /// Closes the session; tolerant of a camera that has already dropped it.
    pub fn close_session(&mut self) -> Result<()> {
        if !self.session_open {
            return Ok(());
        }
        let response = self.transaction(op::CLOSE_SESSION, &[], None)?;
        self.session_open = false;
        self.txid = 0;
        match response.code {
            rc::OK | rc::SESSION_NOT_OPEN => Ok(()),
            code => Err(Error::response(operation_name(op::CLOSE_SESSION), code)),
        }
    }

    /// Runs one transaction and returns the response whatever its code.
    ///
    /// A transport failure is logged with the operation that was in flight and, for I/O errors,
    /// the operation is named in the error text — "Pipe error" alone says nothing about *which*
    /// command a camera stalled on.
    pub fn transaction(
        &mut self,
        operation: u16,
        params: &[u32],
        data_out: Option<&[u8]>,
    ) -> Result<Response> {
        match self.run_transaction(operation, params, data_out) {
            Err(Error::Stall(what)) => {
                // A halted endpoint refuses all further traffic until the halt is cleared, so a
                // single rejected command would otherwise wedge every operation after it.
                tracing::warn!(
                    operation = operation_name(operation),
                    ?params,
                    what,
                    "camera stalled the USB pipe; clearing the halt"
                );
                self.leftover.clear();
                if let Err(reset_err) = self.transport.reset() {
                    tracing::warn!(%reset_err, "clearing the halt failed");
                }
                Err(Error::Stall(format!(
                    "{} failed: {what}",
                    operation_name(operation)
                )))
            }
            Err(err @ (Error::Io(_) | Error::Timeout(_))) => {
                tracing::warn!(
                    operation = operation_name(operation),
                    ?params,
                    %err,
                    "PTP transaction failed"
                );
                Err(match err {
                    Error::Io(message) => {
                        Error::Io(format!("{} failed: {message}", operation_name(operation)))
                    }
                    other => other,
                })
            }
            other => other,
        }
    }

    fn run_transaction(
        &mut self,
        operation: u16,
        params: &[u32],
        data_out: Option<&[u8]>,
    ) -> Result<Response> {
        let txid = if self.session_open {
            self.txid = self.txid.wrapping_add(1);
            self.txid
        } else {
            0
        };
        tracing::trace!(
            operation = operation_name(operation),
            txid,
            ?params,
            "ptp →"
        );

        self.write_all(&encode_command(operation, txid, params))?;
        if let Some(data) = data_out {
            self.write_all(&encode_data(operation, txid, data))?;
        }

        let mut data = Vec::new();
        loop {
            let timeout = if data.is_empty() {
                self.timeouts.command
            } else {
                self.timeouts.data
            };
            let raw = self.read_container(timeout)?;
            let container = Container::parse(&raw)?;
            match container.kind {
                ContainerType::Data => {
                    // The first byte of a large data phase can take a while to arrive, so the
                    // *next* read (the response) uses the long timeout too.
                    data = container.payload;
                    if data.is_empty() {
                        // Keep "had a data phase" distinguishable only by content; an empty
                        // data phase is treated like none.
                        continue;
                    }
                }
                ContainerType::Response => {
                    if container.txid != txid {
                        tracing::warn!(
                            expected = txid,
                            got = container.txid,
                            "response transaction id mismatch"
                        );
                    }
                    tracing::trace!(
                        operation = operation_name(operation),
                        code = container.code,
                        data_len = data.len(),
                        "ptp ←"
                    );
                    return Ok(Response {
                        code: container.code,
                        params: container.params(),
                        data,
                    });
                }
                ContainerType::Event => {
                    tracing::debug!(code = container.code, "event arrived on the bulk pipe");
                }
                ContainerType::Command => {
                    return Err(Error::Protocol(
                        "camera sent a command container".to_owned(),
                    ));
                }
            }
        }
    }

    /// Like [`Self::transaction`] but turns a non-OK response code into an error.
    pub fn call(
        &mut self,
        operation: u16,
        params: &[u32],
        data_out: Option<&[u8]>,
    ) -> Result<Response> {
        let response = self.transaction(operation, params, data_out)?;
        if response.is_ok() {
            Ok(response)
        } else {
            Err(Error::response(operation_name(operation), response.code))
        }
    }

    /// Reads one event from the interrupt endpoint, or `None` if none arrives in `timeout`.
    /// `timeout` must be non-zero (libusb treats zero as "wait forever").
    pub fn poll_event(&mut self, timeout: Duration) -> Result<Option<Event>> {
        let mut buf = [0u8; 64];
        match self.transport.read_interrupt(&mut buf, timeout) {
            Ok(0) | Err(Error::Timeout(_)) => Ok(None),
            Ok(n) => {
                let container = Container::parse(&buf[..n])?;
                if container.kind != ContainerType::Event {
                    return Err(Error::Protocol(format!(
                        "expected an event on the interrupt pipe, got {:?}",
                        container.kind
                    )));
                }
                Ok(Some(Event {
                    code: container.code,
                    params: container.params(),
                }))
            }
            Err(e) => Err(e),
        }
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        let mut sent = 0;
        while sent < bytes.len() {
            let n = self
                .transport
                .write_bulk(&bytes[sent..], self.timeouts.command)?;
            if n == 0 {
                return Err(Error::Io("bulk write accepted zero bytes".to_owned()));
            }
            sent += n;
        }
        Ok(())
    }

    /// Reassembles exactly one container, which may arrive over several USB transfers; any
    /// bytes beyond it are kept for the next call.
    fn read_container(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        let mut acc = std::mem::take(&mut self.leftover);
        let mut empty_reads = 0;
        loop {
            if let Some(len) = declared_len(&acc) {
                if !(HEADER_LEN..=MAX_CONTAINER_LEN).contains(&len) {
                    return Err(Error::Protocol(format!(
                        "implausible container length {len}"
                    )));
                }
                if acc.len() >= len {
                    self.leftover = acc.split_off(len);
                    return Ok(acc);
                }
            }
            let n = self.transport.read_bulk(&mut self.buf, timeout)?;
            if n == 0 {
                empty_reads += 1;
                if empty_reads > MAX_EMPTY_READS {
                    return Err(Error::Protocol("camera sent only empty packets".to_owned()));
                }
                continue;
            }
            acc.extend_from_slice(&self.buf[..n]);
        }
    }
}
