import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useAdmin, useLoad } from "./env";
import { type EventForm, type FormErrors, type FormField, defaultForm, formFromEvent, validateCreate, validateUpdate } from "./form";
import { Link, navigate } from "./nav";
import { ErrorNote, Loading } from "./parts";
import { formatDay, timeZones } from "./time";

/** Create (no `id`) or edit (an `id`) an event. The times are wall-clock times in the chosen zone. */
export function EventFormView({ id }: { id?: string }) {
  const { env } = useAdmin();
  const loaded = useLoad(() => (id ? api.getEvent(id) : Promise.resolve(null)), id ?? "new");
  const [form, setForm] = useState<EventForm | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(timeZones, []);

  const existing = loaded.data;
  useEffect(() => {
    if (!loaded.loading && loaded.error == null) setForm(existing ? formFromEvent(existing) : defaultForm(env.now()));
  }, [loaded.loading, loaded.error, existing, env]);

  if (loaded.loading || (!form && loaded.error == null)) return <Loading what="event" />;
  if (loaded.error != null) return <ErrorNote error={loaded.error} />;
  if (!form) return null;
  if (existing && existing.deletedAt !== null) {
    return (
      <section>
        <h1>{existing.name}</h1>
        <p className="muted">A deleted event can only be restored.</p>
        <Link to={`/events/${existing.id}`}>Back to the event</Link>
      </section>
    );
  }

  const set = (field: FormField, value: string) => {
    setForm({ ...form, [field]: value });
    setErrors((e) => ({ ...e, [field]: undefined }));
    setNotice(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    setNotice(null);
    setBusy(true);
    try {
      if (existing) {
        const result = validateUpdate(form, existing);
        if (!result.ok) {
          setErrors(result.errors);
          if (result.nothing) setNotice("Nothing has changed.");
          return;
        }
        setErrors({});
        await api.updateEvent(existing.id, result.body);
        navigate(`/events/${existing.id}`);
      } else {
        const result = validateCreate(form);
        if (!result.ok) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        const created = await api.createEvent(result.body);
        navigate(`/events/${created.id}`);
      }
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  const field = (name: FormField) => ({
    id: `f-${name}`,
    value: form[name],
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `e-${name}` : undefined,
    onChange: (ev: { target: { value: string } }) => set(name, ev.target.value),
  });
  const message = (name: FormField) =>
    errors[name] ? (
      <p className="field__error" id={`e-${name}`}>
        {errors[name]}
      </p>
    ) : null;

  return (
    <section>
      <h1>{existing ? `Edit ${existing.name}` : "New event"}</h1>
      <form onSubmit={submit} noValidate className="form">
        <div className="field">
          <label htmlFor="f-name">Name</label>
          <input type="text" autoComplete="off" {...field("name")} />
          {message("name")}
        </div>
        <div className="field">
          <label htmlFor="f-venue">Venue (optional)</label>
          <input type="text" autoComplete="off" {...field("venue")} />
          {message("venue")}
        </div>
        <div className="field">
          <label htmlFor="f-timezone">Time zone</label>
          <select {...field("timezone")}>
            {(zones.includes(form.timezone) ? zones : [form.timezone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p className="hint">The start and end below are the clock time in this zone. Photos are dated by it.</p>
          {message("timezone")}
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="f-startsLocal">Starts</label>
            <input type="datetime-local" {...field("startsLocal")} />
            {message("startsLocal")}
          </div>
          <div className="field">
            <label htmlFor="f-endsLocal">Ends</label>
            <input type="datetime-local" {...field("endsLocal")} />
            {message("endsLocal")}
          </div>
        </div>
        <div className="field">
          <label htmlFor="f-photoLimit">Photo limit</label>
          <input type="text" inputMode="numeric" autoComplete="off" {...field("photoLimit")} />
          <p className="hint">
            Uploads stop after this many photos (1 to 10,000).
            {existing && ` Uploads close for good on ${formatDay(existing.uploadsUntil, existing.timezone)}, 90 days after the event ends; photos are kept until the event is deleted.`}
          </p>
          {message("photoLimit")}
        </div>
        {notice && (
          <p className="muted" role="status">
            {notice}
          </p>
        )}
        {failure != null && <ErrorNote error={failure} />}
        <div className="actions">
          <Link to={existing ? `/events/${existing.id}` : "/"} className="btn btn--secondary">
            Cancel
          </Link>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "Saving…" : existing ? "Save changes" : "Create event"}
          </button>
        </div>
      </form>
    </section>
  );
}
