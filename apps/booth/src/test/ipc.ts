// Helpers for tests that talk to the "backend" through Tauri's IPC mock.

import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { waitFor } from "@testing-library/react";

import type { CameraInfo, Settings } from "../ipc/types";

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => unknown;

export interface FakeBackend {
  calls: Call[];
  /** Calls to `cmd` so far. */
  callsTo(cmd: string): Call[];
  /** Replace or add a command handler. */
  on(cmd: string, handler: Handler): void;
  /** Emit a backend event to the WebView. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Channels handed to `live_view_start` or plugin listener registration. */
  channels: Record<string, { onmessage: (data: unknown) => void }[]>;
}

export const defaultSettings = (over: Partial<Settings> = {}): Settings => ({
  selected_camera: "test",
  number_of_photos: 3,
  countdown_seconds: 3,
  strip_display_seconds: 12,
  headline: "Sarah & Tom's Wedding",
  event_date: "06.05.2026",
  mirror_preview: true,
  start_trigger: "tap",
  test_mode: { capture_delay_ms: 300, fail_every_n: 0, pattern: "bars" },
  ...over,
});

export const cameras = (over: Partial<Record<string, Partial<CameraInfo>>> = {}): CameraInfo[] => [
  {
    id: "device",
    name: "Device Camera",
    available: false,
    reason: "Only available on the Android tablet",
    preview: "native",
    status: { state: "disconnected" },
    selected: false,
    ...over.device,
  },
  {
    id: "sony_usb",
    name: "Sony A7 III (USB)",
    available: false,
    reason: "Only available on the Android tablet",
    preview: "channel",
    status: { state: "disconnected" },
    selected: false,
    ...over.sony_usb,
  },
  {
    id: "test",
    name: "Test Camera",
    available: true,
    reason: null,
    preview: "channel",
    status: { state: "ready" },
    selected: true,
    ...over.test,
  },
];

/**
 * Installs a fake backend. Unlisted commands resolve to `undefined`; anything that should
 * fail must say so explicitly through a handler that throws.
 */
export function installBackend(handlers: Record<string, Handler> = {}): FakeBackend {
  const calls: Call[] = [];
  const table: Record<string, Handler> = { ...handlers };
  const channels: FakeBackend["channels"] = {};

  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      const channel = args.channel ?? args.handler;
      if (channel && typeof channel === "object" && "onmessage" in channel) {
        (channels[cmd] ??= []).push(channel as { onmessage: (data: unknown) => void });
      }
      const handler = table[cmd];
      return handler ? handler(args) : undefined;
    },
    { shouldMockEvents: true },
  );

  return {
    calls,
    callsTo: (cmd) => calls.filter((c) => c.cmd === cmd),
    on: (cmd, handler) => {
      table[cmd] = handler;
    },
    emit: (event, payload) => emit(event, payload),
    channels,
  };
}

export function removeBackend(): void {
  clearMocks();
}

/** Lets pending promise callbacks run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Polls until `check()` is true. Built on Testing Library's `waitFor`, which runs its polling
 * outside React's act() environment, so state updates caused by backend replies do not
 * produce "not wrapped in act" warnings.
 */
export async function until(check: () => boolean, label = "condition", timeoutMs = 1000) {
  await waitFor(
    () => {
      if (!check()) throw new Error(`timed out waiting for ${label}`);
    },
    { timeout: timeoutMs, interval: 5 },
  );
}
