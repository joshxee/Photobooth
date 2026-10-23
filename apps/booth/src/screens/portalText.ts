// How the portal state reads to the operator. Presentation only: Rust decides what is true.

import type { PortalStatus, SelectedEvent } from "../ipc/types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `2026-10-22` → `Thu 22 Oct 2026`. The date is already the event's own (no time zone to
 * apply), so it is read as a calendar date, not converted. Anything else is shown as given.
 */
export function formatLocalDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return localDate;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return localDate;
  return `${WEEKDAYS[date.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export const eventLine = (event: SelectedEvent): string =>
  `${event.name} · ${formatLocalDate(event.local_date)}`;

/** The operator status line on the camera picker. */
export function portalSummary(status: PortalStatus | null): string {
  if (!status) return "Portal: checking…";
  if (status.problem) return "Portal: enrolment needs attention (see Settings)";
  if (!status.enrolled) return "Portal: not enrolled";
  if (!status.selected_event) return "Portal: no event selected (photos stay on the SD card)";
  return `Portal: ${eventLine(status.selected_event)}`;
}
