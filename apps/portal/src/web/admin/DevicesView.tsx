import { type FormEvent, useEffect, useRef, useState } from "react";
import type { AdminDevice } from "../../shared/schemas";
import { api, isNotAuthorised } from "./api";
import { useAdmin, useLoad } from "./env";
import { ConfirmDialog, Dialog, ErrorNote, Loading } from "./parts";
import { startRefresh } from "./refresh";
import { STALE_AFTER_MS, type Confirmation } from "./rules";
import { countdown, formatInZone, relativeTime } from "./time";

/** The one-time code on screen. It lives only in this state: closing the dialog drops it. */
interface Reveal {
  deviceName: string;
  code: string;
  expiresAtMs: number;
}

type Action = { kind: "reissue" | "revoke"; device: AdminDevice };

export function DevicesView() {
  const { env, onNotAuthorised } = useAdmin();
  const devices = useLoad(() => api.listDevices(), "devices");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // The health view keeps itself fresh while the page is visible.
  const reload = useRef(devices.reload);
  reload.current = devices.reload;
  useEffect(() => startRefresh({ env, load: () => reload.current() }), [env]);
  useEffect(() => {
    if (devices.data && devices.error == null) setUpdatedAt(env.now());
  }, [devices.data, devices.error, env]);

  const guard = (error: unknown) => {
    if (isNotAuthorised(error)) onNotAuthorised();
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) {
      setNameError("Enter a name of up to 100 characters, such as where the tablet lives.");
      return;
    }
    setNameError(null);
    setFailure(null);
    setCreating(true);
    try {
      const made = await api.createDevice(trimmed);
      setReveal({ deviceName: trimmed, code: made.code, expiresAtMs: Date.parse(made.expiresAt) });
      setName("");
      void devices.reload();
    } catch (error) {
      guard(error);
      setFailure(error);
    } finally {
      setCreating(false);
    }
  };

  const confirm = async () => {
    if (!action) return;
    setBusy(true);
    setActionFailure(null);
    try {
      if (action.kind === "reissue") {
        const made = await api.reissueCode(action.device.id);
        setReveal({ deviceName: action.device.name, code: made.code, expiresAtMs: Date.parse(made.expiresAt) });
      } else {
        await api.revokeDevice(action.device.id);
      }
      setAction(null);
      void devices.reload();
    } catch (error) {
      guard(error);
      setActionFailure(error);
      void devices.reload();
    } finally {
      setBusy(false);
    }
  };

  const reissueNow = async (device: AdminDevice) => {
    setFailure(null);
    try {
      const made = await api.reissueCode(device.id);
      setReveal({ deviceName: device.name, code: made.code, expiresAtMs: Date.parse(made.expiresAt) });
    } catch (error) {
      guard(error);
      setFailure(error);
    }
    void devices.reload();
  };

  const start = (kind: Action["kind"], device: AdminDevice) => {
    setActionFailure(null);
    // A fresh code for a booth that isn't enrolled yet hurts nothing; the others ask first.
    if (kind === "reissue" && device.enrolledAt === null) void reissueNow(device);
    else setAction({ kind, device });
  };

  const now = env.now();
  const list = devices.data?.devices ?? [];
  return (
    <section>
      <div className="head">
        <h1>Devices</h1>
        <p className="muted" role="status">
          {devices.error != null && updatedAt !== null
            ? `Couldn't refresh. Showing data from ${relativeTime(new Date(updatedAt).toISOString(), now)}.`
            : updatedAt !== null
              ? "Refreshes every 15 seconds while this page is open."
              : ""}
        </p>
      </div>

      <form onSubmit={create} noValidate className="form form--inline">
        <div className="field">
          <label htmlFor="device-name">New booth name</label>
          <input
            id="device-name"
            type="text"
            autoComplete="off"
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "device-name-error" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />
          {nameError && (
            <p className="field__error" id="device-name-error">
              {nameError}
            </p>
          )}
        </div>
        <button type="submit" className="btn btn--primary" disabled={creating}>
          {creating ? "Creating…" : "Create booth code"}
        </button>
      </form>
      {failure != null && <ErrorNote error={failure} />}

      {devices.loading && <Loading what="devices" />}
      {devices.error != null && !devices.data && <ErrorNote error={devices.error} />}
      {devices.data && list.length === 0 && <p className="muted">No booths yet. Create a code, then enter it in the booth's Settings → Guest Portal.</p>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Booth</th>
                <th scope="col">Status</th>
                <th scope="col">Last seen</th>
                <th scope="col">Waiting to upload</th>
                <th scope="col">App</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <DeviceRow key={d.id} device={d} now={now} onReissue={() => start("reissue", d)} onRevoke={() => start("revoke", d)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reveal && <CodeDialog reveal={reveal} onClose={() => setReveal(null)} />}
      {action && (
        <ConfirmDialog confirmation={confirmationFor(action)} busy={busy} error={actionFailure} onConfirm={() => void confirm()} onCancel={() => setAction(null)} />
      )}
    </section>
  );
}

function confirmationFor({ kind, device }: Action): Confirmation {
  if (kind === "revoke") {
    return {
      title: `Revoke ${device.name}?`,
      paragraphs: [
        "The booth is locked out immediately: its next request is refused and its pending code stops working.",
        "Photos waiting on the booth stay there; a new enrolment (a new code, entered on the booth) lets them upload.",
      ],
      confirmLabel: "Revoke booth",
      danger: true,
    };
  }
  return {
    title: `Make a new code for ${device.name}?`,
    paragraphs: [
      "This booth is already enrolled. It keeps working until the new code is entered on it; entering the code replaces its current credential, so use it to re-enrol a wiped tablet.",
      "Any earlier code stops working.",
    ],
    confirmLabel: "Make new code",
    danger: false,
  };
}

function DeviceRow({ device: d, now, onReissue, onRevoke }: { device: AdminDevice; now: number; onReissue(): void; onRevoke(): void }) {
  const revoked = d.revokedAt !== null;
  const enrolled = d.enrolledAt !== null;
  const stale = enrolled && !revoked && (d.lastSeenAt === null || now - Date.parse(d.lastSeenAt) > STALE_AFTER_MS);
  let status = "Waiting for a code";
  if (revoked) status = "Revoked";
  else if (enrolled) status = "Enrolled";
  else if (d.codeExpiresAt && Date.parse(d.codeExpiresAt) <= now) status = "Code expired";
  else if (d.codeExpiresAt) status = "Code not used yet";
  return (
    <tr className={revoked ? "row--deleted" : undefined}>
      <th scope="row">{d.name}</th>
      <td>
        <span className={`chip chip--${revoked ? "danger" : enrolled ? "ok" : "muted"}`}>{status}</span>
      </td>
      <td title={d.lastSeenAt ? formatInZone(d.lastSeenAt, "UTC") + " UTC" : undefined}>
        {relativeTime(d.lastSeenAt, now)}
        {stale && <div className="stale">Not heard from lately</div>}
      </td>
      <td className={d.lastBacklog ? "num backlog" : "num"}>{d.lastBacklog ?? "—"}</td>
      <td>{d.appVersion ?? "—"}</td>
      <td className="row-actions">
        {!revoked && (
          <>
            <button type="button" className="btn btn--small btn--secondary" onClick={onReissue}>
              {enrolled ? "New code" : "Re-issue code"}
              <span className="visually-hidden"> for {d.name}</span>
            </button>
            <button type="button" className="btn btn--small btn--secondary btn--caution" onClick={onRevoke}>
              Revoke<span className="visually-hidden"> {d.name}</span>
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

/** "ABCDEFGH" as "ABCD-EFGH", the way the booth's form accepts it. */
export function groupCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function CodeDialog({ reveal, onClose }: { reveal: Reveal; onClose(): void }) {
  const { env } = useAdmin();
  const [now, setNow] = useState(() => env.now());
  useEffect(() => {
    let timer: unknown;
    const tick = () => {
      setNow(env.now());
      timer = env.setTimeout(tick, 1000);
    };
    timer = env.setTimeout(tick, 1000);
    return () => env.clearTimeout(timer);
  }, [env]);
  const left = countdown(reveal.expiresAtMs, now);
  return (
    <Dialog title={`Enrolment code for ${reveal.deviceName}`} onClose={onClose}>
      {left.expired ? (
        <p className="error" role="status">
          This code has expired and is no longer shown. Close this and make a new code.
        </p>
      ) : (
        <>
          <p>
            Enter this code on the booth (Settings → Guest Portal). It works once.
          </p>
          <p className="code">
            {groupCode(reveal.code)}
          </p>
          <p role="timer" aria-live="off">
            Expires in <strong>{left.text}</strong>
          </p>
        </>
      )}
      <p className="hint">This is the only time the code is shown. It isn't stored anywhere: if you lose it, make a new one.</p>
      <div className="actions">
        <button type="button" className="btn btn--primary" data-autofocus onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
