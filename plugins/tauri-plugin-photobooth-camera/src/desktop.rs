//! Non-Android stub: every native call reports that it is unsupported.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use tauri::ipc::Channel;
use tauri::plugin::PluginApi;
use tauri::{AppHandle, Runtime};

use crate::models::*;
use crate::{Error, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<PhotoboothCamera<R>> {
    Ok(PhotoboothCamera(PhantomData))
}

pub struct PhotoboothCamera<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> PhotoboothCamera<R> {
    pub async fn usb_list(&self) -> Result<UsbListResponse> {
        Err(Error::Unsupported("USB host"))
    }

    pub async fn usb_request_permission(
        &self,
        _device_name: &str,
    ) -> Result<UsbPermissionResponse> {
        Err(Error::Unsupported("USB host"))
    }

    pub async fn usb_open(&self, _device_name: &str) -> Result<UsbOpenResponse> {
        Err(Error::Unsupported("USB host"))
    }

    pub async fn usb_close(&self, _device_name: &str) -> Result<()> {
        Err(Error::Unsupported("USB host"))
    }

    pub async fn cam_start_preview(&self, _request: StartPreviewRequest) -> Result<()> {
        Err(Error::Unsupported("the native camera"))
    }

    pub async fn cam_stop_preview(&self) -> Result<()> {
        Err(Error::Unsupported("the native camera"))
    }

    pub async fn cam_capture(&self) -> Result<CaptureResponse> {
        Err(Error::Unsupported("the native camera"))
    }

    pub async fn check_permissions(&self) -> Result<PermissionStatus> {
        Err(Error::Unsupported("the native camera"))
    }

    pub async fn request_permissions(&self) -> Result<PermissionStatus> {
        Err(Error::Unsupported("the native camera"))
    }

    pub async fn window_set_keep_screen_on(&self, _on: bool) -> Result<()> {
        Err(Error::Unsupported("window control"))
    }

    pub async fn window_set_immersive(&self, _on: bool) -> Result<()> {
        Err(Error::Unsupported("window control"))
    }

    pub async fn register_listener(
        &self,
        _event: String,
        _handler: Channel<serde_json::Value>,
    ) -> Result<()> {
        Err(Error::Unsupported("plugin events"))
    }

    pub async fn remove_listener(&self, _event: String, _channel_id: u32) -> Result<()> {
        Err(Error::Unsupported("plugin events"))
    }
}
