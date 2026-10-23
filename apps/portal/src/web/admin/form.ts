// The event form (DESIGN §12): the admin types wall-clock times in the event's own time zone and
// the API stores UTC. The form state is plain strings; `validate*` turns them into the API body
// or a message per field. An edit sends only the fields that changed (the audit row lists them).
import type { AdminEvent, EventCreateRequest, EventUpdateRequest } from "../../shared/schemas";
import { type LocalToUtc, localToUtc, timeZones, utcToLocal } from "./time";

export interface EventForm {
  name: string;
  venue: string;
  timezone: string;
  /** `YYYY-MM-DDTHH:mm`, the zone's wall clock (a `datetime-local` value). */
  startsLocal: string;
  endsLocal: string;
  photoLimit: string;
}

export type FormField = keyof EventForm;
export type FormErrors = Partial<Record<FormField, string>>;

export const DEFAULT_TIME_ZONE = "Pacific/Auckland";
export const DEFAULT_PHOTO_LIMIT = 2000;

/** A new event: starts at the next whole hour and runs four hours. */
export function defaultForm(nowMs: number, timezone = DEFAULT_TIME_ZONE): EventForm {
  const start = Math.ceil((nowMs + 1) / 3_600_000) * 3_600_000;
  return {
    name: "",
    venue: "",
    timezone,
    startsLocal: utcToLocal(new Date(start).toISOString(), timezone),
    endsLocal: utcToLocal(new Date(start + 4 * 3_600_000).toISOString(), timezone),
    photoLimit: String(DEFAULT_PHOTO_LIMIT),
  };
}

export function formFromEvent(e: AdminEvent): EventForm {
  return {
    name: e.name,
    venue: e.venue,
    timezone: e.timezone,
    startsLocal: utcToLocal(e.startsAt, e.timezone),
    endsLocal: utcToLocal(e.endsAt, e.timezone),
    photoLimit: String(e.photoLimit),
  };
}

type Parsed =
  | { ok: true; name: string; venue: string; timezone: string; startsAt: string; endsAt: string; photoLimit: number }
  | { ok: false; errors: FormErrors };

/**
 * With `existing`, a time the admin didn't touch keeps its stored instant: re-deriving it from the
 * wall-clock string would drop its seconds and, for the repeated hour when the clocks go back, pick
 * the first occurrence instead of the second.
 */
function parse(form: EventForm, existing?: AdminEvent): Parsed {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (name.length < 1 || name.length > 100) errors.name = "Enter a name of up to 100 characters.";
  if (form.venue.length > 100) errors.venue = "The venue can be up to 100 characters.";
  if (!timeZones().includes(form.timezone)) errors.timezone = "Choose a time zone.";
  const photoLimit = /^\d+$/.test(form.photoLimit.trim()) ? Number(form.photoLimit.trim()) : NaN;
  // A stored limit of 0 (the schema allows it) stays saveable as it is.
  if (!(photoLimit >= 1 && photoLimit <= 10_000) && photoLimit !== existing?.photoLimit) errors.photoLimit = "Enter a whole number from 1 to 10,000.";

  const was = existing ? formFromEvent(existing) : null;
  const untouched = (field: "startsLocal" | "endsLocal") => existing && was && form.timezone === existing.timezone && form[field] === was[field];
  const starts: LocalToUtc | null = errors.timezone ? null : untouched("startsLocal") ? { ok: true, iso: existing!.startsAt } : localToUtc(form.startsLocal, form.timezone);
  const ends: LocalToUtc | null = errors.timezone ? null : untouched("endsLocal") ? { ok: true, iso: existing!.endsAt } : localToUtc(form.endsLocal, form.timezone);
  if (starts && !starts.ok) errors.startsLocal = starts.reason;
  if (ends && !ends.ok) errors.endsLocal = ends.reason;
  if (starts?.ok && ends?.ok && Date.parse(ends.iso) < Date.parse(starts.iso)) errors.endsLocal = "The end must be after the start.";

  if (Object.keys(errors).length > 0 || !starts?.ok || !ends?.ok) return { ok: false, errors };
  return { ok: true, name, venue: form.venue, timezone: form.timezone, startsAt: starts.iso, endsAt: ends.iso, photoLimit };
}

export type CreateResult = { ok: true; body: EventCreateRequest } | { ok: false; errors: FormErrors };

export function validateCreate(form: EventForm): CreateResult {
  const p = parse(form);
  if (!p.ok) return p;
  return { ok: true, body: { name: p.name, venue: p.venue, timezone: p.timezone, startsAt: p.startsAt, endsAt: p.endsAt, photoLimit: p.photoLimit } };
}

export type UpdateResult = { ok: true; body: EventUpdateRequest } | { ok: false; errors: FormErrors; nothing?: true };

export function validateUpdate(form: EventForm, existing: AdminEvent): UpdateResult {
  const p = parse(form, existing);
  if (!p.ok) return p;
  const body: EventUpdateRequest = {};
  if (p.name !== existing.name) body.name = p.name;
  if (p.venue !== existing.venue) body.venue = p.venue;
  if (p.timezone !== existing.timezone) body.timezone = p.timezone;
  if (p.startsAt !== existing.startsAt) body.startsAt = p.startsAt;
  if (p.endsAt !== existing.endsAt) body.endsAt = p.endsAt;
  if (p.photoLimit !== existing.photoLimit) body.photoLimit = p.photoLimit;
  if (Object.keys(body).length === 0) return { ok: false, errors: {}, nothing: true };
  return { ok: true, body };
}
