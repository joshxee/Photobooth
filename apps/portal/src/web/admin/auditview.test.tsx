import { afterEach, describe, expect, it } from "bun:test";
import type { AuditEntry } from "../../shared/schemas";
import { AUDIT_ACTIONS } from "../../shared/schemas";
import { button, click, maybeButton, mountApp, text, type, unmountApp } from "./harness";
import { apiError, auditEntry, device, event, fakeAdminEnv, json, mockFetch } from "./testing";

let mocked: ReturnType<typeof mockFetch> | null = null;
afterEach(async () => {
  await unmountApp();
  mocked?.restore();
  mocked = null;
});

const E = event();
const OTHER = event({ id: "019a0b7e-0000-7000-8000-000000000002", name: "Old party" });
const PAGE = 50;

/** Events and devices for the names and the filter; the audit list is filtered and paged like the Worker's. */
function server(entries: AuditEntry[], fail?: Response) {
  return mockFetch((call) => {
    const url = new URL(call.path, "http://admin.localhost");
    if (url.pathname === "/api/events") return json({ events: [E, OTHER] });
    if (url.pathname === "/api/devices") return json({ devices: [device()] });
    if (url.pathname === "/api/audit") {
      if (fail) return fail;
      const ev = url.searchParams.get("event");
      const action = url.searchParams.get("action");
      const cursor = url.searchParams.get("cursor");
      let list = entries.filter((e) => (ev ? e.eventId === ev : true) && (action ? e.action === action : true));
      if (cursor) list = list.slice(list.findIndex((e) => e.id === cursor) + 1);
      const page = list.slice(0, PAGE);
      return json({ entries: page, nextCursor: list.length > PAGE ? page.at(-1)!.id : null });
    }
    return apiError(404, "not_found", "Not found.");
  });
}

const auditCalls = () => mocked!.calls.filter((c) => c.path.startsWith("/api/audit"));
const rows = () => [...document.querySelectorAll("tbody tr")];
const view = (path = "/audit") => mountApp(fakeAdminEnv().env, path);

describe("the Audit view", () => {
  it("lists time (in the admin's zone), who, what, the target and the detail, newest first", async () => {
    mocked = server([
      auditEntry({ at: "2026-10-24T06:41:00.000Z", action: "photo.delete", targetId: "p1", detail: { sessionId: "s-1", shot: 2, state: "READY", hidden: false } }),
      auditEntry({ at: "2026-10-24T06:40:00.000Z", action: "event.update", detail: { fields: ["name", "venue"] } }),
      auditEntry({ at: "2026-10-23T01:00:00.000Z", action: "audit.prune", actor: "system", eventId: null, targetId: null, detail: { rows: 12, olderThan: "2026-07-25T00:00:00.000Z" } }),
    ]);
    await view();
    const r = rows().map((tr) => tr.textContent);
    expect(r[0]).toContain("24 Oct 2026, 19:41");
    expect(r[0]).toContain("josh@knockbox.nz");
    expect(r[0]).toContain("Deleted a photo permanently");
    expect(r[0]).toContain("Photo: session s-1, shot 2 in Smith wedding");
    expect(r[0]).toContain("Was READY");
    expect(r[1]).toContain("Edited an event");
    expect(r[1]).toContain("Changed name, venue");
    expect(r[2]).toContain("System (daily job)");
    expect(r[2]).toContain("12 entries older than 25 Jul 2026");
    expect(text()).toContain("Times are shown in Pacific/Auckland");
    expect(rows()[1]!.querySelector<HTMLAnchorElement>('a[href^="/events/"]')?.getAttribute("href")).toBe(`/events/${E.id}`);
  });

  it("filters by event and by action through the API, and starts from ?event= in the address", async () => {
    mocked = server([
      auditEntry({ action: "photo.hide", eventId: E.id, detail: { sessionId: "s", shot: 1, state: "READY" } }),
      auditEntry({ action: "event.publish", eventId: OTHER.id, targetId: OTHER.id }),
    ]);
    await view(`/audit?event=${OTHER.id}`);
    expect(auditCalls()[0]!.path).toBe(`/api/audit?event=${OTHER.id}`);
    expect((document.getElementById("audit-event") as HTMLSelectElement).value).toBe(OTHER.id);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Published the gallery");

    await type(document.getElementById("audit-event") as HTMLSelectElement, "");
    expect(auditCalls().at(-1)!.path).toBe("/api/audit");
    expect(rows()).toHaveLength(2);

    await type(document.getElementById("audit-action") as HTMLSelectElement, "photo.hide");
    expect(auditCalls().at(-1)!.path).toBe("/api/audit?action=photo.hide");
    expect(rows()).toHaveLength(1);
    await type(document.getElementById("audit-event") as HTMLSelectElement, OTHER.id);
    expect(auditCalls().at(-1)!.path).toBe(`/api/audit?event=${OTHER.id}&action=photo.hide`);
    expect(text()).toContain("No audit entries match");
  });

  it("offers every action the Worker can write, grouped, and an ignored bad ?event= falls back to all events", async () => {
    mocked = server([auditEntry()]);
    await view("/audit?event=nope");
    expect(auditCalls()[0]!.path).toBe("/api/audit");
    const options = [...document.querySelectorAll("#audit-action option")].map((o) => (o as HTMLOptionElement).value).filter(Boolean);
    expect(options.sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect([...document.querySelectorAll("#audit-action optgroup")].map((g) => g.getAttribute("label"))).toEqual(["Events", "Photos", "Booths", "Housekeeping"]);
    const events = [...document.querySelectorAll("#audit-event option")].map((o) => o.textContent);
    expect(events).toEqual(["All events", "Smith wedding", "Old party"]);
  });

  it("pages with Load more", async () => {
    const all = Array.from({ length: 55 }, (_, i) => auditEntry({ at: `2026-10-24T06:${String(59 - (i % 60)).padStart(2, "0")}:00.000Z` }));
    mocked = server(all);
    await view();
    expect(rows()).toHaveLength(PAGE);
    await click(button("Load more"));
    expect(auditCalls().at(-1)!.path).toBe(`/api/audit?cursor=${all[PAGE - 1]!.id}`);
    expect(rows()).toHaveLength(55);
    expect(maybeButton("Load more")).toBeNull();
  });

  it("names a booth from the device list and says when nothing has been recorded", async () => {
    const d = device();
    mocked = server([auditEntry({ action: "device.enrol", actor: `device:${d.id}`, eventId: null, targetId: d.id })]);
    await view();
    expect(rows()[0]!.textContent).toContain("Booth A");
    mocked.restore();
    await unmountApp();
    mocked = server([]);
    await view();
    expect(text()).toContain("No audit entries yet");
  });

  it("shows a readable message when the log can't be loaded", async () => {
    mocked = server([], apiError(500, "internal", "x"));
    await view();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("reference 11111111");
  });

  it("the main navigation marks Audit as current", async () => {
    mocked = server([]);
    await view();
    expect(document.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.textContent).toBe("Audit");
  });
});
