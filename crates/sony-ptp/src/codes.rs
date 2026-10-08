//! Numeric constants: PTP operations/responses/events and Sony vendor extensions.
//!
//! Generic PTP codes come from ISO 15740. Sony values (SDIO opcodes, property codes, the
//! magic object handles) are from libgphoto2 and public reverse-engineering notes; they were
//! not published by Sony. See `wiki/Wired-Camera-Protocol.md` for what has and has not been
//! confirmed against a real A7 III.

/// USB vendor id of Sony.
pub const SONY_VENDOR_ID: u16 = 0x054C;
/// USB interface class of PTP / Still Image devices.
pub const USB_CLASS_STILL_IMAGE: u8 = 0x06;

/// PTP operation codes.
pub mod op {
    pub const GET_DEVICE_INFO: u16 = 0x1001;
    pub const OPEN_SESSION: u16 = 0x1002;
    pub const CLOSE_SESSION: u16 = 0x1003;
    pub const GET_OBJECT_INFO: u16 = 0x1008;
    pub const GET_OBJECT: u16 = 0x1009;
    pub const GET_DEVICE_PROP_VALUE: u16 = 0x1015;

    pub const SDIO_CONNECT: u16 = 0x9201;
    pub const SDIO_GET_EXT_DEVICE_INFO: u16 = 0x9202;
    pub const SDIO_SET_EXT_DEVICE_PROP_VALUE: u16 = 0x9205;
    pub const SDIO_CONTROL_DEVICE: u16 = 0x9207;
    pub const SDIO_GET_ALL_EXT_DEVICE_PROP_INFO: u16 = 0x9209;
    pub const SDIO_OPEN_SESSION: u16 = 0x9210;
    pub const SDIO_GET_PARTIAL_LARGE_OBJECT: u16 = 0x9211;
    pub const SET_CONTENTS_TRANSFER_MODE: u16 = 0x9212;
}

/// PTP response codes.
pub mod rc {
    pub const OK: u16 = 0x2001;
    pub const GENERAL_ERROR: u16 = 0x2002;
    pub const SESSION_NOT_OPEN: u16 = 0x2003;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x2005;
    pub const INVALID_OBJECT_HANDLE: u16 = 0x2009;
    pub const DEVICE_PROP_NOT_SUPPORTED: u16 = 0x200A;
    pub const ACCESS_DENIED: u16 = 0x200F;
    pub const DEVICE_BUSY: u16 = 0x2019;
    pub const SESSION_ALREADY_OPEN: u16 = 0x201E;
}

/// Sony device property codes.
pub mod prop {
    /// Shutter half-press (autofocus).
    pub const SHUTTER_HALF: u16 = 0xD2C1;
    /// Shutter full press.
    pub const SHUTTER_FULL: u16 = 0xD2C2;
    /// Non-zero (>= 0x8000) when a captured image is waiting in camera memory.
    pub const OBJECT_IN_MEMORY: u16 = 0xD215;
    /// Non-zero when live view frames are available.
    pub const LIVE_VIEW_STATUS: u16 = 0xD221;
}

/// Values written to the shutter properties.
pub mod button {
    pub const UP: u16 = 0x0001;
    pub const DOWN: u16 = 0x0002;
}

/// `OBJECT_IN_MEMORY` is at or above this when an image is ready.
pub const OBJECT_IN_MEMORY_READY: u16 = 0x8000;

/// Event codes.
pub mod event {
    /// Sony's ObjectAdded (parameter 1 is the object handle).
    pub const SONY_OBJECT_ADDED: u16 = 0xC201;
    /// Standard PTP ObjectAdded.
    pub const OBJECT_ADDED: u16 = 0x4002;
}

/// Magic object handles that always refer to "the newest captured image" / "the live frame".
pub mod handle {
    pub const CAPTURED_IMAGE: u32 = 0xFFFF_C001;
    pub const LIVE_VIEW: u32 = 0xFFFF_C002;
}

/// Object format codes.
pub mod format {
    pub const JPEG: u16 = 0x3801;
    /// Sony ARW raw.
    pub const SONY_RAW: u16 = 0xB101;
}

/// Human-readable name for a response code, for error messages.
pub fn response_name(code: u16) -> &'static str {
    match code {
        rc::OK => "OK",
        rc::GENERAL_ERROR => "GeneralError",
        rc::SESSION_NOT_OPEN => "SessionNotOpen",
        rc::OPERATION_NOT_SUPPORTED => "OperationNotSupported",
        rc::INVALID_OBJECT_HANDLE => "InvalidObjectHandle",
        rc::DEVICE_PROP_NOT_SUPPORTED => "DevicePropNotSupported",
        rc::ACCESS_DENIED => "AccessDenied",
        rc::DEVICE_BUSY => "DeviceBusy",
        rc::SESSION_ALREADY_OPEN => "SessionAlreadyOpen",
        _ => "unknown response",
    }
}

/// Human-readable name for an operation code, for logs and errors.
pub fn operation_name(code: u16) -> &'static str {
    match code {
        op::GET_DEVICE_INFO => "GetDeviceInfo",
        op::OPEN_SESSION => "OpenSession",
        op::CLOSE_SESSION => "CloseSession",
        op::GET_OBJECT_INFO => "GetObjectInfo",
        op::GET_OBJECT => "GetObject",
        op::GET_DEVICE_PROP_VALUE => "GetDevicePropValue",
        op::SDIO_CONNECT => "SDIO_Connect",
        op::SDIO_GET_EXT_DEVICE_INFO => "SDIO_GetExtDeviceInfo",
        op::SDIO_SET_EXT_DEVICE_PROP_VALUE => "SDIO_SetExtDevicePropValue",
        op::SDIO_CONTROL_DEVICE => "SDIO_ControlDevice",
        op::SDIO_GET_ALL_EXT_DEVICE_PROP_INFO => "SDIO_GetAllExtDevicePropInfo",
        op::SDIO_OPEN_SESSION => "SDIO_OpenSession",
        op::SDIO_GET_PARTIAL_LARGE_OBJECT => "SDIO_GetPartialLargeObject",
        op::SET_CONTENTS_TRANSFER_MODE => "SetContentsTransferMode",
        _ => "unknown operation",
    }
}
