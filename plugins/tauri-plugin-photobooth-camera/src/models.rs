//! Request and response types shared with the Kotlin side. Field names are camelCase on the
//! wire because Kotlin's Jackson/org.json glue uses them as-is.

use serde::{Deserialize, Serialize};

/// Sony's USB vendor id (`0x054C`), the filter for `usbList`.
pub const SONY_VENDOR_ID: u16 = 0x054C;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceInfo {
    /// Android's key for the device (e.g. `/dev/bus/usb/001/004`); pass it back to the other
    /// `usb*` commands.
    pub device_name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(default)]
    pub product_name: Option<String>,
    /// Whether this app already holds permission to open the device.
    pub has_permission: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbListResponse {
    pub devices: Vec<UsbDeviceInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceRequest {
    pub device_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbPermissionResponse {
    pub granted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbOpenResponse {
    /// A file descriptor duplicated from Kotlin's `UsbDeviceConnection`. Kotlin keeps ownership
    /// (it closes it in `usbClose`); Rust must not close it, and must drop anything built on it
    /// **before** calling `usbClose`.
    pub fd: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Facing {
    Front,
    Back,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPreviewRequest {
    pub facing: Facing,
    /// Whether the guest sees a mirror image (front cameras are mirrored by default).
    pub mirror: bool,
    /// Render the preview in the activity's window rather than fullscreen.
    pub windowed: bool,
}

/// Where CameraX wrote a capture. The bytes stay on disk until the caller reads and deletes
/// the file — never pass raw JPEG bytes through JSON IPC.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum PermissionState {
    #[serde(rename = "granted")]
    Granted,
    #[serde(rename = "denied")]
    Denied,
    #[serde(rename = "prompt")]
    Prompt,
    #[serde(rename = "prompt-with-rationale")]
    PromptWithRationale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct PermissionStatus {
    pub camera: PermissionState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SetFlag {
    pub on: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn usb_list_response_parses_kotlins_camel_case() {
        let parsed: UsbListResponse = serde_json::from_value(json!({
            "devices": [{
                "deviceName": "/dev/bus/usb/001/004",
                "vendorId": 1356,
                "productId": 3699,
                "productName": "ILCE-7M3",
                "hasPermission": false
            }]
        }))
        .unwrap();
        let d = &parsed.devices[0];
        assert_eq!(d.device_name, "/dev/bus/usb/001/004");
        assert_eq!(d.vendor_id, SONY_VENDOR_ID);
        assert_eq!(d.product_name.as_deref(), Some("ILCE-7M3"));
        assert!(!d.has_permission);
    }

    #[test]
    fn product_name_is_optional() {
        let d: UsbDeviceInfo = serde_json::from_value(json!({
            "deviceName": "x", "vendorId": 1, "productId": 2, "hasPermission": true
        }))
        .unwrap();
        assert_eq!(d.product_name, None);
    }

    #[test]
    fn requests_serialize_to_the_shapes_kotlin_expects() {
        assert_eq!(
            serde_json::to_value(UsbDeviceRequest {
                device_name: "d".into()
            })
            .unwrap(),
            json!({"deviceName": "d"})
        );
        assert_eq!(
            serde_json::to_value(StartPreviewRequest {
                facing: Facing::Front,
                mirror: true,
                windowed: false
            })
            .unwrap(),
            json!({"facing": "front", "mirror": true, "windowed": false})
        );
        assert_eq!(
            serde_json::to_value(SetFlag { on: true }).unwrap(),
            json!({"on": true})
        );
    }

    #[test]
    fn responses_parse() {
        assert_eq!(
            serde_json::from_value::<UsbOpenResponse>(json!({"fd": 42})).unwrap(),
            UsbOpenResponse { fd: 42 }
        );
        assert_eq!(
            serde_json::from_value::<UsbPermissionResponse>(json!({"granted": true})).unwrap(),
            UsbPermissionResponse { granted: true }
        );
        let capture: CaptureResponse =
            serde_json::from_value(json!({"path": "/cache/a.jpg", "width": 4000, "height": 3000}))
                .unwrap();
        assert_eq!((capture.width, capture.height), (4000, 3000));
    }

    #[test]
    fn permission_states_use_tauris_wire_names() {
        for (wire, expected) in [
            ("granted", PermissionState::Granted),
            ("denied", PermissionState::Denied),
            ("prompt", PermissionState::Prompt),
            (
                "prompt-with-rationale",
                PermissionState::PromptWithRationale,
            ),
        ] {
            let status: PermissionStatus = serde_json::from_value(json!({"camera": wire})).unwrap();
            assert_eq!(status.camera, expected, "{wire}");
        }
        assert!(serde_json::from_value::<PermissionStatus>(json!({"camera": "maybe"})).is_err());
    }
}
