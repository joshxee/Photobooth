import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuditView } from "./AuditView";
import { DevicesView } from "./DevicesView";
import { EventDetail } from "./EventDetail";
import { EventFormView } from "./EventFormView";
import { EventsList } from "./EventsList";
import { PhotosView } from "./PhotosView";
import { Mark } from "../ui/icons";
import { type AdminEnv, AdminProvider, browserAdminEnv } from "./env";
import { Link, type Route, useRoute } from "./nav";

const TITLES: Record<Route["name"], string> = {
  events: "Events",
  "event-new": "New event",
  event: "Event",
  "event-edit": "Edit event",
  "event-photos": "Event photos",
  devices: "Devices",
  audit: "Audit",
  "not-found": "Not found",
};

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "events":
      return <EventsList />;
    case "event-new":
      return <EventFormView />;
    case "event":
      return <EventDetail id={route.id} />;
    case "event-edit":
      return <EventFormView id={route.id} />;
    case "event-photos":
      return <PhotosView id={route.id} />;
    case "devices":
      return <DevicesView />;
    case "audit":
      return <AuditView />;
    case "not-found":
      return (
        <section>
          <h1>Page not found</h1>
          <p>
            <Link to="/">Back to events</Link>
          </p>
        </section>
      );
  }
}

function NotAuthorised() {
  return (
    <section>
      <h1>Not authorised</h1>
      <p>This account isn't allowed to use the admin portal. Sign in with a different account, or ask the owner to add you.</p>
    </section>
  );
}

export function App({ env = browserAdminEnv }: { env?: AdminEnv }) {
  const route = useRoute();
  const [denied, setDenied] = useState(false);
  const onNotAuthorised = useCallback(() => setDenied(true), []);
  const context = useMemo(() => ({ env, onNotAuthorised }), [env, onNotAuthorised]);
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  const section = route.name.startsWith("event") ? "events" : route.name;
  useEffect(() => {
    document.title = `${denied ? "Not authorised" : TITLES[route.name]} · Photobooth Admin`;
    // After a navigation the keyboard starts at the new page, not where the link was.
    if (first.current) first.current = false;
    else main.current?.focus();
  }, [route.name, denied]);

  return (
    <AdminProvider value={context}>
      <div className="shell">
        <header className="bar">
          <Link to="/" className="brand">
            <Mark size={20} />
            <span>Photobooth Admin</span>
          </Link>
          {!denied && (
            <nav aria-label="Main">
              <Link to="/" aria-current={section === "events" ? "page" : undefined}>
                Events
              </Link>
              <Link to="/devices" aria-current={section === "devices" ? "page" : undefined}>
                Devices
              </Link>
              <Link to="/audit" aria-current={section === "audit" ? "page" : undefined}>
                Audit
              </Link>
            </nav>
          )}
        </header>
        <main ref={main} tabIndex={-1}>
          {denied ? <NotAuthorised /> : <View key={"id" in route ? `${route.name}:${route.id}` : route.name === "audit" ? `audit${location.search}` : route.name} route={route} />}
        </main>
      </div>
    </AdminProvider>
  );
}
