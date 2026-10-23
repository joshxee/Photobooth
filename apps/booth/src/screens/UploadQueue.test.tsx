import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import type { OutboxEntry, OutboxStatus } from "../ipc/types";
import { resetBooth, useBooth } from "../store/store";
import {
  enrolledStatus,
  flush,
  installBackend,
  outboxStatus,
  removeBackend,
  SMITH,
  stoppedUpload,
  until,
} from "../test/ipc";
import { UploadQueue } from "./UploadQueue";

beforeEach(() => {
  resetBooth();
  useBooth.setState({ portal: enrolledStatus({ selected_event: SMITH }) });
});
afterEach(removeBackend);

async function mount(status: OutboxStatus | null, entries: OutboxEntry[] = []) {
  const backend = installBackend({ outbox_items: () => entries });
  act(() => {
    useBooth.setState({ outbox: status });
  });
  const result = render(<UploadQueue />);
  await act(async () => {
    await flush();
  });
  return { backend, ...result };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("UploadQueue", () => {
  test("shows the counts and free space", async () => {
    await mount(outboxStatus({ queued: 3, uploading: 1 }));
    expect(screen.getByRole("group", { name: "Upload Queue" })).toBeTruthy();
    expect(screen.getByText("Queued 3 · Uploading 1 · Needs attention 0")).toBeTruthy();
    expect(screen.getByText("Free storage: 52.0 GB")).toBeTruthy();
    expect(screen.getByText("Nothing needs attention.")).toBeTruthy();
  });

  test("warns about low storage, a refused booth and being offline", async () => {
    await mount(
      outboxStatus({ queued: 2, low_disk: true, free_bytes: 812_000_000, revoked: true }),
    );
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts.some((t) => t?.includes("Storage is low: 812 MB free"))).toBe(true);
    expect(alerts.some((t) => t?.includes("The portal refused this booth"))).toBe(true);

    await act(async () => {
      useBooth.setState({ outbox: outboxStatus({ queued: 2, offline: true }) });
      await flush();
    });
    expect(screen.getByText(/Offline: photos wait here/)).toBeTruthy();
  });

  test("lists what needs attention with its reason", async () => {
    const { backend } = await mount(outboxStatus({ needs_attention: 2 }), [
      stoppedUpload(),
      stoppedUpload({
        id: "notice-1",
        kind: "not_queued",
        reason: "Couldn't prepare this shot for upload (bad JPEG).",
        session_id: "6a3f1c20-4",
        shot: 1,
        captured_at: null,
        event_id: null,
        can_retry: false,
      }),
    ]);
    expect(backend.callsTo("outbox_items")).toHaveLength(1);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Session 6a3f1c20-3 · shot 2")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("event_closed (409)")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("the list reloads when the status changes", async () => {
    const { backend } = await mount(outboxStatus({ needs_attention: 1 }), [stoppedUpload()]);
    backend.on("outbox_items", () => []);
    await act(async () => {
      useBooth.setState({ outbox: outboxStatus() });
      await flush();
    });
    await until(() => screen.queryAllByRole("listitem").length === 0, "emptied");
    expect(backend.callsTo("outbox_items")).toHaveLength(2);
  });

  test("retry sends the ID", async () => {
    const { backend } = await mount(outboxStatus({ needs_attention: 1 }), [stoppedUpload()]);
    fireEvent.click(button("Retry"));
    await until(() => backend.callsTo("outbox_retry").length === 1, "outbox_retry");
    expect(backend.callsTo("outbox_retry")[0]?.args).toEqual({ id: stoppedUpload().id });
  });

  test("deleting the booth's copy needs a confirmation", async () => {
    const { backend } = await mount(outboxStatus({ needs_attention: 1 }), [stoppedUpload()]);
    fireEvent.click(button("Delete…"));
    expect(screen.getByRole("heading", { name: "Delete this photo from the booth?" })).toBeTruthy();
    expect(screen.getByText(/SD card still has the original/)).toBeTruthy();
    expect(backend.callsTo("outbox_dismiss")).toHaveLength(0);

    fireEvent.click(button("Cancel"));
    expect(backend.callsTo("outbox_dismiss")).toHaveLength(0);
    fireEvent.click(button("Delete…"));
    fireEvent.click(button("Delete from booth"));
    await until(() => backend.callsTo("outbox_dismiss").length === 1, "outbox_dismiss");
    expect(backend.callsTo("outbox_dismiss")[0]?.args).toEqual({ id: stoppedUpload().id });
  });

  test("a notice about a shot that was never queued is just dismissed", async () => {
    const notice = stoppedUpload({ id: "notice-1", kind: "not_queued", can_retry: false });
    const { backend } = await mount(outboxStatus({ needs_attention: 1 }), [notice]);
    fireEvent.click(button("Dismiss"));
    await until(() => backend.callsTo("outbox_dismiss").length === 1, "outbox_dismiss");
    expect(backend.callsTo("outbox_dismiss")[0]?.args).toEqual({ id: "notice-1" });
  });

  test("a refused action becomes a notice", async () => {
    const { backend } = await mount(outboxStatus({ needs_attention: 1 }), [stoppedUpload()]);
    backend.on("outbox_retry", () => {
      throw "That photo is no longer in the queue.";
    });
    fireEvent.click(button("Retry"));
    await until(() => useBooth.getState().notice !== null, "notice");
    expect(useBooth.getState().notice).toBe("That photo is no longer in the queue.");
  });

  test("an outbox that couldn't open says so and lists nothing", async () => {
    const { backend } = await mount(outboxStatus({ available: false }));
    expect(screen.getByRole("alert").textContent).toContain("can't queue photos");
    expect(backend.callsTo("outbox_items")).toHaveLength(0);
  });
});
