import { describe, expect, test } from "bun:test";

import { enrolledStatus, outboxStatus, portalStatus, SMITH, stoppedUpload } from "../test/ipc";
import { entryTitle, formatBytes, uploadBadge } from "./uploadText";

const enrolled = enrolledStatus({ selected_event: SMITH });

describe("upload badge", () => {
  test("nothing to say until both statuses are known, or for an idle unenrolled booth", () => {
    expect(uploadBadge(null, enrolled)).toBeNull();
    expect(uploadBadge(outboxStatus(), null)).toBeNull();
    expect(uploadBadge(outboxStatus(), portalStatus())).toBeNull();
  });

  test("each state, most urgent first", () => {
    expect(uploadBadge(outboxStatus(), enrolled)).toEqual({
      tone: "ok",
      text: "Uploads: all sent",
    });
    expect(uploadBadge(outboxStatus({ queued: 3 }), enrolled)).toEqual({
      tone: "busy",
      text: "Uploads: 3 queued",
    });
    expect(uploadBadge(outboxStatus({ queued: 3, uploading: 2 }), enrolled)).toEqual({
      tone: "busy",
      text: "Uploads: sending, 5 left",
    });
    expect(uploadBadge(outboxStatus({ queued: 4, offline: true }), enrolled)).toEqual({
      tone: "offline",
      text: "Uploads: offline, 4 waiting",
    });
    expect(
      uploadBadge(outboxStatus({ queued: 4, offline: true, needs_attention: 1 }), enrolled),
    ).toEqual({ tone: "attention", text: "Uploads: 1 needs attention" });
    expect(uploadBadge(outboxStatus({ needs_attention: 2 }), enrolled)?.text).toBe(
      "Uploads: 2 need attention",
    );
    expect(
      uploadBadge(outboxStatus({ queued: 4, needs_attention: 2, revoked: true }), enrolled),
    ).toEqual({ tone: "attention", text: "Uploads paused: the portal refused this booth" });
  });

  test("low storage is added to whatever else is true", () => {
    expect(uploadBadge(outboxStatus({ queued: 1, low_disk: true }), enrolled)).toEqual({
      tone: "attention",
      text: "Uploads: 1 queued · storage low",
    });
  });

  test("shots waiting on a booth that isn't enrolled any more", () => {
    expect(uploadBadge(outboxStatus({ queued: 2 }), portalStatus())).toEqual({
      tone: "attention",
      text: "Uploads: 2 waiting, booth not enrolled",
    });
  });

  test("a booth whose outbox couldn't open says so", () => {
    expect(uploadBadge(outboxStatus({ available: false }), enrolled)).toEqual({
      tone: "attention",
      text: "Uploads unavailable on this booth",
    });
  });
});

describe("upload text", () => {
  test("bytes read as GB or MB", () => {
    expect(formatBytes(52_000_000_000)).toBe("52.0 GB");
    expect(formatBytes(812_000_000)).toBe("812 MB");
    expect(formatBytes(0)).toBe("0 MB");
  });

  test("an entry is named by its session and shot", () => {
    expect(entryTitle(stoppedUpload())).toBe("Session 6a3f1c20-3 · shot 2");
    expect(entryTitle(stoppedUpload({ kind: "damaged", session_id: null, shot: null }))).toBe(
      "Unreadable files",
    );
  });
});
