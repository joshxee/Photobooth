// How the upload queue reads to the operator. Presentation only: Rust decides what is true.

import type { OutboxEntry, OutboxStatus, PortalStatus } from "../ipc/types";

export type BadgeTone = "ok" | "busy" | "offline" | "attention";

export interface Badge {
  tone: BadgeTone;
  text: string;
}

const needs = (n: number) => `${n} ${n === 1 ? "needs" : "need"} attention`;

/**
 * The operator's upload badge (camera picker), most urgent state first; low storage is added
 * to whatever else is true. `null` when there is nothing to say: still loading, or a booth
 * that isn't enrolled and has nothing queued.
 */
export function uploadBadge(outbox: OutboxStatus | null, portal: PortalStatus | null): Badge | null {
  if (!outbox || !portal) return null;
  const waiting = outbox.queued + outbox.uploading;
  if (!portal.enrolled && waiting + outbox.needs_attention === 0) return null;
  if (!outbox.available) return { tone: "attention", text: "Uploads unavailable on this booth" };

  let badge: Badge;
  if (outbox.revoked) {
    badge = { tone: "attention", text: "Uploads paused: the portal refused this booth" };
  } else if (outbox.needs_attention > 0) {
    badge = { tone: "attention", text: `Uploads: ${needs(outbox.needs_attention)}` };
  } else if (!portal.enrolled) {
    badge = { tone: "attention", text: `Uploads: ${waiting} waiting, booth not enrolled` };
  } else if (outbox.offline && waiting > 0) {
    badge = { tone: "offline", text: `Uploads: offline, ${waiting} waiting` };
  } else if (outbox.uploading > 0) {
    badge = { tone: "busy", text: `Uploads: sending, ${waiting} left` };
  } else if (outbox.queued > 0) {
    badge = { tone: "busy", text: `Uploads: ${outbox.queued} queued` };
  } else {
    badge = { tone: "ok", text: "Uploads: all sent" };
  }
  if (outbox.low_disk) badge = { tone: "attention", text: `${badge.text} · storage low` };
  return badge;
}

/** `52.0 GB`, `812 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** The first line of a needs-attention entry. */
export function entryTitle(entry: OutboxEntry): string {
  if (entry.session_id === null || entry.shot === null) return "Unreadable files";
  return `Session ${entry.session_id} · shot ${entry.shot}`;
}
