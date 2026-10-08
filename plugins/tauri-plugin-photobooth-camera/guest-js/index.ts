// Typed JS API for tauri-plugin-photobooth-camera.
//
// Only window behaviour and plugin events are reachable from the WebView. The camera and USB
// commands are driven from Rust (see src/lib.rs), so the WebView cannot touch the hardware.

import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

const PLUGIN = "photobooth-camera";

/** Keeps the screen on while the booth is open. */
export const windowSetKeepScreenOn = (on: boolean) =>
  invoke<void>(`plugin:${PLUGIN}|window_set_keep_screen_on`, { on });

/** Hides (true) or shows (false) the system bars. */
export const windowSetImmersive = (on: boolean) =>
  invoke<void>(`plugin:${PLUGIN}|window_set_immersive`, { on });

export interface UsbDeviceEvent {
  deviceName: string;
  vendorId: number;
  productId: number;
  productName?: string;
  hasPermission: boolean;
}

/** The hardware back button was pressed (the plugin swallows it instead of closing the app). */
export const onBackPressed = (handler: () => void): Promise<PluginListener> =>
  addPluginListener(PLUGIN, "backPressed", handler);

/** A Sony camera was plugged in. */
export const onUsbAttached = (handler: (device: UsbDeviceEvent) => void): Promise<PluginListener> =>
  addPluginListener(PLUGIN, "usbAttached", handler);

/** A Sony camera was unplugged. */
export const onUsbDetached = (handler: (device: UsbDeviceEvent) => void): Promise<PluginListener> =>
  addPluginListener(PLUGIN, "usbDetached", handler);
