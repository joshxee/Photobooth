//! Android implementation: a thin, typed layer over the Kotlin `PhotoboothCameraPlugin`.

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::plugin::{PluginApi, PluginHandle};
use tauri::{AppHandle, Runtime};

use crate::models::*;
use crate::Result;

const PLUGIN_IDENTIFIER: &str = "app.tauri.photoboothcamera";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<PhotoboothCamera<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "PhotoboothCameraPlugin")?;
    Ok(PhotoboothCamera(handle))
}

pub struct PhotoboothCamera<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct RegisterListener {
    event: String,
    handler: Channel<serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoveListener {
    event: String,
    channel_id: u32,
}

#[derive(Serialize)]
struct RequestPermissions {
    permissions: [&'static str; 1],
}

impl<R: Runtime> PhotoboothCamera<R> {
    async fn call<T: DeserializeOwned>(&self, command: &str, payload: impl Serialize) -> Result<T> {
        Ok(self.0.run_mobile_plugin_async(command, payload).await?)
    }

    pub async fn usb_list(&self) -> Result<UsbListResponse> {
        self.call("usbList", ()).await
    }

    pub async fn usb_request_permission(&self, device_name: &str) -> Result<UsbPermissionResponse> {
        self.call(
            "usbRequestPermission",
            UsbDeviceRequest {
                device_name: device_name.to_owned(),
            },
        )
        .await
    }

    /// Opens the device and returns a duplicated file descriptor. Drop everything built on the
    /// fd *before* calling [`Self::usb_close`].
    pub async fn usb_open(&self, device_name: &str) -> Result<UsbOpenResponse> {
        self.call(
            "usbOpen",
            UsbDeviceRequest {
                device_name: device_name.to_owned(),
            },
        )
        .await
    }

    pub async fn usb_close(&self, device_name: &str) -> Result<()> {
        self.call(
            "usbClose",
            UsbDeviceRequest {
                device_name: device_name.to_owned(),
            },
        )
        .await
    }

    pub async fn cam_start_preview(&self, request: StartPreviewRequest) -> Result<()> {
        self.call("camStartPreview", request).await
    }

    pub async fn cam_stop_preview(&self) -> Result<()> {
        self.call("camStopPreview", ()).await
    }

    pub async fn cam_capture(&self) -> Result<CaptureResponse> {
        self.call("camCapture", ()).await
    }

    /// Asks the native gesture recognizer for an open palm inside `region` of the base64 JPEG
    /// `frame`.
    pub async fn gesture_detect(
        &self,
        frame: String,
        region: FrameRegion,
    ) -> Result<GestureResponse> {
        self.call("gestureDetect", GestureRequest { frame, region })
            .await
    }

    pub async fn check_permissions(&self) -> Result<PermissionStatus> {
        self.call("checkPermissions", ()).await
    }

    pub async fn request_permissions(&self) -> Result<PermissionStatus> {
        self.call(
            "requestPermissions",
            RequestPermissions {
                permissions: ["camera"],
            },
        )
        .await
    }

    pub async fn window_set_keep_screen_on(&self, on: bool) -> Result<()> {
        self.call("windowSetKeepScreenOn", SetFlag { on }).await
    }

    pub async fn window_set_immersive(&self, on: bool) -> Result<()> {
        self.call("windowSetImmersive", SetFlag { on }).await
    }

    /// Forwards a JS `addPluginListener` registration to Kotlin's built-in listener table.
    pub async fn register_listener(
        &self,
        event: String,
        handler: Channel<serde_json::Value>,
    ) -> Result<()> {
        self.call("registerListener", RegisterListener { event, handler })
            .await
    }

    pub async fn remove_listener(&self, event: String, channel_id: u32) -> Result<()> {
        self.call("removeListener", RemoveListener { event, channel_id })
            .await
    }
}
