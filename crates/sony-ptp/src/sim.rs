//! A byte-level simulated Sony camera behind [`Transport`], for tests and hardware-free
//! development. It speaks the protocol as described in `wiki/Wired-Camera-Protocol.md`, so it is
//! an executable statement of what the engine *assumes* — it proves the engine is self-consistent
//! and robust, **not** that a real A7 III behaves this way.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::codes::{event, format, handle, op, prop, rc};
use crate::container::{
    encode_data, encode_event, encode_response, encode_string, Container, ContainerType, ObjectInfo,
};
use crate::error::{Error, Result};
use crate::props::encode_u16_props;
use crate::transport::Transport;

/// What the simulated camera should do. `Default` is a well-behaved A7 III in PC Remote mode.
#[derive(Clone, Debug)]
pub struct SimConfig {
    pub model: String,
    /// Advertise Sony's SDIO operations (false = camera in the wrong USB mode).
    pub pc_remote: bool,
    /// Empty answers to `SDIO_GetExtDeviceInfo` before real data.
    pub ext_info_empty_replies: u32,
    /// Largest number of bytes a single bulk read returns (simulates USB packetization).
    pub max_transfer: usize,
    /// Whether `SDIO_GetAllExtDevicePropInfo` is supported (otherwise only `GetDevicePropValue`).
    pub props_via_ext_info: bool,
    /// Property polls before a captured image is reported in memory.
    pub image_ready_after_polls: u32,
    /// Also announce the image with an `ObjectAdded` event.
    pub send_object_added_event: bool,
    /// Produce an ARW before the JPEG (RAW+JPEG quality).
    pub raw_plus_jpeg: bool,
    /// With `raw_plus_jpeg`, deliver the JPEG first and the ARW second (what a real A7 III does).
    pub jpeg_first: bool,
    pub jpeg_payload_len: usize,
    pub image_width: u32,
    pub image_height: u32,
    pub chunked_download_supported: bool,
    /// Property polls before `LiveViewStatus` turns non-zero.
    pub live_view_after_polls: u32,
    pub faults: Vec<Fault>,
}

impl Default for SimConfig {
    fn default() -> Self {
        Self {
            model: "ILCE-7M3".to_owned(),
            pc_remote: true,
            ext_info_empty_replies: 3,
            max_transfer: 512,
            props_via_ext_info: true,
            image_ready_after_polls: 2,
            send_object_added_event: true,
            raw_plus_jpeg: false,
            jpeg_first: false,
            jpeg_payload_len: 3_000,
            image_width: 6000,
            image_height: 4000,
            chunked_download_supported: true,
            live_view_after_polls: 1,
            faults: Vec::new(),
        }
    }
}

/// A fault injected at the Nth occurrence (1-based) of an operation.
#[derive(Clone, Debug)]
pub enum Fault {
    /// Answer with this response code instead of acting.
    Respond { op: u16, nth: u32, code: u16 },
    /// Never answer: reads time out afterwards (a camera stuck in the wrong mode).
    Stall { op: u16, nth: u32 },
    /// The bulk write carrying the command fails with an I/O error.
    WriteError { op: u16, nth: u32 },
    /// The bulk write panics (to prove drop-guards run while unwinding).
    PanicOnWrite { op: u16, nth: u32 },
    /// The camera stalls the pipe on this command: it is accepted, then every transfer fails
    /// with a stall until the host clears the halt (`Transport::reset`) — as a real endpoint
    /// halt does.
    PipeError { op: u16, nth: u32 },
}

/// One operation the camera received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpRecord {
    pub op: u16,
    pub params: Vec<u32>,
    pub data: Vec<u8>,
    pub txid: u32,
}

#[derive(Default)]
struct State {
    session_open: bool,
    out: VecDeque<Vec<u8>>,
    events: VecDeque<Vec<u8>>,
    pending_data_op: Option<(u16, Vec<u32>, u32)>,
    ops: Vec<OpRecord>,
    op_counts: std::collections::HashMap<u16, u32>,
    stalled: bool,
    ext_info_replies_sent: u32,
    s1_down: bool,
    s2_down: bool,
    shutter_log: Vec<(u16, u16)>,
    image_polls_left: Option<u32>,
    objects: VecDeque<(ObjectInfo, Vec<u8>)>,
    in_memory: bool,
    live_polls_seen: u32,
    exposures: u32,
    next_live_frame: u32,
    chunk_requests: u32,
    current_op: u16,
    halted: bool,
    resets: u32,
}

/// The transport the engine talks to.
pub struct SimTransport {
    cfg: SimConfig,
    state: Arc<Mutex<State>>,
}

/// Observes the simulated camera after the transport has been moved into an engine.
#[derive(Clone)]
pub struct SimHandle {
    state: Arc<Mutex<State>>,
}

impl SimTransport {
    pub fn new(cfg: SimConfig) -> (Self, SimHandle) {
        let state = Arc::new(Mutex::new(State::default()));
        (
            Self {
                cfg,
                state: state.clone(),
            },
            SimHandle { state },
        )
    }
}

fn lock(state: &Arc<Mutex<State>>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

impl SimHandle {
    /// Every operation received, in order.
    pub fn ops(&self) -> Vec<OpRecord> {
        lock(&self.state).ops.clone()
    }

    pub fn count(&self, operation: u16) -> usize {
        lock(&self.state)
            .ops
            .iter()
            .filter(|r| r.op == operation)
            .count()
    }

    /// `(property, value)` for every `SDIO_ControlDevice` call that took effect.
    pub fn shutter_log(&self) -> Vec<(u16, u16)> {
        lock(&self.state).shutter_log.clone()
    }

    pub fn shutter_held(&self) -> bool {
        let s = lock(&self.state);
        s.s1_down || s.s2_down
    }

    pub fn exposures(&self) -> u32 {
        lock(&self.state).exposures
    }

    pub fn chunk_requests(&self) -> u32 {
        lock(&self.state).chunk_requests
    }

    /// Objects the camera is still holding for the host.
    pub fn pending_objects(&self) -> usize {
        lock(&self.state).objects.len()
    }

    /// How many times the host cleared a halted endpoint.
    pub fn resets(&self) -> u32 {
        lock(&self.state).resets
    }

    pub fn session_open(&self) -> bool {
        lock(&self.state).session_open
    }
}

fn jpeg_bytes(len: usize, seed: u8) -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8];
    v.extend((0..len).map(|i| (i as u8).wrapping_add(seed) & 0x7F));
    v.extend_from_slice(&[0xFF, 0xD9]);
    v
}

fn u16_array(values: &[u16]) -> Vec<u8> {
    let mut out = (values.len() as u32).to_le_bytes().to_vec();
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

impl SimTransport {
    fn device_info(&self) -> Vec<u8> {
        let mut ops = vec![
            op::GET_DEVICE_INFO,
            op::OPEN_SESSION,
            op::CLOSE_SESSION,
            op::GET_OBJECT_INFO,
            op::GET_OBJECT,
            op::GET_DEVICE_PROP_VALUE,
        ];
        if self.cfg.pc_remote {
            ops.extend([
                op::SDIO_CONNECT,
                op::SDIO_GET_EXT_DEVICE_INFO,
                op::SDIO_SET_EXT_DEVICE_PROP_VALUE,
                op::SDIO_CONTROL_DEVICE,
                op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO,
                op::SDIO_GET_PARTIAL_LARGE_OBJECT,
            ]);
        }
        let mut out = Vec::new();
        out.extend_from_slice(&100u16.to_le_bytes());
        out.extend_from_slice(&0x11u32.to_le_bytes());
        out.extend_from_slice(&100u16.to_le_bytes());
        out.extend_from_slice(&encode_string("sony.net/SDIO:"));
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&u16_array(&ops));
        out.extend_from_slice(&u16_array(&[event::SONY_OBJECT_ADDED]));
        out.extend_from_slice(&u16_array(&[]));
        out.extend_from_slice(&u16_array(&[]));
        out.extend_from_slice(&u16_array(&[format::JPEG]));
        out.extend_from_slice(&encode_string("Sony Corporation"));
        out.extend_from_slice(&encode_string(&self.cfg.model));
        out.extend_from_slice(&encode_string("3.10"));
        out.extend_from_slice(&encode_string("SIM0001"));
        out
    }

    fn fault(&self, operation: u16, count: u32) -> Option<&Fault> {
        self.cfg.faults.iter().find(|f| match f {
            Fault::Respond { op, nth, .. }
            | Fault::Stall { op, nth }
            | Fault::WriteError { op, nth }
            | Fault::PanicOnWrite { op, nth }
            | Fault::PipeError { op, nth } => *op == operation && *nth == count,
        })
    }

    fn respond(state: &mut State, txid: u32, code: u16, data: Option<Vec<u8>>) {
        if let Some(data) = data {
            let operation = state.current_op;
            state.out.push_back(encode_data(operation, txid, &data));
        }
        state.out.push_back(encode_response(code, txid, &[]));
    }

    /// Executes a complete operation (command plus any data phase).
    fn execute(&self, state: &mut State, operation: u16, params: &[u32], data: &[u8], txid: u32) {
        state.current_op = operation;
        let count = *state.op_counts.entry(operation).or_insert(0);
        // `count` was already bumped when the command arrived.
        if let Some(Fault::Respond { code, .. }) = self.fault(operation, count) {
            Self::respond(state, txid, *code, None);
            return;
        }
        if let Some(Fault::Stall { .. }) = self.fault(operation, count) {
            state.stalled = true;
            return;
        }

        if operation != op::GET_DEVICE_INFO && operation != op::OPEN_SESSION && !state.session_open
        {
            Self::respond(state, txid, rc::SESSION_NOT_OPEN, None);
            return;
        }

        match operation {
            op::GET_DEVICE_INFO => Self::respond(state, txid, rc::OK, Some(self.device_info())),
            op::OPEN_SESSION => {
                if state.session_open {
                    Self::respond(state, txid, rc::SESSION_ALREADY_OPEN, None);
                } else {
                    state.session_open = true;
                    Self::respond(state, txid, rc::OK, None);
                }
            }
            op::CLOSE_SESSION => {
                state.session_open = false;
                Self::respond(state, txid, rc::OK, None);
            }
            op::SDIO_CONNECT => {
                let phase = params.first().copied().unwrap_or(0);
                Self::respond(state, txid, rc::OK, Some(phase.to_le_bytes().to_vec()));
            }
            op::SDIO_GET_EXT_DEVICE_INFO => {
                if state.ext_info_replies_sent < self.cfg.ext_info_empty_replies {
                    state.ext_info_replies_sent += 1;
                    Self::respond(state, txid, rc::OK, None);
                } else {
                    Self::respond(state, txid, rc::OK, Some(vec![0xC8, 0, 0, 0, 1, 0, 0, 0]));
                }
            }
            op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO => {
                if self.cfg.props_via_ext_info {
                    let props = self.current_props(state);
                    Self::respond(state, txid, rc::OK, Some(encode_u16_props(&props)));
                } else {
                    Self::respond(state, txid, rc::OPERATION_NOT_SUPPORTED, None);
                }
            }
            op::GET_DEVICE_PROP_VALUE => {
                let code = params.first().copied().unwrap_or(0) as u16;
                match self.current_props(state).iter().find(|(c, _)| *c == code) {
                    Some((_, v)) if !self.cfg.props_via_ext_info => {
                        Self::respond(state, txid, rc::OK, Some(v.to_le_bytes().to_vec()));
                    }
                    _ => Self::respond(state, txid, rc::DEVICE_PROP_NOT_SUPPORTED, None),
                }
            }
            op::SDIO_CONTROL_DEVICE => self.control(state, params, data, txid),
            op::GET_OBJECT_INFO => match state.objects.front() {
                Some((info, _))
                    if state.in_memory && params.first() == Some(&handle::CAPTURED_IMAGE) =>
                {
                    let encoded = info.encode();
                    Self::respond(state, txid, rc::OK, Some(encoded));
                }
                _ => Self::respond(state, txid, rc::INVALID_OBJECT_HANDLE, None),
            },
            op::GET_OBJECT => self.get_object(state, params, txid),
            op::SDIO_GET_PARTIAL_LARGE_OBJECT => self.get_partial(state, params, txid),
            _ => Self::respond(state, txid, rc::OPERATION_NOT_SUPPORTED, None),
        }
    }

    /// Time passes: each command received brings a pending image closer to being ready, and the
    /// camera announces it when it is.
    fn tick(&self, state: &mut State) {
        let Some(left) = state.image_polls_left else {
            return;
        };
        if left > 0 {
            state.image_polls_left = Some(left - 1);
            return;
        }
        state.image_polls_left = None;
        state.in_memory = true;
        if self.cfg.send_object_added_event {
            state.events.push_back(encode_event(
                event::SONY_OBJECT_ADDED,
                0,
                &[handle::CAPTURED_IMAGE],
            ));
        }
    }

    fn current_props(&self, state: &mut State) -> Vec<(u16, u16)> {
        state.live_polls_seen += 1;
        let live = u16::from(state.live_polls_seen > self.cfg.live_view_after_polls);
        vec![
            (
                prop::OBJECT_IN_MEMORY,
                if state.in_memory { 0x8001 } else { 0x0000 },
            ),
            (prop::LIVE_VIEW_STATUS, live),
        ]
    }

    fn control(&self, state: &mut State, params: &[u32], data: &[u8], txid: u32) {
        let code = params.first().copied().unwrap_or(0) as u16;
        let value = match data {
            [lo, hi] => u16::from_le_bytes([*lo, *hi]),
            _ => {
                Self::respond(state, txid, rc::GENERAL_ERROR, None);
                return;
            }
        };
        state.shutter_log.push((code, value));
        match (code, value) {
            (prop::SHUTTER_HALF, 2) => state.s1_down = true,
            (prop::SHUTTER_HALF, 1) => state.s1_down = false,
            (prop::SHUTTER_FULL, 2) => {
                state.s2_down = true;
                if state.s1_down {
                    state.exposures += 1;
                    state.image_polls_left = Some(self.cfg.image_ready_after_polls);
                    // Like a real camera, objects nobody fetched stay queued (and
                    // ObjectInMemory stays set) — a new exposure appends to them.
                    let n = state.exposures as u8;
                    let raw = (
                        ObjectInfo {
                            format: format::SONY_RAW,
                            compressed_size: 5_000,
                            width: self.cfg.image_width,
                            height: self.cfg.image_height,
                            filename: format!("DSC{n:05}.ARW"),
                        },
                        vec![0xAA; 5_000],
                    );
                    let jpeg_data = jpeg_bytes(self.cfg.jpeg_payload_len, n);
                    let jpeg = (
                        ObjectInfo {
                            format: format::JPEG,
                            compressed_size: jpeg_data.len() as u32,
                            width: self.cfg.image_width,
                            height: self.cfg.image_height,
                            filename: format!("DSC{n:05}.JPG"),
                        },
                        jpeg_data,
                    );
                    match (self.cfg.raw_plus_jpeg, self.cfg.jpeg_first) {
                        (false, _) => state.objects.push_back(jpeg),
                        (true, false) => {
                            state.objects.push_back(raw);
                            state.objects.push_back(jpeg);
                        }
                        (true, true) => {
                            state.objects.push_back(jpeg);
                            state.objects.push_back(raw);
                        }
                    }
                }
            }
            (prop::SHUTTER_FULL, 1) => state.s2_down = false,
            _ => {}
        }
        Self::respond(state, txid, rc::OK, None);
    }

    fn get_object(&self, state: &mut State, params: &[u32], txid: u32) {
        match params.first().copied() {
            Some(handle::CAPTURED_IMAGE) if state.in_memory => {
                if let Some((_, data)) = state.objects.pop_front() {
                    if state.objects.is_empty() {
                        state.in_memory = false;
                    }
                    Self::respond(state, txid, rc::OK, Some(data));
                } else {
                    Self::respond(state, txid, rc::INVALID_OBJECT_HANDLE, None);
                }
            }
            Some(handle::LIVE_VIEW) => {
                if state.live_polls_seen > self.cfg.live_view_after_polls {
                    state.next_live_frame += 1;
                    let jpeg = jpeg_bytes(400, state.next_live_frame as u8);
                    let mut frame = Vec::new();
                    frame.extend_from_slice(&16u32.to_le_bytes());
                    frame.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
                    frame.extend_from_slice(&[0; 8]);
                    frame.extend_from_slice(&jpeg);
                    frame.extend_from_slice(b"focus-frame-info");
                    Self::respond(state, txid, rc::OK, Some(frame));
                } else {
                    Self::respond(state, txid, rc::DEVICE_BUSY, None);
                }
            }
            _ => Self::respond(state, txid, rc::INVALID_OBJECT_HANDLE, None),
        }
    }

    fn get_partial(&self, state: &mut State, params: &[u32], txid: u32) {
        if !self.cfg.chunked_download_supported {
            Self::respond(state, txid, rc::OPERATION_NOT_SUPPORTED, None);
            return;
        }
        state.chunk_requests += 1;
        let (offset_lo, offset_hi, len) = (params[1], params[2], params[3]);
        let offset = (u64::from(offset_hi) << 32 | u64::from(offset_lo)) as usize;
        let Some((_, data)) = state.objects.front() else {
            Self::respond(state, txid, rc::INVALID_OBJECT_HANDLE, None);
            return;
        };
        let end = (offset + len as usize).min(data.len());
        let chunk = data.get(offset..end).unwrap_or_default().to_vec();
        if end >= data.len() {
            state.objects.pop_front();
            if state.objects.is_empty() {
                state.in_memory = false;
            }
        }
        Self::respond(state, txid, rc::OK, Some(chunk));
    }
}

impl Transport for SimTransport {
    fn write_bulk(&mut self, buf: &[u8], _timeout: Duration) -> Result<usize> {
        let container = Container::parse(buf)?;
        let mut state = lock(&self.state);
        if state.halted {
            return Err(Error::Stall("bulk write".to_owned()));
        }
        match container.kind {
            ContainerType::Command => {
                let operation = container.code;
                let count = {
                    let c = state.op_counts.entry(operation).or_insert(0);
                    *c += 1;
                    *c
                };
                match self.fault(operation, count) {
                    Some(Fault::WriteError { .. }) => {
                        return Err(Error::Io("simulated bulk write failure".to_owned()));
                    }
                    Some(Fault::PipeError { .. }) => {
                        state.ops.push(OpRecord {
                            op: operation,
                            params: container.params(),
                            data: Vec::new(),
                            txid: container.txid,
                        });
                        state.halted = true;
                        return Ok(buf.len());
                    }
                    Some(Fault::PanicOnWrite { .. }) => {
                        drop(state);
                        panic!("simulated panic while writing {operation:#06x}");
                    }
                    _ => {}
                }
                self.tick(&mut state);
                let params = container.params();
                if matches!(
                    operation,
                    op::SDIO_CONTROL_DEVICE | op::SDIO_SET_EXT_DEVICE_PROP_VALUE
                ) {
                    state.pending_data_op = Some((operation, params, container.txid));
                } else {
                    state.ops.push(OpRecord {
                        op: operation,
                        params: params.clone(),
                        data: Vec::new(),
                        txid: container.txid,
                    });
                    self.execute(&mut state, operation, &params, &[], container.txid);
                }
            }
            ContainerType::Data => {
                let (operation, params, txid) = state
                    .pending_data_op
                    .take()
                    .ok_or_else(|| Error::Protocol("unexpected data container".to_owned()))?;
                state.ops.push(OpRecord {
                    op: operation,
                    params: params.clone(),
                    data: container.payload.clone(),
                    txid,
                });
                self.execute(&mut state, operation, &params, &container.payload, txid);
            }
            other => {
                return Err(Error::Protocol(format!("host sent a {other:?} container")));
            }
        }
        Ok(buf.len())
    }

    fn read_bulk(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        let mut state = lock(&self.state);
        if state.halted {
            return Err(Error::Stall("bulk read".to_owned()));
        }
        if state.stalled {
            return Err(Error::Timeout("bulk read"));
        }
        let Some(front) = state.out.front_mut() else {
            return Err(Error::Timeout("bulk read"));
        };
        let n = front.len().min(buf.len()).min(self.cfg.max_transfer);
        buf[..n].copy_from_slice(&front[..n]);
        front.drain(..n);
        if front.is_empty() {
            state.out.pop_front();
        }
        Ok(n)
    }

    fn read_interrupt(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        let mut state = lock(&self.state);
        match state.events.pop_front() {
            Some(ev) => {
                buf[..ev.len()].copy_from_slice(&ev);
                Ok(ev.len())
            }
            None => Err(Error::Timeout("interrupt read")),
        }
    }

    fn reset(&mut self) -> Result<()> {
        let mut state = lock(&self.state);
        state.out.clear();
        state.events.clear();
        state.stalled = false;
        state.halted = false;
        state.resets += 1;
        Ok(())
    }
}
