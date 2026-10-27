import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Link, navigate, parseRoute, routePath, useRoute, type Route } from "./nav";
import { setUrl } from "./testing";

const ID = "019a0b7e-0000-7000-8000-000000000001";

afterEach(() => {
  document.body.innerHTML = "";
  setUrl("/");
});

describe("parseRoute / routePath", () => {
  const table: [string, Route][] = [
    ["/", { name: "events" }],
    ["/events", { name: "events" }],
    ["/events/new", { name: "event-new" }],
    [`/events/${ID}`, { name: "event", id: ID }],
    [`/events/${ID}/edit`, { name: "event-edit", id: ID }],
    ["/devices", { name: "devices" }],
    ["/audit", { name: "audit" }],
  ];
  for (const [path, route] of table) {
    it(`${path} is ${route.name}`, () => expect(parseRoute(path)).toEqual(route));
  }

  it("tolerates a trailing slash", () => {
    expect(parseRoute("/devices/")).toEqual({ name: "devices" });
  });

  it("anything else, including a malformed event ID, is not-found", () => {
    for (const path of ["/nope", "/events/123", "/events/not-an-id/edit", `/events/${ID}/x`, `/events/${ID}/edit/x`, "/devices/x"]) {
      expect(parseRoute(path)).toEqual({ name: "not-found" });
    }
  });

  it("round-trips every route to its path", () => {
    for (const [, route] of table) expect(parseRoute(routePath(route))).toEqual(route);
  });
});

function Probe() {
  const route = useRoute();
  return (
    <div>
      <p id="route">{route.name}</p>
      <Link to="/devices">Devices</Link>
    </div>
  );
}

async function render() {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    createRoot(document.getElementById("root")!).render(<Probe />);
  });
}

const route = () => document.getElementById("route")!.textContent;

describe("history wrapper", () => {
  it("renders the route for the current URL", async () => {
    setUrl("/audit");
    await render();
    expect(route()).toBe("audit");
  });

  it("a link click pushes history instead of reloading", async () => {
    setUrl("/");
    await render();
    const before = history.length;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      document.querySelector("a")!.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(location.pathname).toBe("/devices");
    expect(history.length).toBe(before + 1);
    expect(route()).toBe("devices");
  });

  it("leaves modified clicks to the browser (open in a new tab)", async () => {
    setUrl("/");
    await render();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    await act(async () => {
      document.querySelector("a")!.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(false);
    expect(route()).toBe("events");
  });

  it("follows the back button", async () => {
    setUrl("/");
    await render();
    await act(async () => navigate("/devices"));
    expect(route()).toBe("devices");
    await act(async () => {
      history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(route()).toBe("events");
  });

  it("navigating to where you already are doesn't add an entry", async () => {
    setUrl("/devices");
    await render();
    const before = history.length;
    await act(async () => navigate("/devices"));
    expect(history.length).toBe(before);
  });
});
