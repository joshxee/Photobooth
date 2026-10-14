import { useEffect, useState } from "react";

import { logsRecent, testInject, type Fault } from "../ipc";
import { errorMessage } from "../store/bridge";
import { useBooth } from "../store/store";

const ACTIONS: { label: string; fault: Fault }[] = [
  { label: "Start session", fault: { kind: "start_session" } },
  { label: "Skip countdown", fault: { kind: "skip_countdown" } },
  { label: "Fail next capture", fault: { kind: "fail_next_capture" } },
  { label: "Disconnect camera", fault: { kind: "disconnect_camera" } },
  { label: "Slow next capture (5 s)", fault: { kind: "slow_next_capture", ms: 5000 } },
  { label: "Palm in the box (5 s)", fault: { kind: "hold_palm", on: true } },
  { label: "Palm away", fault: { kind: "hold_palm", on: false } },
  { label: "Reset settings", fault: { kind: "reset_settings" } },
];

/**
 * Fault injection for the test camera. It only appears when the backend accepts the dev
 * capability (a release build rejects it), so guests can never reach it.
 */
export function DevPanel() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const log = useBooth((s) => s.eventLog);

  useEffect(() => {
    let alive = true;
    logsRecent(1)
      .then(() => alive && setEnabled(true))
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled) return null;

  const inject = (fault: Fault) =>
    void testInject(fault).catch((e) => useBooth.getState().setNotice(errorMessage(e)));

  if (!open) {
    return (
      <button type="button" className="dev__toggle" onClick={() => setOpen(true)}>
        Dev
      </button>
    );
  }

  return (
    <aside className="dev" aria-label="Developer panel">
      <header className="dev__header">
        <strong>Developer panel</strong>
        <button type="button" className="dev__close" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>
      <div className="dev__actions">
        {ACTIONS.map(({ label, fault }) => (
          <button key={label} type="button" onClick={() => inject(fault)}>
            {label}
          </button>
        ))}
      </div>
      <ol className="dev__log" aria-label="Event log">
        {log
          .slice(-14)
          .reverse()
          .map((entry) => (
            <li key={entry.id}>
              <span className="dev__kind">{entry.kind}</span> {entry.text}
            </li>
          ))}
      </ol>
    </aside>
  );
}
