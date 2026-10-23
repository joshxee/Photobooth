// Times show in the guest's own time zone, which at the event is the event's.
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const date = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** `localDate` is the event's calendar date (YYYY-MM-DD), not an instant. */
export function formatDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  return date.format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

export function photoCount(n: number): string {
  return n === 1 ? "1 photo" : `${n} photos`;
}
