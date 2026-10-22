//! Types that cross the IPC boundary, and the pure conversions behind them.

use std::fmt;

use photobooth_core::{CameraId, CameraStatus, SelectedEvent};
use serde::{Deserialize, Serialize};

use crate::portal::types::DeviceEvent;

/// How the live preview reaches the screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    /// JPEG frames streamed over an IPC channel and painted on a canvas.
    Channel,
    /// Rendered natively behind a transparent WebView; nothing is streamed.
    Native,
}

/// One row of the camera picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CameraInfo {
    pub id: CameraId,
    pub name: String,
    pub available: bool,
    /// Why the camera cannot be used right now (set when `available` is false).
    pub reason: Option<String>,
    pub preview: PreviewKind,
    pub status: CameraStatus,
    pub selected: bool,
}

/// Payload of the `camera://status` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CameraStatusEvent {
    pub camera: CameraId,
    pub status: CameraStatus,
}

/// What the operator UI knows about the portal (`portal_status` and the portal commands).
/// It never carries the device credential.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PortalStatus {
    pub enrolled: bool,
    /// The enrolled portal, or else the address the enrolment form starts with.
    pub portal_url: String,
    /// `host[:port]` of the enrolled portal.
    pub portal_host: Option<String>,
    /// The booth's name as the portal stored it.
    pub device_name: Option<String>,
    /// Where new photos go; only while enrolled.
    pub selected_event: Option<SelectedEvent>,
    /// Why the stored enrolment can't be used (a damaged file), for the operator.
    pub problem: Option<String>,
}

/// One OPEN event for the operator's picker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PortalEvent {
    pub id: String,
    pub name: String,
    pub venue: String,
    pub timezone: String,
    /// `YYYY-MM-DD`, in the event's time zone.
    pub local_date: String,
}

impl From<DeviceEvent> for PortalEvent {
    fn from(e: DeviceEvent) -> Self {
        Self {
            id: e.id,
            name: e.name,
            venue: e.venue,
            timezone: e.timezone,
            local_date: e.local_date,
        }
    }
}

/// Faults and shortcuts for the developer panel (`test_inject`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
    /// The test camera's next capture fails.
    FailNextCapture,
    /// The test camera drops its connection.
    DisconnectCamera,
    /// The test camera's next capture takes `ms`.
    SlowNextCapture { ms: u32 },
    /// Ends the current countdown immediately.
    SkipCountdown,
    /// Starts a session as if triggered from the developer panel.
    StartSession,
    /// Restores default settings.
    ResetSettings,
    /// Puts a palm in (or takes it out of) the guest's box, as if a hand were held up.
    HoldPalm { on: bool },
}

/// Command failure, serialized to the WebView as a plain string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandError(pub String);

impl CommandError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

macro_rules! command_error_from {
    ($($ty:ty),* $(,)?) => {
        $(impl From<$ty> for CommandError {
            fn from(err: $ty) -> Self {
                Self(err.to_string())
            }
        })*
    };
}

command_error_from!(
    photobooth_core::CameraError,
    photobooth_core::SettingsError,
    photobooth_core::SessionError,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fault_json_shapes() {
        let parse = |json: &str| serde_json::from_str::<Fault>(json).unwrap();
        assert_eq!(
            parse(r#"{"kind":"fail_next_capture"}"#),
            Fault::FailNextCapture
        );
        assert_eq!(
            parse(r#"{"kind":"disconnect_camera"}"#),
            Fault::DisconnectCamera
        );
        assert_eq!(
            parse(r#"{"kind":"slow_next_capture","ms":2500}"#),
            Fault::SlowNextCapture { ms: 2500 }
        );
        assert_eq!(parse(r#"{"kind":"skip_countdown"}"#), Fault::SkipCountdown);
        assert_eq!(parse(r#"{"kind":"start_session"}"#), Fault::StartSession);
        assert_eq!(parse(r#"{"kind":"reset_settings"}"#), Fault::ResetSettings);
        assert_eq!(
            parse(r#"{"kind":"hold_palm","on":true}"#),
            Fault::HoldPalm { on: true }
        );
        assert!(serde_json::from_str::<Fault>(r#"{"kind":"explode"}"#).is_err());
        assert!(serde_json::from_str::<Fault>(r#"{"kind":"slow_next_capture"}"#).is_err());
    }

    #[test]
    fn camera_info_serializes_for_the_frontend() {
        let info = CameraInfo {
            id: CameraId::SONY_USB,
            name: "Sony A7 III (USB)".into(),
            available: false,
            reason: Some("Plug in the camera".into()),
            preview: PreviewKind::Channel,
            status: CameraStatus::Error("boom".into()),
            selected: false,
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "id": "sony_usb",
                "name": "Sony A7 III (USB)",
                "available": false,
                "reason": "Plug in the camera",
                "preview": "channel",
                "status": {"state": "error", "message": "boom"},
                "selected": false,
            })
        );
    }

    #[test]
    fn status_event_shape() {
        let event = CameraStatusEvent {
            camera: CameraId::TEST,
            status: CameraStatus::Ready,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({"camera": "test", "status": {"state": "ready"}})
        );
    }

    #[test]
    fn command_errors_serialize_as_plain_strings() {
        let err: CommandError = photobooth_core::CameraError::Busy.into();
        assert_eq!(serde_json::to_string(&err).unwrap(), "\"camera is busy\"");
    }
}
