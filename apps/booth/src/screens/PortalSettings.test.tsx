import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import type { PortalStatus } from "../ipc/types";
import { resetBooth, useBooth } from "../store/store";
import {
  enrolledStatus,
  flush,
  installBackend,
  portalEvents,
  portalStatus,
  removeBackend,
  SMITH,
  until,
} from "../test/ipc";
import { PortalSettings } from "./PortalSettings";

beforeEach(resetBooth);
afterEach(removeBackend);

function mount(status: PortalStatus | null) {
  act(() => {
    useBooth.setState({ portal: status });
  });
  return render(<PortalSettings />);
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name });

describe("PortalSettings: enrolment", () => {
  test("says it is checking until the status arrives", () => {
    installBackend();
    mount(null);
    expect(screen.getByText("Checking the portal…")).toBeTruthy();
  });

  test("an unenrolled booth shows the form, starting at the build's portal", () => {
    installBackend();
    mount(portalStatus());
    expect(screen.getByText("Not enrolled")).toBeTruthy();
    expect(input("Portal address").value).toBe("http://photos.localhost:8787");
    expect(input("Enrolment code").value).toBe("");
    expect(input("Booth name").value).toBe("");
    expect((button("Enrol booth") as HTMLButtonElement).disabled).toBe(true);
  });

  test("enrolling sends the three fields and shows the result", async () => {
    const backend = installBackend({ portal_enrol: () => enrolledStatus() });
    mount(portalStatus());
    fireEvent.change(input("Portal address"), {
      target: { value: "https://photos.example.invalid" },
    });
    fireEvent.change(input("Enrolment code"), { target: { value: "7K3M9Q2Z" } });
    fireEvent.change(input("Booth name"), { target: { value: "Booth 1" } });
    fireEvent.click(button("Enrol booth"));
    await until(() => backend.callsTo("portal_enrol").length === 1, "portal_enrol");
    expect(backend.callsTo("portal_enrol")[0]?.args).toEqual({
      url: "https://photos.example.invalid",
      code: "7K3M9Q2Z",
      name: "Booth 1",
    });
    await until(() => useBooth.getState().portal?.enrolled === true, "store updated");
    expect(screen.getByText("Booth 1")).toBeTruthy();
    expect(screen.getByText("photos.example.invalid")).toBeTruthy();
  });

  test("a refused code becomes a notice and the form stays", async () => {
    installBackend({
      portal_enrol: () => {
        throw "That enrolment code isn't valid.";
      },
    });
    mount(portalStatus());
    fireEvent.change(input("Enrolment code"), { target: { value: "WRONG" } });
    fireEvent.change(input("Booth name"), { target: { value: "Booth 1" } });
    fireEvent.click(button("Enrol booth"));
    await until(() => useBooth.getState().notice !== null, "notice");
    expect(useBooth.getState().notice).toContain("isn't valid");
    expect(input("Enrolment code").value).toBe("WRONG");
    expect((button("Enrol booth") as HTMLButtonElement).disabled).toBe(false);
  });

  test("a damaged enrolment is shown with a way out", async () => {
    const backend = installBackend({ portal_unenrol: () => portalStatus() });
    mount(portalStatus({ problem: "The portal enrolment on this booth is damaged." }));
    expect(screen.getByRole("alert").textContent).toContain("damaged");
    fireEvent.click(button("Remove enrolment"));
    await until(() => backend.callsTo("portal_unenrol").length === 1, "unenrol");
  });
});

describe("PortalSettings: enrolled", () => {
  test("shows the device, the portal and that no event is selected", () => {
    installBackend();
    mount(enrolledStatus());
    expect(screen.getByText("Booth 1")).toBeTruthy();
    expect(screen.getByText("photos.example.invalid")).toBeTruthy();
    expect(screen.getByText("No event selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear event" })).toBeNull();
  });

  test("choosing an event asks for confirmation, then selects it", async () => {
    const backend = installBackend({
      portal_events: () => portalEvents(),
      portal_select_event: () => enrolledStatus({ selected_event: SMITH }),
    });
    mount(enrolledStatus());
    fireEvent.click(button("Choose event"));
    await until(() => screen.queryByText("Ng 40th") !== null, "events listed");
    fireEvent.click(button(/^Smith wedding/));

    expect(screen.getByRole("heading", { name: "Use this event?" })).toBeTruthy();
    expect(screen.getByText("Smith wedding")).toBeTruthy();
    expect(screen.getByText("Thu 22 Oct 2026")).toBeTruthy();
    expect(
      screen.getByText("Photos from this booth will appear in this event's gallery."),
    ).toBeTruthy();
    expect(backend.callsTo("portal_select_event")).toHaveLength(0);

    fireEvent.click(button("Use this event"));
    await until(() => backend.callsTo("portal_select_event").length === 1, "selected");
    expect(backend.callsTo("portal_select_event")[0]?.args).toEqual({ id: SMITH.id });
    await until(() => useBooth.getState().portal?.selected_event?.id === SMITH.id, "store");
    expect(screen.getByText("Smith wedding · Thu 22 Oct 2026")).toBeTruthy();
  });

  test("cancelling the confirmation selects nothing", async () => {
    const backend = installBackend({ portal_events: () => portalEvents() });
    mount(enrolledStatus());
    fireEvent.click(button("Choose event"));
    await until(() => screen.queryByText("Ng 40th") !== null, "events listed");
    fireEvent.click(button(/^Ng 40th/));
    fireEvent.click(button("Cancel"));
    await flush();
    expect(backend.callsTo("portal_select_event")).toHaveLength(0);
    expect(screen.getByText("No event selected")).toBeTruthy();
  });

  test("switching from a selected event says what it replaces", async () => {
    installBackend({ portal_events: () => portalEvents() });
    mount(enrolledStatus({ selected_event: SMITH }));
    fireEvent.click(button("Change event"));
    await until(() => screen.queryByText("Ng 40th") !== null, "events listed");
    fireEvent.click(button(/^Ng 40th/));
    expect(screen.getByRole("heading", { name: "Switch event?" })).toBeTruthy();
    expect(screen.getByText("Now: Smith wedding · Thu 22 Oct 2026")).toBeTruthy();
    expect(
      screen.getByText("Photos already taken stay with the event they were taken for."),
    ).toBeTruthy();
    expect(button("Switch to this event")).toBeTruthy();
  });

  test("no open events says where to open one", async () => {
    installBackend({ portal_events: () => [] });
    mount(enrolledStatus());
    fireEvent.click(button("Choose event"));
    await until(
      () => screen.queryByText("No events are open for uploads. Open one in the admin portal.") !== null,
      "empty message",
    );
    fireEvent.click(button("Back to portal"));
    expect(screen.getByText("No event selected")).toBeTruthy();
  });

  test("a failed event list becomes a notice", async () => {
    installBackend({
      portal_events: () => {
        throw "Can't reach the portal (timed out).";
      },
    });
    mount(enrolledStatus());
    fireEvent.click(button("Choose event"));
    await until(() => useBooth.getState().notice !== null, "notice");
    expect(useBooth.getState().notice).toContain("Can't reach the portal");
    expect(screen.getByText("No event selected")).toBeTruthy();
  });

  test("clearing the event needs a confirmation, since it stops uploads", async () => {
    const backend = installBackend({ portal_clear_event: () => enrolledStatus() });
    mount(enrolledStatus({ selected_event: SMITH }));
    fireEvent.click(button("Clear event"));
    expect(
      screen.getByRole("heading", { name: "Stop sending photos to Smith wedding?" }),
    ).toBeTruthy();
    fireEvent.click(button("Cancel"));
    await flush();
    expect(backend.callsTo("portal_clear_event")).toHaveLength(0);

    fireEvent.click(button("Clear event"));
    fireEvent.click(button("Stop sending photos"));
    await until(() => backend.callsTo("portal_clear_event").length === 1, "cleared");
    await until(() => useBooth.getState().portal?.selected_event === null, "store");
  });

  test("unenrolling needs a confirmation", async () => {
    const backend = installBackend({ portal_unenrol: () => portalStatus() });
    mount(enrolledStatus({ selected_event: SMITH }));
    fireEvent.click(button("Unenrol booth"));
    expect(screen.getByRole("heading", { name: "Unenrol this booth?" })).toBeTruthy();
    fireEvent.click(button("Cancel"));
    await flush();
    expect(backend.callsTo("portal_unenrol")).toHaveLength(0);

    fireEvent.click(button("Unenrol booth"));
    fireEvent.click(button("Unenrol"));
    await until(() => backend.callsTo("portal_unenrol").length === 1, "unenrolled");
    await until(() => useBooth.getState().portal?.enrolled === false, "store");
    expect(screen.getByText("Not enrolled")).toBeTruthy();
  });
});
