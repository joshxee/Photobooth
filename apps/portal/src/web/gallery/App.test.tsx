import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { browserLikeBack, type Call, fakeEnv, json, mockFetch, notFound, page, photo, setUrl } from "./testing";

const PUBLIC = "seedopenlive2222";
let root: Root | null = null;
let restoreFetch: (() => void) | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  restoreFetch?.();
  restoreFetch = null;
  document.body.innerHTML = "";
});

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
};

async function render(path: string, route: (call: Call) => Response | Promise<Response>, env = fakeEnv()) {
  setUrl(path);
  browserLikeBack();
  const fetchMock = mockFetch(route);
  restoreFetch = fetchMock.restore;
  document.body.innerHTML = '<div id="root"></div>';
  const el = document.getElementById("root");
  if (!el) throw new Error("no root");
  root = createRoot(el);
  await act(async () => root?.render(<App env={env.env} />));
  await settle();
  return { calls: fetchMock.calls, env };
}

const gets = (calls: Call[]) => calls.filter((c) => c.method === "GET");
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const text = () => document.body.textContent ?? "";
async function click(el: HTMLElement | null) {
  if (!el) throw new Error("nothing to click");
  await act(async () => el.click());
  await settle();
}
async function key(el: Element | null, k: string, shiftKey = false) {
  if (!el) throw new Error("no element");
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
  });
  await settle();
}

const a1 = photo(1, "a-1", 1);
const a2 = photo(2, "a-1", 2);
const a3 = photo(3, "a-1", 3, true);
const b1 = photo(4, "b-1", 1);
const b2 = photo(5, "b-1", 2);

describe("link handling", () => {
  it("swaps the token, strips the fragment and keeps the session filter", async () => {
    const { calls } = await render(`/e/${PUBLIC}#k=tok-123&s=a-1&n=3`, (c) =>
      c.method === "POST" ? json({ ok: true }) : json(page([a2, a1])),
    );
    expect(calls[0]).toEqual({ method: "POST", url: `/e/${PUBLIC}/api/session`, body: JSON.stringify({ token: "tok-123" }) });
    expect(location.hash).toBe("");
    expect(location.pathname + location.search).toBe(`/e/${PUBLIC}?s=a-1&n=3`);
    expect(location.href).not.toContain("tok-123");
    expect(calls[1]?.url).toBe(`/e/${PUBLIC}/api/photos?session=a-1`);
  });

  it("uses the existing cookie when there is no fragment", async () => {
    const { calls } = await render(`/e/${PUBLIC}`, () => json(page([b1, a1])));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect($("h1")?.textContent).toBe("Smith wedding");
  });

  it("shows one calm page when the token is refused, without the token in the URL", async () => {
    await render(`/e/${PUBLIC}#k=old`, () => notFound());
    expect($("h1")?.textContent).toBe("This gallery isn't available");
    expect(location.href).not.toContain("old");
  });

  it("shows the same page when the cookie is refused", async () => {
    await render(`/e/${PUBLIC}`, () => notFound());
    expect($("h1")?.textContent).toBe("This gallery isn't available");
    const refusedCookie = document.body.innerHTML;
    await act(async () => root?.unmount());
    await render(`/e/${PUBLIC}#k=bad`, () => notFound());
    expect(document.body.innerHTML).toBe(refusedCookie);
  });

  it("shows the unavailable page for a path that isn't an event, with no request", async () => {
    const { calls } = await render("/e/", () => json(page([])));
    expect($("h1")?.textContent).toBe("This gallery isn't available");
    expect(calls).toHaveLength(0);
  });
});

describe("event view", () => {
  it("groups photos by session with lazy thumbnails sized from the API", async () => {
    await render(`/e/${PUBLIC}`, () => json(page([b2, b1, a3, a2, a1])));
    expect($$("section.group")).toHaveLength(2);
    const img = $("img.tile__img") as HTMLImageElement;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe(`/e/${PUBLIC}/m/${b1.id}/thumb`);
    expect(img.getAttribute("width")).toBe("2560");
    expect(img.getAttribute("height")).toBe("1707");
  });

  it("shows the empty state", async () => {
    await render(`/e/${PUBLIC}`, () => json(page([])));
    expect(text()).toContain("No photos yet");
  });

  it("loads older photos by cursor", async () => {
    const { calls } = await render(`/e/${PUBLIC}`, (c) =>
      c.url.includes("cursor=") ? json(page([a2, a1])) : json(page([b2, b1, a3], { nextCursor: "c1" })),
    );
    await click($("button.more"));
    expect(calls.at(-1)?.url).toBe(`/e/${PUBLIC}/api/photos?cursor=c1`);
    expect($$("a.tile")).toHaveLength(5);
    expect($("button.more")).toBeNull();
  });

  it("shows the contact address, email and a removal link in the footer", async () => {
    await render(`/e/${PUBLIC}`, () => json(page([a1])));
    const footer = $("footer");
    expect(footer?.textContent).toContain("34b Malvern Road, Morningside, Auckland");
    expect(footer?.textContent).toContain("privacy@example.invalid");
    const removal = [...(footer?.querySelectorAll("a") ?? [])].find((a) => a.textContent === "Ask us to remove a photo");
    expect(removal?.getAttribute("href")).toStartWith("mailto:privacy@example.invalid?subject=");
  });
});

describe("live updates", () => {
  it("polls every 30 s while visible, stops while hidden, and polls once when visible again", async () => {
    const { calls, env } = await render(`/e/${PUBLIC}`, () => json(page([a1])));
    expect(gets(calls)).toHaveLength(1);
    await env.advance(30_000, settle);
    expect(gets(calls)).toHaveLength(2);
    expect(calls.at(-1)?.url).toBe(`/e/${PUBLIC}/api/photos`);
    await env.setVisible(false, settle);
    await env.advance(300_000, settle);
    expect(gets(calls)).toHaveLength(2);
    await env.setVisible(true, settle);
    expect(gets(calls)).toHaveLength(3);
  });

  it("doesn't poll a gallery whose event no longer accepts uploads", async () => {
    const { calls, env } = await render(`/e/${PUBLIC}`, () => json(page([a1], { eventOpen: false })));
    await env.advance(300_000, settle);
    await env.setVisible(false, settle);
    await env.setVisible(true, settle);
    expect(gets(calls)).toHaveLength(1);
    expect(text()).not.toContain("Live");
  });

  it("collects new photos in an 'N new' pill and adds them on top without duplicates", async () => {
    let latest = page([a2, a1]);
    const { env } = await render(`/e/${PUBLIC}`, () => json(latest));
    expect($$("a.tile")).toHaveLength(2);
    latest = page([b1, a2, a1]);
    await env.advance(30_000, settle);
    expect($("button.pill")?.textContent).toBe("1 new photo");
    expect($$("a.tile")).toHaveLength(2);
    latest = page([b2, b1, a2, a1]);
    await env.advance(30_000, settle);
    expect($("button.pill")?.textContent).toBe("2 new photos");
    await click($("button.pill"));
    expect($("button.pill")).toBeNull();
    const shown = $$("a.tile").map((a) => a.getAttribute("href"));
    expect(shown).toHaveLength(4);
    expect(new Set(shown).size).toBe(4);
    expect($$("section.group")[0]?.textContent).toContain("2 photos");
  });
});

describe("session view", () => {
  const boothLink = `/e/${PUBLIC}#k=tok&s=a-1&n=3`;
  const route = (photos: () => ReturnType<typeof page>) => (c: Call) => (c.method === "POST" ? json({ ok: true }) : json(photos()));

  it("shows 'Your photos' with placeholders for shots not ready yet, filled as they arrive", async () => {
    let latest = page([a1]);
    const { env } = await render(boothLink, route(() => latest));
    expect($("h1")?.textContent).toBe("Your photos");
    expect($$("a.shot")).toHaveLength(1);
    expect($$(".shot--waiting")).toHaveLength(2);
    latest = page([a2, a1]);
    await env.advance(10_000, settle);
    expect($$("a.shot")).toHaveLength(2);
    expect($$(".shot--waiting")).toHaveLength(1);
    expect($("button.pill")).toBeNull();
  });

  it("polls every 10 s for its first 2 minutes, then every 30 s", async () => {
    const { calls, env } = await render(boothLink, route(() => page([a1])));
    const polls = () => gets(calls).length - 1;
    await env.advance(120_000, settle);
    expect(polls()).toBe(12);
    await env.advance(60_000, settle);
    expect(polls()).toBe(14);
  });

  it("drops the placeholders after 2 minutes without a count", async () => {
    const { env } = await render(`/e/${PUBLIC}#k=tok&s=a-1`, route(() => page([a1])));
    expect($$(".shot--waiting")).toHaveLength(1);
    await env.advance(120_000, settle);
    expect($$(".shot--waiting")).toHaveLength(0);
  });

  it("opens the whole event from 'See everyone's photos'", async () => {
    const { calls } = await render(boothLink, route(() => page([a1])));
    await click($("a.see-all"));
    expect(location.pathname + location.search).toBe(`/e/${PUBLIC}`);
    expect(calls.at(-1)?.url).toBe(`/e/${PUBLIC}/api/photos`);
    expect($("h1")?.textContent).toBe("Smith wedding");
  });

  it("opens a session from its heading in the event view", async () => {
    const { calls } = await render(`/e/${PUBLIC}`, () => json(page([b1, a2, a1])));
    await click($("section.group a.group__link"));
    expect(location.search).toBe("?s=b-1");
    expect(calls.at(-1)?.url).toBe(`/e/${PUBLIC}/api/photos?session=b-1`);
    expect($("h1")?.textContent).toBe("Your photos");
  });
});

describe("lightbox", () => {
  async function open() {
    await render(`/e/${PUBLIC}`, () => json(page([b2, b1, a3, a2, a1])));
    const tile = $$("a.tile")[0] ?? null;
    tile?.focus();
    await click(tile);
    return tile;
  }

  it("opens the HD photo with a download link and moves focus into the dialog", async () => {
    await open();
    const dialog = $("[role=dialog]");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect($("img.viewer__img")?.getAttribute("src")).toBe(`/e/${PUBLIC}/m/${b1.id}/hd`);
    expect($("a.viewer__download")?.getAttribute("href")).toBe(`/e/${PUBLIC}/m/${b1.id}/hd?download=1`);
    expect(history.state).toEqual({ photo: b1.id });
  });

  it("moves with the arrow keys and stops at the ends", async () => {
    await open();
    const dialog = $("[role=dialog]");
    await key(dialog, "ArrowRight");
    expect($("img.viewer__img")?.getAttribute("src")).toBe(`/e/${PUBLIC}/m/${b2.id}/hd`);
    expect(text()).toContain("2 of 2");
    await key(dialog, "ArrowRight");
    expect($("img.viewer__img")?.getAttribute("src")).toBe(`/e/${PUBLIC}/m/${a1.id}/hd`);
    await key(dialog, "ArrowLeft");
    await key(dialog, "ArrowLeft");
    await key(dialog, "ArrowLeft");
    expect($("img.viewer__img")?.getAttribute("src")).toBe(`/e/${PUBLIC}/m/${b1.id}/hd`);
  });

  it("closes on Escape and gives focus back to the photo it opened from", async () => {
    const tile = await open();
    await key($("[role=dialog]"), "Escape");
    expect($("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });

  it("closes on Back", async () => {
    await open();
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await settle();
    expect($("[role=dialog]")).toBeNull();
  });

  it("keeps Tab inside the dialog", async () => {
    await open();
    const dialog = $("[role=dialog]");
    const focusable = [...(dialog?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])];
    const last = focusable.at(-1);
    const first = focusable[0];
    last?.focus();
    await key(last ?? null, "Tab");
    expect(document.activeElement).toBe(first ?? null);
    await key(first ?? null, "Tab", true);
    expect(document.activeElement).toBe(last ?? null);
  });
});
