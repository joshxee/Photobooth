// A small wrapper over the History API instead of a router library (DESIGN §5): about five views,
// all addressed by path. The Worker serves the admin shell for exactly these paths (routes/admin.ts).
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

export type Route =
  | { name: "events" }
  | { name: "event-new" }
  | { name: "event"; id: string }
  | { name: "event-edit"; id: string }
  | { name: "event-photos"; id: string }
  | { name: "devices" }
  | { name: "audit" }
  | { name: "not-found" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOT_FOUND: Route = { name: "not-found" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third, ...rest] = parts;
  if (rest.length > 0) return NOT_FOUND;
  if (first === undefined) return { name: "events" };
  if (first === "devices") return second === undefined ? { name: "devices" } : NOT_FOUND;
  if (first === "audit") return second === undefined ? { name: "audit" } : NOT_FOUND;
  if (first !== "events") return NOT_FOUND;
  if (second === undefined) return { name: "events" };
  if (second === "new") return third === undefined ? { name: "event-new" } : NOT_FOUND;
  if (!ID.test(second)) return NOT_FOUND;
  if (third === undefined) return { name: "event", id: second };
  if (third === "edit") return { name: "event-edit", id: second };
  return third === "photos" ? { name: "event-photos", id: second } : NOT_FOUND;
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "events":
      return "/";
    case "event-new":
      return "/events/new";
    case "event":
      return `/events/${route.id}`;
    case "event-edit":
      return `/events/${route.id}/edit`;
    case "event-photos":
      return `/events/${route.id}/photos`;
    case "devices":
      return "/devices";
    case "audit":
      return "/audit";
    case "not-found":
      return "/404";
  }
}

const CHANGE = "admin:navigate";

/** Pushes a new history entry (none if it's the current path) and tells `useRoute`. */
export function navigate(path: string): void {
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo?.(0, 0);
}

/** The route for the current address. It re-renders on a change of query string too (the Audit view reads `?event=`). */
export function useRoute(): Route {
  const [path, setPath] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const update = () => setPath(location.pathname + location.search);
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    update();
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return parseRoute(path.split("?")[0]!);
}

/** A link that navigates in place; a modified click (new tab, new window) is left to the browser. */
export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a {...props} href={to} onClick={handle} />;
}
