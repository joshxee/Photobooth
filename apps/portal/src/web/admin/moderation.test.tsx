import { afterEach, describe, expect, it } from "bun:test";
import type { AdminEvent, AdminPhoto } from "../../shared/schemas";
import { button, click, dialog, maybeButton, mountApp, settle, text, type, unmountApp } from "./harness";
import { NOW, apiError, event, fakeAdminEnv, json, mockFetch, photo } from "./testing";

let mocked: ReturnType<typeof mockFetch> | null = null;
afterEach(async () => {
  await unmountApp();
  mocked?.restore();
  mocked = null;
});

const EVENT_ID = event().id;
const PAGE = 60;

/** A tiny server for one event: its photos newest first, paged by an opaque cursor (the photo ID before the page). */
function server(initial: AdminPhoto[], over: Partial<AdminEvent> = {}, fail: Record<string, Response> = {}) {
  let photos = [...initial];
  const counts = () => ({
    pending: photos.filter((p) => p.state === "PENDING").length,
    ready: photos.filter((p) => p.state === "READY").length,
    rejected: photos.filter((p) => p.state === "REJECTED").length,
    hidden: photos.filter((p) => p.hidden).length,
  });
  return mockFetch((call) => {
    const url = new URL(call.path, "http://admin.localhost");
    const key = `${call.method} ${url.pathname}`;
    if (fail[key]) return fail[key]!;
    if (url.pathname === `/api/events/${EVENT_ID}`) return json(event({ ...over, counts: counts() }));
    if (url.pathname === `/api/events/${EVENT_ID}/photos`) {
      const state = url.searchParams.get("state");
      const hidden = url.searchParams.get("hidden");
      const cursor = url.searchParams.get("cursor");
      let list = photos.filter((p) => (state ? p.state === state : true) && (hidden ? p.hidden === (hidden === "true") : true));
      if (cursor) list = list.slice(list.findIndex((p) => p.id === cursor) + 1);
      const page = list.slice(0, PAGE);
      return json({ photos: page, nextCursor: list.length > PAGE ? page.at(-1)!.id : null });
    }
    const [, , , id, action] = url.pathname.split("/");
    const current = photos.find((p) => p.id === id);
    if (!current) return apiError(404, "not_found", "No such photo.");
    if (call.method === "DELETE") {
      photos = photos.filter((p) => p.id !== id);
      return json({ id });
    }
    if (action === "hide" || action === "unhide") {
      const next = { ...current, hidden: action === "hide" };
      photos = photos.map((p) => (p.id === id ? next : p));
      return json(next);
    }
    return apiError(404, "not_found", "Not found.");
  });
}

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("[data-photo]")];
const photoCalls = () => mocked!.calls.filter((c) => c.path.startsWith(`/api/events/${EVENT_ID}/photos`));
const mutations = () => mocked!.calls.filter((c) => c.method !== "GET");
const open = (n: number) => click(tiles()[n]!);
const press = (el: Element, key: string) => settle(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const view = (path = `/events/${EVENT_ID}/photos`) => mountApp(fakeAdminEnv().env, path);

describe("the Photos tab", () => {
  it("shows the event's tabs, a tile per photo with its preview from the admin proxy, and the state chips", async () => {
    const ready = photo({ shot: 1 });
    const pending = photo({ shot: 2, state: "PENDING", publishedAt: null });
    const rejected = photo({ shot: 3, state: "REJECTED", rejectReason: "SOF too short", publishedAt: null });
    const hidden = photo({ shot: 4, hidden: true });
    mocked = server([hidden, rejected, pending, ready]);
    await view();
    expect(document.querySelector("h1")?.textContent).toBe("Smith wedding");
    const tabs = [...document.querySelectorAll('nav[aria-label="Event sections"] a')];
    expect(tabs.map((a) => a.textContent)).toEqual(["Details", "Photos (4)"]);
    expect(tabs[1]!.getAttribute("aria-current")).toBe("page");
    expect(tiles()).toHaveLength(4);
    expect(tiles()[3]!.querySelector("img")!.getAttribute("src")).toBe(`/api/media/${ready.id}/thumb`);
    expect(tiles()[3]!.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    expect(tiles()[2]!.textContent).toContain("Pending");
    expect(tiles()[1]!.textContent).toContain("Rejected: SOF too short");
    expect(tiles()[0]!.textContent).toContain("Hidden");
    expect(tiles()[3]!.textContent).not.toMatch(/Hidden|Pending|Rejected/);
  });

  it("the Details tab links back, and Details links here", async () => {
    mocked = server([photo()]);
    await view();
    expect(document.querySelector<HTMLAnchorElement>('nav[aria-label="Event sections"] a')!.getAttribute("href")).toBe(`/events/${EVENT_ID}`);
    mocked.restore();
    await unmountApp();
    mocked = server([photo({ state: "REJECTED", rejectReason: "x", publishedAt: null })]);
    await mountApp(fakeAdminEnv().env, `/events/${EVENT_ID}`);
    const photosTab = [...document.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Event sections"] a')][1]!;
    expect(photosTab.getAttribute("href")).toBe(`/events/${EVENT_ID}/photos`);
    expect(document.querySelector('a[href^="/audit?event="]')?.getAttribute("href")).toBe(`/audit?event=${EVENT_ID}`);
  });

  it("filters by state and by visibility through the API", async () => {
    mocked = server([photo(), photo({ hidden: true }), photo({ state: "REJECTED", rejectReason: "x", publishedAt: null })]);
    await view();
    expect(photoCalls()).toHaveLength(1);
    expect(photoCalls()[0]!.path).toBe(`/api/events/${EVENT_ID}/photos`);
    await type(document.getElementById("photo-state") as HTMLSelectElement, "REJECTED");
    expect(photoCalls().at(-1)!.path).toBe(`/api/events/${EVENT_ID}/photos?state=REJECTED`);
    expect(tiles()).toHaveLength(1);
    await type(document.getElementById("photo-state") as HTMLSelectElement, "ALL");
    await type(document.getElementById("photo-visibility") as HTMLSelectElement, "hidden");
    expect(photoCalls().at(-1)!.path).toBe(`/api/events/${EVENT_ID}/photos?hidden=true`);
    expect(tiles()).toHaveLength(1);
    expect(tiles()[0]!.textContent).toContain("Hidden");
    await type(document.getElementById("photo-visibility") as HTMLSelectElement, "visible");
    expect(photoCalls().at(-1)!.path).toBe(`/api/events/${EVENT_ID}/photos?hidden=false`);
    expect(tiles()).toHaveLength(2);
  });

  it("says so when nothing matches, and offers the whole list", async () => {
    mocked = server([photo()]);
    await view();
    await type(document.getElementById("photo-state") as HTMLSelectElement, "PENDING");
    expect(text()).toContain("No photos match");
  });

  it("pages with Load more, appending in order", async () => {
    const all = Array.from({ length: 65 }, (_, i) => photo({ shot: i })).reverse();
    mocked = server(all);
    await view();
    expect(tiles()).toHaveLength(PAGE);
    await click(button("Load more"));
    expect(photoCalls().at(-1)!.path).toBe(`/api/events/${EVENT_ID}/photos?cursor=${all[PAGE - 1]!.id}`);
    expect(tiles()).toHaveLength(65);
    expect(tiles().map((t) => t.dataset.photo)).toEqual(all.map((p) => p.id));
    expect(maybeButton("Load more")).toBeNull();
  });

  it("Refresh reloads the first page and the counts", async () => {
    mocked = server([photo()]);
    await view();
    const before = mocked.calls.length;
    await click(button("Refresh"));
    expect(mocked.calls.length).toBeGreaterThan(before);
    expect(photoCalls()).toHaveLength(2);
  });

  it("shows a readable message when the list can't be loaded", async () => {
    mocked = server([], {}, { [`GET /api/events/${EVENT_ID}/photos`]: apiError(500, "internal", "x") });
    await view();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("reference 11111111");
  });

  it("works for a deleted event too, with a note that the gallery is off", async () => {
    mocked = server([photo()], { deletedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 7 * 86_400_000).toISOString() });
    await view();
    expect(text()).toContain("This event is deleted");
    expect(tiles()).toHaveLength(1);
  });

  it("an unknown event is the not-found message from the API", async () => {
    mocked = mockFetch(() => apiError(404, "not_found", "No such event."));
    await view();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("no longer exists");
  });
});

describe("the viewer", () => {
  it("opens the full-size photo with its details, and Escape closes it and returns focus to the tile", async () => {
    const a = photo({ shot: 1 });
    const b = photo({ shot: 2, state: "REJECTED", rejectReason: "SOF too short", publishedAt: null });
    mocked = server([b, a]);
    await view();
    await open(1);
    const d = dialog()!;
    expect(d.querySelector("img")!.getAttribute("src")).toBe(`/api/media/${a.id}/hd`);
    expect(d.querySelector("img")!.getAttribute("alt")).toContain("session 19a0b6c1-1, shot 1");
    expect(d.textContent).toContain("Photo 2 of 2");
    expect(d.textContent).toContain("19a0b6c1-1");
    expect(d.textContent).toContain("24 Oct 2026, 19:30");
    await press(document.activeElement!, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement === tiles()[1]).toBe(true);
  });

  it("steps through the loaded photos with Previous, Next and the arrow keys", async () => {
    const photos = [photo({ shot: 3 }), photo({ shot: 2 }), photo({ shot: 1 })];
    mocked = server(photos);
    await view();
    await open(0);
    const src = () => dialog()!.querySelector("img")!.getAttribute("src");
    expect(src()).toBe(`/api/media/${photos[0]!.id}/hd`);
    expect(maybeButton("Previous")!.disabled).toBe(true);
    await click(button("Next"));
    expect(src()).toBe(`/api/media/${photos[1]!.id}/hd`);
    await press(dialog()!.querySelector("button")!, "ArrowRight");
    expect(src()).toBe(`/api/media/${photos[2]!.id}/hd`);
    expect(button("Next").disabled).toBe(true);
    await press(dialog()!.querySelector("button")!, "ArrowLeft");
    expect(src()).toBe(`/api/media/${photos[1]!.id}/hd`);
  });

  it("a variant that isn't stored says so instead of showing a broken image", async () => {
    mocked = server([photo({ state: "PENDING", publishedAt: null })]);
    await view();
    await open(0);
    await settle(() => void dialog()!.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(dialog()!.textContent).toContain("hasn't been stored");
  });
});

describe("keyboard focus stays in the viewer", () => {
  const inDialog = () => dialog()!.contains(document.activeElement);

  it("after Hide, whose button disables itself while the request runs", async () => {
    const p = photo();
    mocked = mockFetch((call) => {
      const url = new URL(call.path, "http://admin.localhost");
      if (url.pathname === `/api/events/${EVENT_ID}`) return json(event());
      // What a browser does to a focused button that has just disabled itself: focus drops to the page.
      if (call.method === "POST") {
        (document.activeElement as HTMLElement | null)?.blur();
        return json({ ...p, hidden: true });
      }
      return json({ photos: [p], nextCursor: null });
    });
    await view();
    await open(0);
    button("Hide from guests").focus();
    await click(button("Hide from guests"));
    expect(button("Unhide")).toBeTruthy();
    expect(inDialog()).toBe(true);
  });

  it("when Next or Previous reaches the end and disables itself", async () => {
    mocked = server([photo({ shot: 2 }), photo({ shot: 1 })]);
    await view();
    await open(0);
    await click(button("Next"));
    expect(button("Next").disabled).toBe(true);
    expect(inDialog()).toBe(true);
  });
});

describe("a slow answer never lands on a newer filter", () => {
  it("the first page of the old filter, answered last, is dropped", async () => {
    const everything = [photo({ shot: 3 }), photo({ shot: 2 })];
    const rejected = photo({ state: "REJECTED", rejectReason: "x", publishedAt: null });
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => (release = resolve));
    let photoRequests = 0;
    mocked = mockFetch((call) => {
      const url = new URL(call.path, "http://admin.localhost");
      if (url.pathname === `/api/events/${EVENT_ID}`) return json(event());
      photoRequests++;
      // The first request (no filter) is held back; the filtered one answers at once.
      return photoRequests === 1 ? slow : json({ photos: [rejected], nextCursor: null });
    });
    await view();
    await type(document.getElementById("photo-state") as HTMLSelectElement, "REJECTED");
    expect(tiles()).toHaveLength(1);
    await settle(() => release(json({ photos: everything, nextCursor: null })));
    expect(tiles().map((t) => t.dataset.photo)).toEqual([rejected.id]);
  });
});

describe("a request that finishes after the viewer moved on", () => {
  it("doesn't pull the viewer back: hiding under 'Visible only', then stepping on before the answer", async () => {
    const photos = [photo({ shot: 3 }), photo({ shot: 2 }), photo({ shot: 1 })];
    let release: (r: Response) => void = () => {};
    mocked = mockFetch((call) => {
      const url = new URL(call.path, "http://admin.localhost");
      if (url.pathname === `/api/events/${EVENT_ID}`) return json(event());
      if (call.method === "POST") return new Promise<Response>((resolve) => (release = resolve));
      return json({ photos, nextCursor: null });
    });
    await view();
    await type(document.getElementById("photo-visibility") as HTMLSelectElement, "visible");
    await open(0);
    await click(button("Hide from guests"));
    await click(button("Next"));
    await click(button("Next"));
    await settle(() => release(json({ ...photos[0]!, hidden: true })));
    // The hidden photo left the grid, and the viewer stayed on the photo the admin stepped to.
    expect(tiles()).toHaveLength(2);
    expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe(`/api/media/${photos[2]!.id}/hd`);
  });
});

describe("hide and unhide", () => {
  it("hides without a confirmation, marks the tile and the viewer, and refreshes the counts", async () => {
    const p = photo();
    mocked = server([p]);
    await view();
    await open(0);
    expect(maybeButton("Unhide")).toBeNull();
    await click(button("Hide from guests"));
    expect(mutations()).toEqual([expect.objectContaining({ method: "POST", path: `/api/photos/${p.id}/hide` })]);
    expect(button("Unhide").textContent).toBe("Unhide");
    expect(dialog()!.textContent).toContain("Guests can no longer see this photo");
    expect(tiles()[0]!.textContent).toContain("Hidden");
    const eventReads = mocked.calls.filter((c) => c.method === "GET" && c.path === `/api/events/${EVENT_ID}`);
    expect(eventReads.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector('nav[aria-label="Event sections"]')!.textContent).toContain("Photos (1)");
  });

  it("unhides the same way", async () => {
    const p = photo({ hidden: true });
    mocked = server([p]);
    await view();
    await open(0);
    await click(button("Unhide"));
    expect(mutations()[0]).toMatchObject({ method: "POST", path: `/api/photos/${p.id}/unhide` });
    expect(button("Hide from guests")).toBeTruthy();
    expect(tiles()[0]!.textContent).not.toContain("Hidden");
  });

  it("under 'Visible only', a hidden photo leaves the grid and the viewer moves to the next one", async () => {
    const photos = [photo({ shot: 2 }), photo({ shot: 1 })];
    mocked = server(photos);
    await view();
    await type(document.getElementById("photo-visibility") as HTMLSelectElement, "visible");
    await open(0);
    await click(button("Hide from guests"));
    expect(tiles()).toHaveLength(1);
    expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe(`/api/media/${photos[1]!.id}/hd`);
    await click(button("Hide from guests"));
    expect(tiles()).toHaveLength(0);
    expect(dialog()).toBeNull();
    expect(text()).toContain("No photos match");
  });

  it("a failure is shown in the viewer and nothing changes on screen", async () => {
    const p = photo();
    mocked = server([p], {}, { [`POST /api/photos/${p.id}/hide`]: apiError(409, "conflict", "The photo is already hidden.") });
    await view();
    await open(0);
    await click(button("Hide from guests"));
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toContain("already hidden");
    expect(tiles()[0]!.textContent).not.toContain("Hidden");
  });
});

describe("Delete permanently", () => {
  it("asks first, naming the consequences, and Cancel changes nothing", async () => {
    const p = photo({ sessionId: "s-9", shot: 4 });
    mocked = server([p]);
    await view();
    await open(0);
    await click(button("Delete permanently"));
    const confirm = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(confirm.textContent).toContain("Delete this photo permanently?");
    expect(confirm.textContent).toContain("removed from the gallery and from storage now");
    expect(confirm.textContent).toContain("browser");
    expect(confirm.textContent).toContain("SD card");
    expect(confirm.textContent).toContain("Smith wedding: session s-9, shot 4");
    // It opens on Cancel, so a stray Enter doesn't delete.
    expect(document.activeElement!.textContent).toBe("Cancel");
    await click(button("Cancel", confirm));
    expect(mutations()).toEqual([]);
    expect(tiles()).toHaveLength(1);
    expect(dialog()!.textContent).toContain("Photo 1 of 1");
  });

  it("confirming deletes it, then shows the next photo; deleting the last closes the viewer", async () => {
    const photos = [photo({ shot: 2 }), photo({ shot: 1 })];
    mocked = server(photos);
    await view();
    await open(0);
    await click(button("Delete permanently"));
    await click(button("Delete permanently", [...document.querySelectorAll('[role="dialog"]')].at(-1)!));
    expect(mutations()).toEqual([expect.objectContaining({ method: "DELETE", path: `/api/photos/${photos[0]!.id}` })]);
    expect(tiles()).toHaveLength(1);
    expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe(`/api/media/${photos[1]!.id}/hd`);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    await click(button("Delete permanently"));
    await click(button("Delete permanently", [...document.querySelectorAll('[role="dialog"]')].at(-1)!));
    expect(dialog()).toBeNull();
    expect(tiles()).toHaveLength(0);
    expect(document.querySelector('nav[aria-label="Event sections"]')!.textContent).toContain("Photos (0)");
  });

  it("a failed delete keeps the photo and says why, in the confirmation", async () => {
    const p = photo();
    mocked = server([p], {}, { [`DELETE /api/photos/${p.id}`]: apiError(500, "internal", "x") });
    await view();
    await open(0);
    await click(button("Delete permanently"));
    await click(button("Delete permanently", [...document.querySelectorAll('[role="dialog"]')].at(-1)!));
    const confirm = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(confirm.querySelector("p.error")!.textContent).toContain("reference 11111111");
    expect(tiles()).toHaveLength(1);
  });

  it("a photo already gone (404) leaves the grid and the confirmation closes", async () => {
    const p = photo();
    mocked = server([p], {}, { [`DELETE /api/photos/${p.id}`]: apiError(404, "not_found", "No such photo.") });
    await view();
    await open(0);
    await click(button("Delete permanently"));
    await click(button("Delete permanently", [...document.querySelectorAll('[role="dialog"]')].at(-1)!));
    expect(tiles()).toHaveLength(0);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});
