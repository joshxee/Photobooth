// Window behaviour and the hardware back button, provided by the Android plugin
// (`tauri-plugin-photobooth-camera`). On desktop the plugin has no native side, so every
// call here is a harmless no-op.

import { addPluginListener, invoke } from "@tauri-apps/api/core";

const PLUGIN = "photobooth-camera";

async function call(command: string, args?: Record<string, unknown>): Promise<void> {
  try {
    await invoke(`plugin:${PLUGIN}|${command}`, args);
  } catch {
    // Not on Android, or the plugin is not registered: nothing to do.
  }
}

export const setKeepScreenOn = (on: boolean) => call("window_set_keep_screen_on", { on });
export const setImmersive = (on: boolean) => call("window_set_immersive", { on });

/**
 * Calls `handler` when the Android back button is pressed (the plugin swallows the press
 * instead of finishing the activity). Returns an unsubscribe function.
 */
export async function onBackPressed(handler: () => void): Promise<() => void> {
  try {
    const listener = await addPluginListener(PLUGIN, "backPressed", handler);
    return () => void listener.unregister().catch(() => undefined);
  } catch {
    return () => undefined;
  }
}
