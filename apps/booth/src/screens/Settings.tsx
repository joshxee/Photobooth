import { useState } from "react";

import { settingsSet, TEST_PATTERNS, type SettingsPatch } from "../ipc";
import { errorMessage } from "../store/bridge";
import { useBooth } from "../store/store";

/** Applies a patch via the backend (which validates and persists) and mirrors the result. */
async function apply(patch: SettingsPatch): Promise<void> {
  try {
    useBooth.getState().setSettings(await settingsSet(patch));
  } catch (error) {
    useBooth.getState().setNotice(errorMessage(error));
  }
}

function SliderRow({
  label,
  value,
  min,
  max,
  suffix = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="setting">
      <label className="setting__label">
        <span>{label}</span>
        <span className="setting__value">
          {value}
          {suffix}
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.currentTarget.value))}
        />
      </label>
    </div>
  );
}

function TextRow({
  label,
  value,
  maxLength,
  onCommit,
}: {
  label: string;
  value: string;
  maxLength: number;
  onCommit: (value: string) => void;
}) {
  // Edit locally; commit on blur or Enter so every keystroke is not a backend round trip.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className="setting">
      <label className="setting__label">
        <span>{label}</span>
        <input
          type="text"
          value={shown}
          maxLength={maxLength}
          aria-label={label}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      </label>
    </div>
  );
}

export function Settings() {
  const settings = useBooth((s) => s.settings);

  if (!settings) {
    return (
      <main className="settings">
        <p role="status">Loading settings…</p>
      </main>
    );
  }

  const test = settings.test_mode;
  return (
    <main className="settings">
      <header className="settings__header">
        <button
          type="button"
          className="icon-button"
          aria-label="Back"
          onClick={() => useBooth.getState().setScreen("select")}
        >
          ←
        </button>
        <h1>Settings</h1>
      </header>

      <div className="settings__body">
        <SliderRow
          label="Number of Photos"
          value={settings.number_of_photos}
          min={1}
          max={10}
          onChange={(v) => void apply({ number_of_photos: v })}
        />
        <SliderRow
          label="Countdown Seconds"
          value={settings.countdown_seconds}
          min={1}
          max={10}
          suffix="s"
          onChange={(v) => void apply({ countdown_seconds: v })}
        />
        <SliderRow
          label="Photo Strip Display Time"
          value={settings.strip_display_seconds}
          min={5}
          max={30}
          suffix="s"
          onChange={(v) => void apply({ strip_display_seconds: v })}
        />
        <TextRow
          label="Headline"
          value={settings.headline}
          maxLength={80}
          onCommit={(v) => void apply({ headline: v })}
        />
        <TextRow
          label="Event Date"
          value={settings.event_date}
          maxLength={32}
          onCommit={(v) => void apply({ event_date: v })}
        />
        <div className="setting">
          <label className="setting__label setting__label--row">
            <span>Mirror Preview</span>
            <input
              type="checkbox"
              checked={settings.mirror_preview}
              aria-label="Mirror Preview"
              onChange={(e) => void apply({ mirror_preview: e.currentTarget.checked })}
            />
          </label>
        </div>

        {settings.selected_camera === "test" && (
          <fieldset className="settings__group">
            <legend>Test Camera</legend>
            <SliderRow
              label="Capture Delay (ms)"
              value={test.capture_delay_ms}
              min={0}
              max={5000}
              onChange={(v) => void apply({ test_mode: { capture_delay_ms: v } })}
            />
            <SliderRow
              label="Fail Every Nth Capture (0 = never)"
              value={test.fail_every_n}
              min={0}
              max={10}
              onChange={(v) => void apply({ test_mode: { fail_every_n: v } })}
            />
            <div className="setting">
              <label className="setting__label">
                <span>Test Pattern</span>
                <select
                  value={test.pattern}
                  aria-label="Test Pattern"
                  onChange={(e) => void apply({ test_mode: { pattern: e.currentTarget.value } })}
                >
                  {TEST_PATTERNS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
        )}

        <section className="settings__summary" aria-label="Current Configuration">
          <h2>Current Configuration</h2>
          <ul>
            <li>• {settings.number_of_photos} photos per session</li>
            <li>• {settings.countdown_seconds} second countdown</li>
            <li>• Photo strip displays for {settings.strip_display_seconds} seconds</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
