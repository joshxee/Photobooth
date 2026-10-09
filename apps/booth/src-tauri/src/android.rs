//! Android-specific camera wiring. Compiled on Android, and in unit tests everywhere so the
//! logic below is checked and tested without a device.

use std::sync::Arc;

use async_trait::async_trait;
use photobooth_core::Camera;
use tauri_plugin_photobooth_camera::usb::{UsbBackend, UsbSonyCamera};

use crate::state::CameraProvider;

/// Offers the Sony camera only while one is plugged in: `camera_list` polls this, so the card
/// becomes selectable as soon as the cable goes in. The camera itself is built lazily when
/// connected (there is no device at app start).
pub struct SonyUsbProvider<B: UsbBackend + 'static>(pub Arc<UsbSonyCamera<B>>);

#[async_trait]
impl<B: UsbBackend + 'static> CameraProvider for SonyUsbProvider<B> {
    async fn unavailable_reason(&self) -> Option<String> {
        self.0.unavailable_reason().await
    }

    fn camera(&self) -> Arc<dyn Camera> {
        self.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use photobooth_core::CameraId;
    use sony_ptp::sim::{SimConfig, SimTransport};
    use sony_ptp::SonyConfig;
    use tauri_plugin_photobooth_camera::usb::TransportFactory;
    use tauri_plugin_photobooth_camera::UsbDeviceInfo;

    struct FakeUsb(Mutex<Vec<UsbDeviceInfo>>);

    #[async_trait]
    impl UsbBackend for FakeUsb {
        async fn list(&self) -> Result<Vec<UsbDeviceInfo>, String> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn request_permission(&self, _: &str) -> Result<bool, String> {
            Ok(true)
        }
        async fn open(&self, _: &str) -> Result<i32, String> {
            Ok(3)
        }
        async fn close(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    struct SimFactory;

    impl TransportFactory for SimFactory {
        fn open(&self, _fd: i32) -> sony_ptp::Result<Box<dyn sony_ptp::Transport>> {
            Ok(Box::new(SimTransport::new(SimConfig::default()).0))
        }
    }

    fn sony() -> UsbDeviceInfo {
        UsbDeviceInfo {
            device_name: "/dev/bus/usb/001/002".into(),
            vendor_id: 0x054C,
            product_id: 0x0E73,
            product_name: None,
            has_permission: true,
        }
    }

    #[tokio::test]
    async fn the_provider_follows_the_cable_and_hands_out_the_sony_camera() {
        let usb = Arc::new(FakeUsb(Mutex::new(Vec::new())));
        let camera = Arc::new(UsbSonyCamera::with_config(
            usb.clone(),
            Arc::new(SimFactory),
            SonyConfig::no_delays(),
        ));
        let provider = SonyUsbProvider(camera);

        let reason = provider.unavailable_reason().await.expect("no camera yet");
        assert!(reason.contains("PC Remote"), "{reason}");

        usb.0.lock().unwrap().push(sony());
        assert_eq!(provider.unavailable_reason().await, None);

        let handed_out = provider.camera();
        assert_eq!(handed_out.id(), CameraId::SONY_USB);
        handed_out.connect().await.unwrap();
        assert!(handed_out
            .capture()
            .await
            .unwrap()
            .jpeg
            .starts_with(&[0xFF, 0xD8]));
        handed_out.disconnect().await.unwrap();
    }
}
