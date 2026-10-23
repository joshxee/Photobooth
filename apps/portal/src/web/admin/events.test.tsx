import { afterEach, describe, expect, it } from "bun:test";
import type { AdminEvent } from "../../shared/schemas";
import { button, click, dialog, input, maybeButton, mountApp, settle, submit, text, type, unmountApp } from "./harness";
import { qrSvg } from "./qr";
import { NOW, apiError, device, event, fakeAdminEnv, json, mockFetch } from "./testing";

let mocked: ReturnType<typeof mockFetch> | null = null;
afterEach(async () => {
  await unmountApp();
  mocked?.restore();
  mocked = null;
});

const ID = event().id;

/** A tiny server: events by ID, actions flip the fields the Worker would. */
function server(initial: AdminEvent[], devices = [device()]) {
  const events = new Map(initial.map((e) => [e.id, e]));
  return mockFetch((call) => {
    const [, , resource, id, action] = call.path.split("/");
    if (resource === "devices") return json({ devices });
    if (call.method === "GET" && !id) return json({ events: [...events.values()] });
    if (call.method === "POST" && !id) {
      const body = call.body as Record<string, unknown>;
      const created = event({ id: "019a0b7e-0000-7000-8000-0000000000ff", ...body, photoLimit: (body.photoLimit as number) ?? 2000 });
      events.set(created.id, created);
      return json(created, 201);
    }
    const current = events.get(id!);
    if (!current) return apiError(404, "not_found", "No such event.");
    if (call.method === "GET") return json(current);
    if (call.method === "PATCH") {
      const next = { ...current, ...(call.body as object) };
      events.set(id!, next);
      return json(next);
    }
    const next = { ...current };
    if (action === "open") next.uploadStatus = "OPEN";
    if (action === "close") next.uploadStatus = "CLOSED";
    if (action === "publish") next.galleryStatus = "LIVE";
    if (action === "suspend") next.galleryStatus = "SUSPENDED";
    if (action === "rotate-link") next.galleryUrl = "https://photos.example.invalid/e/abcdefghijklmnop#k=ROTATEDTOKEN";
    if (action === "delete") {
      next.deletedAt = new Date(NOW).toISOString();
      next.purgeAfter = new Date(NOW + 7 * 86_400_000).toISOString();
    }
    if (action === "restore") {
      next.deletedAt = null;
      next.purgeAfter = null;
    }
    events.set(id!, next);
    return json(next);
  });
}

describe("events list", () => {
  it("shows each event with its chips, dates in its own zone and photo counts", async () => {
    mocked = server([
      event({ name: "Smith wedding", uploadStatus: "OPEN", galleryStatus: "LIVE", counts: { pending: 2, ready: 41, rejected: 1, hidden: 3 } }),
      event({ id: "019a0b7e-0000-7000-8000-000000000002", name: "Old party", deletedAt: new Date(NOW).toISOString(), purgeAfter: "2026-10-30T12:00:00.000Z" }),
    ]);
    await mountApp(fakeAdminEnv().env, "/");
    const t = text();
    expect(t).toContain("Smith wedding");
    expect(t).toContain("Uploads open");
    expect(t).toContain("Gallery live");
    expect(t).toContain("24 Oct 2026, 18:00");
    expect(t).toContain("Pacific/Auckland");
    expect(t).toContain("41");
    expect(t).toContain("2 pending · 1 rejected · 3 hidden");
    expect(t).toContain("Deleted");
    expect(t).toContain("purges 31 Oct 2026");
    expect(document.querySelector<HTMLAnchorElement>('a[href="/events/' + ID + '"]')?.textContent).toBe("Smith wedding");
  });

  it("says so when there are no events", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/");
    expect(text()).toContain("No events yet");
  });

  it("shows a readable message when the list can't be loaded", async () => {
    mocked = mockFetch(() => apiError(500, "internal", "Something went wrong."));
    await mountApp(fakeAdminEnv().env, "/");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("reference 11111111");
  });

  it("an unauthorised answer replaces the app with the Not authorised page", async () => {
    mocked = mockFetch(() => apiError(403, "forbidden", "Forbidden."));
    await mountApp(fakeAdminEnv().env, "/");
    expect(document.querySelector("h1")?.textContent).toBe("Not authorised");
    expect(document.querySelector("nav")).toBeNull();
    expect(document.title).toStartWith("Not authorised");
  });

  it("an unknown path is a not-found page, not an error", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/nowhere");
    expect(document.querySelector("h1")?.textContent).toBe("Page not found");
  });
});

describe("create an event", () => {
  const fill = async (over: Record<string, string> = {}) => {
    const values = { "f-name": "Smith wedding", "f-venue": "Town Hall", "f-startsLocal": "2026-12-20T14:30", "f-endsLocal": "2026-12-20T22:00", ...over };
    for (const [id, value] of Object.entries(values)) await type(input(id), value);
  };

  it("sends the local times converted to UTC for the chosen zone, then opens the new event", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/events/new");
    await fill();
    await submit(document.querySelector("form")!);
    const post = mocked.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/events");
    expect(post.body).toEqual({
      name: "Smith wedding",
      venue: "Town Hall",
      timezone: "Pacific/Auckland",
      startsAt: "2026-12-20T01:30:00.000Z",
      endsAt: "2026-12-20T09:00:00.000Z",
      photoLimit: 2000,
    });
    expect(location.pathname).toBe("/events/019a0b7e-0000-7000-8000-0000000000ff");
  });

  it("converts for another zone picked in the form", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/events/new");
    await fill();
    await type(input("f-timezone"), "America/New_York");
    await submit(document.querySelector("form")!);
    expect(mocked.calls.find((c) => c.method === "POST")!.body).toMatchObject({ timezone: "America/New_York", startsAt: "2026-12-20T19:30:00.000Z" });
  });

  it("shows field errors and sends nothing when the form is invalid", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/events/new");
    await fill({ "f-name": "", "f-endsLocal": "2026-12-20T10:00" });
    await submit(document.querySelector("form")!);
    expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(input("f-name").getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("e-name")?.textContent).toContain("Enter a name");
    expect(input("f-name").getAttribute("aria-describedby")).toBe("e-name");
    expect(document.getElementById("e-endsLocal")?.textContent).toContain("after the start");
    expect(location.pathname).toBe("/events/new");
  });

  it("clears a field's error as it is edited", async () => {
    mocked = server([]);
    await mountApp(fakeAdminEnv().env, "/events/new");
    await fill({ "f-name": "" });
    await submit(document.querySelector("form")!);
    await type(input("f-name"), "A");
    expect(document.getElementById("e-name")).toBeNull();
  });

  it("shows the server's refusal and stays on the form", async () => {
    mocked = mockFetch((call) => (call.method === "POST" ? apiError(400, "invalid_request", "The request was not valid.") : json({ events: [] })));
    await mountApp(fakeAdminEnv().env, "/events/new");
    await fill();
    await submit(document.querySelector("form")!);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("check the form");
    expect(location.pathname).toBe("/events/new");
  });
});

describe("edit an event", () => {
  it("fills the form with the event's local times and sends only the change", async () => {
    mocked = server([event()]);
    await mountApp(fakeAdminEnv().env, `/events/${ID}/edit`);
    expect(input("f-startsLocal").value).toBe("2026-10-24T18:00");
    await type(input("f-name"), "Smith-Jones wedding");
    await submit(document.querySelector("form")!);
    const patch = mocked.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe(`/api/events/${ID}`);
    expect(patch.body).toEqual({ name: "Smith-Jones wedding" });
    expect(location.pathname).toBe(`/events/${ID}`);
  });

  it("says nothing changed instead of sending an empty edit", async () => {
    mocked = server([event()]);
    await mountApp(fakeAdminEnv().env, `/events/${ID}/edit`);
    await submit(document.querySelector("form")!);
    expect(mocked.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(text()).toContain("Nothing has changed");
  });

  it("explains a stale edit (409) in the server's words", async () => {
    mocked = mockFetch((c) =>
      c.method === "PATCH" ? apiError(409, "conflict", "The event changed meanwhile; reload and try again.") : json(event()),
    );
    await mountApp(fakeAdminEnv().env, `/events/${ID}/edit`);
    await type(input("f-name"), "Other");
    await submit(document.querySelector("form")!);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The event changed meanwhile; reload and try again.");
  });

  it("won't edit a deleted event", async () => {
    mocked = server([event({ deletedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 86_400_000).toISOString() })]);
    await mountApp(fakeAdminEnv().env, `/events/${ID}/edit`);
    expect(document.querySelector("form")).toBeNull();
    expect(text()).toContain("can only be restored");
  });
});

describe("event detail", () => {
  it("shows the details, counts, the date uploads close and offers only valid actions", async () => {
    mocked = server([event({ counts: { pending: 1, ready: 7, rejected: 0, hidden: 2 } })]);
    await mountApp(fakeAdminEnv().env, `/events/${ID}`);
    const t = text();
    expect(t).toContain("Smith wedding");
    expect(t).toContain("Town Hall");
    expect(t).toContain("Uploads close on");
    expect(t).toContain("23 Jan 2027");
    expect(t).toContain("7 in the gallery · 1 pending · 0 rejected · 2 hidden");
    const actions = [...document.querySelectorAll('[aria-label="Event actions"] button')].map((b) => b.textContent);
    expect(actions).toEqual(["Open uploads", "Publish gallery", "Rotate link", "Delete event"]);
  });

  it("open and publish go straight through; the buttons then change", async () => {
    mocked = server([event()]);
    await mountApp(fakeAdminEnv().env, `/events/${ID}`);
    await click(button("Open uploads"));
    await click(button("Publish gallery"));
    expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/open`, `/api/events/${ID}/publish`]);
    expect(mocked.calls.filter((c) => c.method === "POST").every((c) => JSON.stringify(c.body) === "{}")).toBe(true);
    const actions = [...document.querySelectorAll('[aria-label="Event actions"] button')].map((b) => b.textContent);
    expect(actions).toEqual(["Close uploads", "Suspend gallery", "Rotate link", "Delete event"]);
    expect(text()).toContain("Uploads open");
    expect(text()).toContain("Gallery live");
  });

  describe("confirmations", () => {
    it("rotating asks first, warns about printed signage, and does nothing on Cancel", async () => {
      mocked = server([event({ galleryStatus: "LIVE" })]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Rotate link"));
      expect(dialog()?.textContent).toContain("Printed signage must be reprinted");
      expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      await click(button("Cancel", dialog()!));
      expect(dialog()).toBeNull();
      expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("rotating on Confirm posts once and the QR switches to the new link", async () => {
      mocked = server([event({ galleryStatus: "LIVE" })]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      const before = document.querySelector(".qr__code")!.innerHTML;
      await click(button("Rotate link"));
      await click(button("Rotate link", dialog()!));
      expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/rotate-link`]);
      expect(dialog()).toBeNull();
      expect(document.querySelector(".qr__code")!.innerHTML).not.toBe(before);
      expect(input("gallery-link").value).toContain("#k=ROTATEDTOKEN");
    });

    it("delete asks first and names the 7-day window", async () => {
      mocked = server([event()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Delete event"));
      expect(dialog()?.textContent).toContain("7 days");
      await click(button("Cancel", dialog()!));
      expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      await click(button("Delete event"));
      await click(button("Delete event", dialog()!));
      expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/delete`]);
    });

    it("suspending asks first and says it is a pause", async () => {
      mocked = server([event({ galleryStatus: "LIVE" })]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Suspend gallery"));
      expect(dialog()?.textContent).toContain("same link");
      expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      await click(button("Suspend gallery", dialog()!));
      expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/suspend`]);
    });

    it("Escape cancels, the dialog opens on Cancel, and focus returns to the button", async () => {
      mocked = server([event()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      const opener = button("Delete event");
      opener.focus();
      await click(opener);
      expect(document.activeElement?.textContent).toBe("Cancel");
      await settle(() => void dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(opener);
    });

    it("Tab stays inside the dialog", async () => {
      mocked = server([event()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Delete event"));
      const last = button("Delete event", dialog()!);
      last.focus();
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      await settle(() => void last.dispatchEvent(tab));
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement?.textContent).toBe("Cancel");
    });

    it("a 409 from a confirmed action stays in the dialog with a readable message", async () => {
      mocked = mockFetch((c) =>
        c.method === "POST" ? apiError(409, "conflict", "That change isn't allowed in the event's current state.") : json(event()),
      );
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Delete event"));
      await click(button("Delete event", dialog()!));
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("That change isn't allowed in the event's current state.");
    });
  });

  describe("closing uploads", () => {
    const open = () => event({ uploadStatus: "OPEN", galleryStatus: "LIVE" });

    it("reads the booths' queues as they are now and warns for each booth with queued items", async () => {
      const env = fakeAdminEnv();
      mocked = server([open()], [
        device({ name: "Booth A", lastBacklog: 12, lastSeenAt: new Date(NOW - 60_000).toISOString() }),
        device({ id: "d2", name: "Booth B", lastBacklog: 0, lastSeenAt: new Date(NOW - 30_000).toISOString() }),
      ]);
      await mountApp(env.env, `/events/${ID}`);
      expect(mocked.calls.filter((c) => c.path === "/api/devices")).toHaveLength(0);
      await click(button("Close uploads"));
      expect(mocked.calls.filter((c) => c.path === "/api/devices")).toHaveLength(1);
      const d = dialog()!;
      expect(d.textContent).toContain("1 booth still has photos waiting to upload");
      expect(d.textContent).toContain("Booth A: 12 waiting to upload (last seen 1 min ago)");
      expect(d.textContent).not.toContain("Booth B");
      expect(maybeButton("Close uploads anyway", d)).not.toBeNull();
      expect(mocked.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });

    it("closes on Confirm", async () => {
      mocked = server([open()], [device()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Close uploads"));
      expect(dialog()?.querySelector(".warning")).toBeNull();
      await click(button("Close uploads", dialog()!));
      expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/close`]);
      expect(text()).toContain("Uploads closed");
    });

    it("still asks, and says the queues couldn't be checked, when the devices list fails", async () => {
      mocked = mockFetch((c) => (c.path === "/api/devices" ? apiError(500, "internal", "x") : json(open())));
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Close uploads"));
      expect(dialog()?.textContent).toContain("couldn't check the booths' queues");
    });
  });

  describe("event QR", () => {
    it("draws the whole-event link and offers copy, SVG and PNG", async () => {
      const env = fakeAdminEnv();
      const e = event({ galleryStatus: "LIVE" });
      mocked = server([e]);
      await mountApp(env.env, `/events/${ID}`);
      const expected = document.createElement("div");
      expected.innerHTML = qrSvg(e.galleryUrl);
      expect(document.querySelector(".qr__code")!.innerHTML).toBe(expected.innerHTML);
      expect(input("gallery-link").value).toBe(e.galleryUrl);
      expect(e.galleryUrl).not.toContain("&s=");

      await click(button("Copy link"));
      expect(env.copied).toEqual([e.galleryUrl]);
      expect(text()).toContain("Link copied");

      await click(button("Download SVG"));
      expect(env.saved[0]!.filename).toBe("smith-wedding-gallery-qr.svg");
      expect(await env.saved[0]!.blob.text()).toBe(qrSvg(e.galleryUrl));

      await click(button("Download PNG"));
      expect(env.saved[1]!.filename).toBe("smith-wedding-gallery-qr.png");
      expect(await env.saved[1]!.blob.text()).toBe(`png:${e.galleryUrl}`);
    });

    it("says so when the browser can't copy or make a PNG", async () => {
      const env = fakeAdminEnv();
      env.env.copyText = async () => {
        throw new Error("denied");
      };
      env.env.png = async () => {
        throw new Error("no canvas");
      };
      mocked = server([event()]);
      await mountApp(env.env, `/events/${ID}`);
      await click(button("Copy link"));
      expect(text()).toContain("Couldn't copy");
      await click(button("Download PNG"));
      expect(text()).toContain("Download the SVG instead");
      expect(env.saved).toHaveLength(0);
    });

    it("warns that a link that isn't live shows guests 'unavailable'", async () => {
      mocked = server([event({ galleryStatus: "HIDDEN" })]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      expect(text()).toContain("until you publish");
    });
  });

  describe("deleted event", () => {
    const deleted = () => event({ deletedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 7 * 86_400_000).toISOString() });

    it("shows the purge date and offers only Restore, with no QR", async () => {
      mocked = server([deleted()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      expect(text()).toContain("Purges on");
      expect(text()).toContain("31 Oct 2026");
      expect([...document.querySelectorAll('[aria-label="Event actions"] button')].map((b) => b.textContent)).toEqual(["Restore event"]);
      expect(document.querySelector(".qr")).toBeNull();
    });

    it("restores without a confirmation", async () => {
      mocked = server([deleted()]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      await click(button("Restore event"));
      expect(mocked.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/api/events/${ID}/restore`]);
      expect(text()).not.toContain("This event is deleted");
    });

    it("offers nothing once the purge date has passed", async () => {
      mocked = server([event({ deletedAt: "2026-10-01T00:00:00.000Z", purgeAfter: "2026-10-08T00:00:00.000Z" })]);
      await mountApp(fakeAdminEnv().env, `/events/${ID}`);
      expect(document.querySelectorAll('[aria-label="Event actions"] button')).toHaveLength(0);
    });
  });

  it("an event that doesn't exist shows a readable message", async () => {
    mocked = mockFetch(() => apiError(404, "not_found", "No such event."));
    await mountApp(fakeAdminEnv().env, `/events/${ID}`);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("no longer exists");
  });
});
