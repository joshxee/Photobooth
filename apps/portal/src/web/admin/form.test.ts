import { describe, expect, it } from "bun:test";
import { defaultForm, formFromEvent, validateCreate, validateUpdate, type EventForm } from "./form";
import { NOW, event } from "./testing";

const valid: EventForm = {
  name: "  Smith wedding ",
  venue: "Town Hall",
  timezone: "Pacific/Auckland",
  startsLocal: "2026-12-20T14:30",
  endsLocal: "2026-12-20T22:00",
  photoLimit: "2000",
};

describe("create form", () => {
  it("converts the local times in the event's zone to UTC and trims the name", () => {
    expect(validateCreate(valid)).toEqual({
      ok: true,
      body: {
        name: "Smith wedding",
        venue: "Town Hall",
        timezone: "Pacific/Auckland",
        startsAt: "2026-12-20T01:30:00.000Z",
        endsAt: "2026-12-20T09:00:00.000Z",
        photoLimit: 2000,
      },
    });
  });

  it("converts again when the zone changes: the same wall-clock time is a different instant", () => {
    const result = validateCreate({ ...valid, timezone: "America/New_York" });
    expect(result.ok && result.body.startsAt).toBe("2026-12-20T19:30:00.000Z");
  });

  it("requires a name of 1 to 100 characters", () => {
    expect(validateCreate({ ...valid, name: "   " })).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(validateCreate({ ...valid, name: "x".repeat(101) })).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(validateCreate({ ...valid, name: "x".repeat(100) }).ok).toBe(true);
  });

  it("limits the venue to 100 characters but allows none", () => {
    expect(validateCreate({ ...valid, venue: "v".repeat(101) })).toMatchObject({ ok: false, errors: { venue: expect.any(String) } });
    expect(validateCreate({ ...valid, venue: "" }).ok).toBe(true);
  });

  it("refuses an end before the start, on the end field", () => {
    expect(validateCreate({ ...valid, endsLocal: "2026-12-20T14:00" })).toMatchObject({ ok: false, errors: { endsLocal: expect.stringContaining("after") } });
  });

  it("allows an end equal to the start (the API does)", () => {
    expect(validateCreate({ ...valid, endsLocal: valid.startsLocal }).ok).toBe(true);
  });

  it("refuses missing times and says which", () => {
    const result = validateCreate({ ...valid, startsLocal: "", endsLocal: "" });
    expect(result).toMatchObject({ ok: false, errors: { startsLocal: expect.any(String), endsLocal: expect.any(String) } });
  });

  it("reports a time that doesn't exist in the zone", () => {
    expect(validateCreate({ ...valid, startsLocal: "2026-09-27T02:30" })).toMatchObject({
      ok: false,
      errors: { startsLocal: expect.stringContaining("doesn't exist") },
    });
  });

  it("refuses an unknown zone", () => {
    expect(validateCreate({ ...valid, timezone: "Mars/Olympus" })).toMatchObject({ ok: false, errors: { timezone: expect.any(String) } });
  });

  it("takes a photo limit from 1 to 10,000", () => {
    for (const bad of ["0", "10001", "1.5", "abc", "", "-3"]) {
      expect(validateCreate({ ...valid, photoLimit: bad })).toMatchObject({ ok: false, errors: { photoLimit: expect.any(String) } });
    }
    expect(validateCreate({ ...valid, photoLimit: "10000" }).ok).toBe(true);
    expect(validateCreate({ ...valid, photoLimit: "1" }).ok).toBe(true);
  });

  it("gives defaults that validate: the next whole hour, four hours long, in New Zealand", () => {
    const form = defaultForm(NOW);
    expect(form.timezone).toBe("Pacific/Auckland");
    expect(form.startsLocal).toBe("2026-10-24T02:00");
    expect(form.endsLocal).toBe("2026-10-24T06:00");
    expect(validateCreate({ ...form, name: "x" }).ok).toBe(true);
  });
});

describe("edit form", () => {
  const existing = event({ name: "Smith wedding", venue: "Town Hall", photoLimit: 2000 });

  it("shows the stored UTC times as local times in the event's zone", () => {
    expect(formFromEvent(existing)).toEqual({
      name: "Smith wedding",
      venue: "Town Hall",
      timezone: "Pacific/Auckland",
      startsLocal: "2026-10-24T18:00",
      endsLocal: "2026-10-25T02:00",
      photoLimit: "2000",
    });
  });

  it("sends only what changed, so the audit row names the real edit", () => {
    const form = { ...formFromEvent(existing), name: "Smith-Jones wedding" };
    expect(validateUpdate(form, existing)).toEqual({ ok: true, body: { name: "Smith-Jones wedding" } });
  });

  it("an unedited form round-trips with nothing to send", () => {
    expect(validateUpdate(formFromEvent(existing), existing)).toEqual({ ok: false, errors: {}, nothing: true });
  });

  it("changing the zone alone moves the instants (the wall-clock times are what the admin sees)", () => {
    const form = { ...formFromEvent(existing), timezone: "Australia/Sydney" };
    const result = validateUpdate(form, existing);
    expect(result).toEqual({
      ok: true,
      body: { timezone: "Australia/Sydney", startsAt: "2026-10-24T07:00:00.000Z", endsAt: "2026-10-24T15:00:00.000Z" },
    });
  });

  it("checks the merged times when only one end moves", () => {
    const form = { ...formFromEvent(existing), endsLocal: "2026-10-24T17:00" };
    expect(validateUpdate(form, existing)).toMatchObject({ ok: false, errors: { endsLocal: expect.stringContaining("after") } });
  });

  it("leaves a time alone that wasn't edited, so an unrelated edit can't shift it", () => {
    // The second 02:30 on 5 Apr 2026 in Auckland (the clocks went back): the wall-clock string alone
    // would be read as the first one, an hour earlier.
    const repeated = event({ startsAt: "2026-04-04T14:30:00.000Z", endsAt: "2026-04-04T20:00:00.000Z" });
    expect(validateUpdate({ ...formFromEvent(repeated), name: "Renamed" }, repeated)).toEqual({ ok: true, body: { name: "Renamed" } });
    // Seconds the form can't show are kept too.
    const seconds = event({ startsAt: "2026-10-24T05:00:30.000Z" });
    expect(validateUpdate({ ...formFromEvent(seconds), venue: "Elsewhere" }, seconds)).toEqual({ ok: true, body: { venue: "Elsewhere" } });
  });

  it("does send a time the admin did edit, and both when the zone changes", () => {
    const seconds = event({ startsAt: "2026-10-24T05:00:30.000Z" });
    const edited = validateUpdate({ ...formFromEvent(seconds), startsLocal: "2026-10-24T19:00" }, seconds);
    expect(edited).toEqual({ ok: true, body: { startsAt: "2026-10-24T06:00:00.000Z" } });
  });

  it("an untouched start still counts in the order check against an edited end", () => {
    const e = event();
    expect(validateUpdate({ ...formFromEvent(e), endsLocal: "2026-10-24T17:59" }, e)).toMatchObject({ ok: false, errors: { endsLocal: expect.any(String) } });
  });

  it("an event stored with a photo limit of 0 can still be edited", () => {
    const zero = event({ photoLimit: 0 });
    expect(validateUpdate({ ...formFromEvent(zero), name: "Renamed" }, zero)).toEqual({ ok: true, body: { name: "Renamed" } });
    expect(validateCreate({ ...valid, photoLimit: "0" }).ok).toBe(false);
  });

  it("can clear the venue", () => {
    expect(validateUpdate({ ...formFromEvent(existing), venue: "" }, existing)).toEqual({ ok: true, body: { venue: "" } });
  });
});
