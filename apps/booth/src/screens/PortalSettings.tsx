// The operator's portal section in Settings: enrol the booth, pick the event photos go to,
// unenrol. Every decision (URL rules, the OPEN check, where the credential lives) is in Rust;
// this only asks for confirmation and shows what Rust answers.

import { useState } from "react";

import {
  portalClearEvent,
  portalEnrol,
  portalEvents,
  portalSelectEvent,
  portalUnenrol,
  type PortalEvent,
  type PortalStatus,
} from "../ipc";
import { errorMessage } from "../store/bridge";
import { useBooth } from "../store/store";
import { eventLine, formatLocalDate } from "./portalText";

type View =
  | { kind: "main" }
  | { kind: "events"; events: PortalEvent[] }
  | { kind: "confirm"; event: PortalEvent }
  | { kind: "unenrol" };

const MAIN: View = { kind: "main" };

/** Runs a portal command; its status goes to the store, a refusal becomes a notice. */
async function run(command: () => Promise<PortalStatus>): Promise<boolean> {
  try {
    useBooth.getState().setPortal(await command());
    return true;
  } catch (error) {
    useBooth.getState().setNotice(errorMessage(error));
    return false;
  }
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder?: string;
}) {
  return (
    <div className="setting">
      <label className="setting__label">
        <span>{label}</span>
        <input
          type="text"
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label={label}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      </label>
    </div>
  );
}

function EnrolForm({ status }: { status: PortalStatus }) {
  const [url, setUrl] = useState(status.portal_url);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = url.trim() !== "" && code.trim() !== "" && name.trim() !== "" && !busy;

  const enrol = async () => {
    setBusy(true);
    await run(() => portalEnrol({ url, code, name }));
    setBusy(false);
  };

  return (
    <>
      <p className="portal__state">Not enrolled</p>
      <p className="portal__hint">
        Create a device in the admin portal, then enter its one-time code here.
      </p>
      <Field label="Portal address" value={url} onChange={setUrl} maxLength={1024} />
      <Field label="Enrolment code" value={code} onChange={setCode} maxLength={32} />
      <Field
        label="Booth name"
        value={name}
        onChange={setName}
        maxLength={100}
        placeholder="Booth 1"
      />
      <div className="portal__actions">
        <button
          type="button"
          className="pill pill--medium"
          disabled={!ready}
          onClick={() => void enrol()}
        >
          {busy ? "Enrolling…" : "Enrol booth"}
        </button>
      </div>
    </>
  );
}

function Enrolled({
  status,
  setView,
}: {
  status: PortalStatus;
  setView: (view: View) => void;
}) {
  const [busy, setBusy] = useState(false);
  const selected = status.selected_event;

  const chooseEvent = async () => {
    setBusy(true);
    try {
      setView({ kind: "events", events: await portalEvents() });
    } catch (error) {
      useBooth.getState().setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <dl className="portal__facts">
        <dt>Booth</dt>
        <dd>{status.device_name}</dd>
        <dt>Portal</dt>
        <dd>{status.portal_host}</dd>
        <dt>Event</dt>
        <dd>{selected ? eventLine(selected) : "No event selected"}</dd>
      </dl>
      <div className="portal__actions">
        <button
          type="button"
          className="pill pill--medium"
          disabled={busy}
          onClick={() => void chooseEvent()}
        >
          {selected ? "Change event" : "Choose event"}
        </button>
        {selected && (
          <button
            type="button"
            className="pill pill--medium pill--outline"
            disabled={busy}
            onClick={() => void run(portalClearEvent)}
          >
            Clear event
          </button>
        )}
        <button
          type="button"
          className="pill pill--medium pill--outline"
          disabled={busy}
          onClick={() => setView({ kind: "unenrol" })}
        >
          Unenrol booth
        </button>
      </div>
    </>
  );
}

function EventList({
  events,
  setView,
}: {
  events: PortalEvent[];
  setView: (view: View) => void;
}) {
  return (
    <>
      <h3 className="portal__title">Open events</h3>
      {events.length === 0 ? (
        <p className="portal__hint">
          No events are open for uploads. Open one in the admin portal.
        </p>
      ) : (
        <ul className="select__list">
          {events.map((event) => (
            <li key={event.id}>
              <button
                type="button"
                className="card"
                onClick={() => setView({ kind: "confirm", event })}
              >
                <span className="card__name">{event.name}</span>
                <span className="card__desc">
                  {[event.venue, formatLocalDate(event.local_date)].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="portal__actions">
        <button type="button" className="pill pill--medium pill--outline" onClick={() => setView(MAIN)}>
          Back to portal
        </button>
      </div>
    </>
  );
}

function ConfirmEvent({
  event,
  current,
  setView,
}: {
  event: PortalEvent;
  current: PortalStatus["selected_event"];
  setView: (view: View) => void;
}) {
  const [busy, setBusy] = useState(false);
  const switching = current !== null && current.id !== event.id;

  const select = async () => {
    setBusy(true);
    const ok = await run(() => portalSelectEvent(event.id));
    setBusy(false);
    if (ok) setView(MAIN);
  };

  return (
    <div className="portal__confirm">
      <h3 className="portal__title">{switching ? "Switch event?" : "Use this event?"}</h3>
      <p className="portal__event-name">{event.name}</p>
      <p className="portal__event-date">{formatLocalDate(event.local_date)}</p>
      {event.venue && <p className="portal__hint">{event.venue}</p>}
      <p>Photos from this booth will appear in this event's gallery.</p>
      {switching && current && (
        <>
          <p className="portal__hint">{`Now: ${eventLine(current)}`}</p>
          <p className="portal__hint">
            Photos already taken stay with the event they were taken for.
          </p>
        </>
      )}
      <div className="portal__actions">
        <button
          type="button"
          className="pill pill--medium"
          disabled={busy}
          onClick={() => void select()}
        >
          {switching ? "Switch to this event" : "Use this event"}
        </button>
        <button
          type="button"
          className="pill pill--medium pill--outline"
          disabled={busy}
          onClick={() => setView(MAIN)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ConfirmUnenrol({ setView }: { setView: (view: View) => void }) {
  const [busy, setBusy] = useState(false);

  const unenrol = async () => {
    setBusy(true);
    const ok = await run(portalUnenrol);
    setBusy(false);
    if (ok) setView(MAIN);
  };

  return (
    <div className="portal__confirm">
      <h3 className="portal__title">Unenrol this booth?</h3>
      <p>
        The booth forgets its portal credential and stops sending photos. To send photos again,
        enrol it with a new code from the admin portal.
      </p>
      <div className="portal__actions">
        <button
          type="button"
          className="pill pill--medium"
          disabled={busy}
          onClick={() => void unenrol()}
        >
          Unenrol
        </button>
        <button
          type="button"
          className="pill pill--medium pill--outline"
          disabled={busy}
          onClick={() => setView(MAIN)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function PortalSettings() {
  const status = useBooth((s) => s.portal);
  const [view, setView] = useState<View>(MAIN);

  let body;
  if (!status) {
    body = <p role="status">Checking the portal…</p>;
  } else if (view.kind === "unenrol") {
    body = <ConfirmUnenrol setView={setView} />;
  } else if (status.problem) {
    body = (
      <>
        <p className="portal__problem" role="alert">
          {status.problem}
        </p>
        <div className="portal__actions">
          <button
            type="button"
            className="pill pill--medium"
            onClick={() => void run(portalUnenrol)}
          >
            Remove enrolment
          </button>
        </div>
      </>
    );
  } else if (!status.enrolled) {
    body = <EnrolForm status={status} />;
  } else if (view.kind === "events") {
    body = <EventList events={view.events} setView={setView} />;
  } else if (view.kind === "confirm") {
    body = <ConfirmEvent event={view.event} current={status.selected_event} setView={setView} />;
  } else {
    body = <Enrolled status={status} setView={setView} />;
  }

  return (
    <fieldset className="settings__group portal">
      <legend>Guest Portal</legend>
      {body}
    </fieldset>
  );
}
