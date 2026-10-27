// Time zone and time display helpers for the admin forms. Events are stored in UTC with an IANA
// zone; the admin types local wall-clock times, so the conversion needs the zone's offset on that
// day (daylight saving included). Built on Intl only: no date library.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in a zone. */
function fieldsAt(ms: number, timeZone: string): Fields & { second: number } {
  const v: Record<string, number> = {};
  for (const p of zoneFormat(timeZone).formatToParts(new Date(ms))) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { year: v.year!, month: v.month!, day: v.day!, hour: v.hour!, minute: v.minute!, second: v.second! };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetAt(ms: number, timeZone: string): number {
  const f = fieldsAt(ms, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The value for a `datetime-local` input: the instant's wall-clock time in the zone. */
export function utcToLocal(iso: string, timeZone: string): string {
  const f = fieldsAt(Date.parse(iso), timeZone);
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

export type LocalToUtc = { ok: true; iso: string } | { ok: false; reason: string };

/**
 * A wall-clock time in an IANA zone to a UTC instant (`toISOString()` form, which the API
 * requires). A time the clocks skip is refused; a time they repeat takes the first occurrence.
 */
export function localToUtc(local: string, timeZone: string): LocalToUtc {
  const m = LOCAL.exec(local);
  if (!m) return { ok: false, reason: "Enter a date and time." };
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(naive);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    return { ok: false, reason: "That isn't a real date and time." };
  }
  try {
    zoneFormat(timeZone);
  } catch {
    return { ok: false, reason: "Choose a time zone." };
  }
  // The offset before and after the guess; try each (earlier instant first) and keep the one
  // that reads back as the typed wall-clock time.
  const candidates = [naive - offsetAt(naive - 86_400_000, timeZone), naive - offsetAt(naive + 86_400_000, timeZone)].sort((a, b) => a - b);
  for (const ms of candidates) {
    if (utcToLocal(new Date(ms).toISOString(), timeZone) === local) return { ok: true, iso: new Date(ms).toISOString() };
  }
  return { ok: false, reason: "That time doesn't exist in this time zone (the clocks go forward)." };
}

/** `20 Dec 2026, 14:30` in the zone. */
export function formatInZone(iso: string, timeZone: string): string {
  const f = fieldsAt(Date.parse(iso), timeZone);
  return `${f.day} ${MONTHS[f.month - 1]} ${f.year}, ${pad(f.hour)}:${pad(f.minute)}`;
}

/** `20 Dec 2026` in the zone. */
export function formatDay(iso: string, timeZone: string): string {
  const f = fieldsAt(Date.parse(iso), timeZone);
  return `${f.day} ${MONTHS[f.month - 1]} ${f.year}`;
}

/** "3 min ago" for the devices table. A clock slightly ahead of ours reads as just now. */
export function relativeTime(iso: string | null, nowMs: number): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Time left until `deadlineMs` as `m:ss`; expired at the deadline itself. */
export function countdown(deadlineMs: number, nowMs: number): { expired: boolean; text: string } {
  const left = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  return { expired: left === 0, text: `${Math.floor(left / 60)}:${pad(left % 60)}` };
}

const FALLBACK_ZONES = ["Pacific/Auckland", "Australia/Sydney", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"];

/** Every IANA zone the browser knows, UTC first so it is always selectable. */
export function timeZones(): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = FALLBACK_ZONES;
  }
  return ["UTC", ...zones.filter((z) => z !== "UTC")];
}
