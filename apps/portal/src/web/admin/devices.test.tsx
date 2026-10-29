import { afterEach, describe, expect, it } from "bun:test";
import type { AdminDevice } from "../../shared/schemas";
import { groupCode } from "./DevicesView";
import { button, click, dialog, input, maybeButton, mountApp, settle, submit, text, type, unmountApp } from "./harness";
import { NOW, apiError, device, fakeAdminEnv, json, mockFetch } from "./testing";

let mocked: ReturnType<typeof mockFetch> | null = null;
afterEach(async () => {
  await unmountApp();
  mocked?.restore();
  mocked = null;
});

const CODE = "K7QM2XZ9";
const EXPIRES = new Date(NOW + 10 * 60_000).toISOString();
const posts = () => mocked!.calls.filter((c) => c.method === "POST");
const listCalls = () => mocked!.calls.filter((c) => c.method === "GET" && c.path === "/api/devices");

function server(list: () => AdminDevice[]) {
  return mockFetch((call) => {
    if (call.method === "GET") return json({ devices: list() });
    if (call.path === "/api/devices") return json({ deviceId: "d-new", code: CODE, expiresAt: EXPIRES }, 201);
    if (call.path.endsWith("/code")) return json({ deviceId: "d1", code: CODE, expiresAt: EXPIRES });
    return json(device({ revokedAt: new Date(NOW).toISOString() }));
  });
}

describe("devices list", () => {
  it("shows name, status, last seen, backlog and app version for each booth", async () => {
    mocked = server(() => [
      device({ name: "Booth A", lastBacklog: 12, appVersion: "0.1.0", lastSeenAt: new Date(NOW - 3 * 60_000).toISOString() }),
      device({ id: "d2", name: "Booth B", enrolledAt: null, lastSeenAt: null, lastBacklog: null, appVersion: null, codeExpiresAt: EXPIRES }),
      device({ id: "d3", name: "Old tablet", revokedAt: "2026-10-22T00:00:00.000Z" }),
    ]);
    await mountApp(fakeAdminEnv().env, "/devices");
    const rows = [...document.querySelectorAll("tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("Booth A");
    expect(rows[0]).toContain("Enrolled");
    expect(rows[0]).toContain("3 min ago");
    expect(rows[0]).toContain("12");
    expect(rows[0]).toContain("0.1.0");
    expect(rows[1]).toContain("Code not used yet");
    expect(rows[1]).toContain("never");
    expect(rows[2]).toContain("Revoked");
    // A revoked booth has no actions.
    expect(document.querySelectorAll("tbody tr")[2]!.querySelectorAll("button")).toHaveLength(0);
  });

  it("flags an enrolled booth that hasn't been heard from for over 10 minutes", async () => {
    mocked = server(() => [device({ lastSeenAt: new Date(NOW - 11 * 60_000).toISOString() })]);
    await mountApp(fakeAdminEnv().env, "/devices");
    expect(text()).toContain("Not heard from lately");
  });

  it("marks an expired code", async () => {
    mocked = server(() => [device({ enrolledAt: null, codeExpiresAt: new Date(NOW - 1000).toISOString(), lastSeenAt: null })]);
    await mountApp(fakeAdminEnv().env, "/devices");
    expect(text()).toContain("Code expired");
  });
});

describe("auto-refresh", () => {
  it("reloads every 15 seconds while visible, and shows the new numbers", async () => {
    let backlog = 4;
    const env = fakeAdminEnv();
    mocked = server(() => [device({ lastBacklog: backlog })]);
    await mountApp(env.env, "/devices");
    expect(listCalls()).toHaveLength(1);
    backlog = 0;
    await settle(() => env.advance(15_000));
    expect(listCalls()).toHaveLength(2);
    expect(document.querySelector("tbody td.num")!.textContent).toBe("0");
    await settle(() => env.advance(30_000));
    expect(listCalls()).toHaveLength(4);
  });

  it("doesn't poll while the page is hidden, and catches up when it is shown", async () => {
    const env = fakeAdminEnv();
    mocked = server(() => [device()]);
    await mountApp(env.env, "/devices");
    await settle(() => env.setVisible(false));
    await settle(() => env.advance(120_000));
    expect(listCalls()).toHaveLength(1);
    await settle(() => env.setVisible(true));
    expect(listCalls()).toHaveLength(2);
  });

  it("stops when the page is left", async () => {
    const env = fakeAdminEnv();
    mocked = server(() => [device()]);
    await mountApp(env.env, "/devices");
    await unmountApp();
    expect(env.timers()).toBe(0);
  });

  it("keeps the last data and says so when a refresh fails", async () => {
    const env = fakeAdminEnv();
    let failing = false;
    mocked = mockFetch(() => (failing ? apiError(500, "internal", "x") : json({ devices: [device({ name: "Booth A" })] })));
    await mountApp(env.env, "/devices");
    failing = true;
    await settle(() => env.advance(15_000));
    expect(text()).toContain("Booth A");
    expect(text()).toContain("Couldn't refresh");
  });

  it("says why a refresh failed when the sign-in has ended", async () => {
    const env = fakeAdminEnv();
    let failing = false;
    mocked = mockFetch(() => {
      if (!failing) return json({ devices: [device({ name: "Booth A" })] });
      // What fetch(…, { redirect: "manual" }) gives for Access's login redirect.
      const res = new Response(null, { status: 204 });
      Object.defineProperties(res, { type: { value: "opaqueredirect" }, status: { value: 0 }, ok: { value: false } });
      return res;
    });
    await mountApp(env.env, "/devices");
    failing = true;
    await settle(() => env.advance(15_000));
    expect(text()).toContain("Booth A");
    expect(text()).toContain("Couldn't refresh");
    expect(text()).toContain("Your sign-in has ended. Reload the page to sign in again.");
  });
});

describe("create a booth and show its code once", () => {
  const create = async (name = "Front booth") => {
    await type(input("device-name"), name);
    await submit(document.querySelector("form")!);
  };

  it("posts the name and shows the code grouped, with a 10-minute countdown", async () => {
    mocked = server(() => [device()]);
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/api/devices", { name: "Front booth" }]]);
    const d = dialog()!;
    expect(d.textContent).toContain("Front booth");
    expect(d.querySelector(".code")!.textContent).toBe("K7QM-2XZ9");
    expect(d.textContent).toContain("Expires in 10:00");
    expect(d.textContent).toContain("only time the code is shown");
    expect(input("device-name").value).toBe("");
  });

  it("counts down every second", async () => {
    const env = fakeAdminEnv();
    mocked = server(() => []);
    await mountApp(env.env, "/devices");
    await create();
    await settle(() => env.advance(61_000));
    expect(dialog()!.textContent).toContain("Expires in 8:59");
  });

  it("drops the code when the dialog is closed: not in the page, the list, storage, the URL or the title", async () => {
    const env = fakeAdminEnv();
    mocked = server(() => [device()]);
    await mountApp(env.env, "/devices");
    await create();
    expect(text()).toContain("K7QM-2XZ9");
    await click(button("Done", dialog()!));
    expect(dialog()).toBeNull();
    // Not after closing, nor after the list refreshes and the view re-renders.
    await settle(() => env.advance(30_000));
    const everything = [document.documentElement.outerHTML, location.href, document.title, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })].join("\n");
    // Booleans, not toContain: a failing toContain prints the whole page.
    expect(everything.includes(CODE)).toBe(false);
    expect(everything.includes("K7QM")).toBe(false);
    expect(everything.includes("2XZ9")).toBe(false);
  });

  it("never puts the code in the URL, history state or storage even while it is open", async () => {
    mocked = server(() => []);
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    expect(location.href).not.toContain("K7QM");
    expect(JSON.stringify(history.state)).not.toContain("K7QM");
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("K7QM");
  });

  it("closes on Escape and returns focus to the form", async () => {
    mocked = server(() => []);
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    await settle(() => void dialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog()).toBeNull();
    expect(text().includes("K7QM")).toBe(false);
  });

  it("counts the 10 minutes from when the code arrived, so a wrong PC clock can't show it as expired", async () => {
    mocked = mockFetch((c) =>
      c.method === "POST" ? json({ deviceId: "d", code: CODE, expiresAt: "2020-01-01T00:00:00.000Z" }, 201) : json({ devices: [] }),
    );
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    expect(dialog()!.textContent).toContain("Expires in 10:00");
    expect(text()).toContain("K7QM-2XZ9");
  });

  it("ignores a click on the backdrop: the code can't be shown again", async () => {
    mocked = server(() => []);
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    await settle(() => void document.querySelector(".backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(dialog()).not.toBeNull();
    expect(text()).toContain("K7QM-2XZ9");
  });

  it("at the 10-minute mark the dialog says the code expired and no longer shows it", async () => {
    const env = fakeAdminEnv();
    mocked = server(() => []);
    await mountApp(env.env, "/devices");
    await create();
    await settle(() => env.advance(10 * 60_000 - 1000));
    expect(dialog()!.textContent).toContain("Expires in 0:01");
    expect(text()).toContain("K7QM-2XZ9");
    await settle(() => env.advance(1000));
    expect(dialog()!.textContent).toContain("expired");
    expect(text().includes("K7QM")).toBe(false);
  });

  it("asks for a name and sends nothing without one", async () => {
    mocked = server(() => []);
    await mountApp(fakeAdminEnv().env, "/devices");
    await create("   ");
    expect(posts()).toHaveLength(0);
    expect(input("device-name").getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("device-name-error")?.textContent).toContain("Enter a name");
  });

  it("shows the server's refusal and no dialog", async () => {
    mocked = mockFetch((c) => (c.method === "POST" ? apiError(429, "rate_limited", "Slow down.") : json({ devices: [] })));
    await mountApp(fakeAdminEnv().env, "/devices");
    await create();
    expect(dialog()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Too many requests");
  });

  it("formats the code in groups of four", () => {
    expect(groupCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});

describe("re-issue a code", () => {
  it("for a booth that isn't enrolled and has no live code shows the new code straight away", async () => {
    mocked = server(() => [device({ enrolledAt: null, lastSeenAt: null, codeExpiresAt: null })]);
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/Re-issue code/));
    expect(posts().map((c) => c.path)).toEqual(["/api/devices/019a0b7e-0000-7000-8000-0000000000d1/code"]);
    expect(dialog()!.querySelector(".code")!.textContent).toBe("K7QM-2XZ9");
  });

  it("a double click issues one code, not two (each voids the one before)", async () => {
    let release: () => void = () => {};
    mocked = mockFetch((c) => {
      if (c.method === "GET") return json({ devices: [device({ enrolledAt: null, lastSeenAt: null, codeExpiresAt: null })] });
      return new Promise<Response>((resolve) => (release = () => resolve(json({ deviceId: "d1", code: CODE, expiresAt: EXPIRES }))));
    });
    await mountApp(fakeAdminEnv().env, "/devices");
    const reissue = button(/Re-issue code/);
    await click(reissue);
    await click(reissue);
    expect(posts()).toHaveLength(1);
    expect(reissue.disabled).toBe(true);
    await settle(() => release());
    expect(dialog()!.querySelector(".code")!.textContent).toBe("K7QM-2XZ9");
    expect(posts()).toHaveLength(1);
  });

  it("for a booth whose code is still live asks first, because someone may be typing it in", async () => {
    mocked = server(() => [device({ enrolledAt: null, lastSeenAt: null, codeExpiresAt: EXPIRES })]);
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/Re-issue code/));
    expect(posts()).toHaveLength(0);
    expect(dialog()!.textContent).toContain("stops working");
    await click(button("Make new code", dialog()!));
    expect(posts()).toHaveLength(1);
    expect(dialog()!.querySelector(".code")!.textContent).toBe("K7QM-2XZ9");
  });

  it("for an enrolled booth asks first and says it re-enrols the tablet", async () => {
    mocked = server(() => [device()]);
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/New code/));
    expect(posts()).toHaveLength(0);
    expect(dialog()!.textContent).toContain("already enrolled");
    expect(dialog()!.textContent).toContain("replaces its current credential");
    await click(button("Cancel", dialog()!));
    expect(posts()).toHaveLength(0);
    await click(button(/New code/));
    await click(button("Make new code", dialog()!));
    expect(posts()).toHaveLength(1);
    expect(dialog()!.querySelector(".code")!.textContent).toBe("K7QM-2XZ9");
  });

  it("explains that a revoked booth can't get a code", async () => {
    mocked = mockFetch((c) => (c.method === "POST" ? apiError(409, "conflict", "The device is revoked.") : json({ devices: [device()] })));
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/New code/));
    await click(button("Make new code", dialog()!));
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("The device is revoked.");
    expect(dialog()!.querySelector(".code")).toBeNull();
  });
});

describe("revoke", () => {
  it("asks first, names the booth, and does nothing on Cancel", async () => {
    mocked = server(() => [device({ name: "Booth A" })]);
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/Revoke/));
    expect(dialog()!.textContent).toContain("Revoke Booth A?");
    expect(dialog()!.textContent).toContain("locked out immediately");
    await click(button("Cancel", dialog()!));
    expect(dialog()).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it("revokes on Confirm and reloads the list", async () => {
    let revoked = false;
    mocked = mockFetch((c) => {
      if (c.method === "POST") {
        revoked = true;
        return json(device({ revokedAt: new Date(NOW).toISOString() }));
      }
      return json({ devices: [device({ revokedAt: revoked ? new Date(NOW).toISOString() : null })] });
    });
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/Revoke/));
    await click(button("Revoke booth", dialog()!));
    expect(posts().map((c) => c.path)).toEqual(["/api/devices/019a0b7e-0000-7000-8000-0000000000d1/revoke"]);
    expect(dialog()).toBeNull();
    expect(text()).toContain("Revoked");
    expect(maybeButton(/Revoke/)).toBeNull();
  });

  it("an already revoked booth (409) is explained in the dialog", async () => {
    mocked = mockFetch((c) => (c.method === "POST" ? apiError(409, "conflict", "The device is already revoked.") : json({ devices: [device()] })));
    await mountApp(fakeAdminEnv().env, "/devices");
    await click(button(/Revoke/));
    await click(button("Revoke booth", dialog()!));
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe("The device is already revoked.");
  });
});
