-- Portal schema (DESIGN.md §6). Migrations are additive only.
-- IDs: `id` columns are UUIDv7 (time-ordered, so new rows append to the primary key index).
-- Times: UTC ISO-8601 text from Date.toISOString() (`2026-10-22T09:30:00.000Z`), one format
-- everywhere so text comparison is time comparison.
-- D1 enforces foreign keys (PRAGMA foreign_keys is always on).

CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  public_id       TEXT NOT NULL UNIQUE,              -- 16 random base32 characters, in URLs
  name            TEXT NOT NULL,
  venue           TEXT NOT NULL DEFAULT '',
  timezone        TEXT NOT NULL,                     -- IANA zone
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  upload_status   TEXT NOT NULL DEFAULT 'DRAFT' CHECK (upload_status IN ('DRAFT', 'OPEN', 'CLOSED')),
  gallery_status  TEXT NOT NULL DEFAULT 'HIDDEN' CHECK (gallery_status IN ('HIDDEN', 'LIVE', 'SUSPENDED')),
  share_token     TEXT NOT NULL,                     -- stored retrievably (D9)
  access_version  INTEGER NOT NULL DEFAULT 1 CHECK (access_version >= 1),
  photo_limit     INTEGER NOT NULL DEFAULT 2000 CHECK (photo_limit >= 0),
  uploads_until   TEXT NOT NULL,                     -- ends_at + 90 days; uploads stop, photos stay
  deleted_at      TEXT,                              -- soft delete
  purge_after     TEXT,                              -- deleted_at + 7 days
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (ends_at >= starts_at),
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
);

CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  token_hash       TEXT UNIQUE,                      -- SHA-256 hex of the 256-bit credential
  enrol_code_hash  TEXT UNIQUE,                      -- SHA-256 hex of the one-time code
  enrol_expires_at TEXT,                             -- 10 minutes after issue
  enrolled_at      TEXT,
  revoked_at       TEXT,
  last_seen_at     TEXT,
  last_backlog     INTEGER CHECK (last_backlog >= 0),
  app_version      TEXT,
  CHECK ((enrol_code_hash IS NULL) = (enrol_expires_at IS NULL)),
  CHECK ((token_hash IS NULL) = (enrolled_at IS NULL))
);

CREATE TABLE photos (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES devices(id),
  client_photo_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  shot            INTEGER NOT NULL CHECK (shot >= 0),
  captured_at     TEXT NOT NULL,
  thumb_sha256    TEXT NOT NULL CHECK (length(thumb_sha256) = 64 AND thumb_sha256 NOT GLOB '*[^0-9a-f]*'),
  hd_sha256       TEXT NOT NULL CHECK (length(hd_sha256) = 64 AND hd_sha256 NOT GLOB '*[^0-9a-f]*'),
  thumb_stored    INTEGER NOT NULL DEFAULT 0 CHECK (thumb_stored IN (0, 1)),
  hd_stored       INTEGER NOT NULL DEFAULT 0 CHECK (hd_stored IN (0, 1)),
  state           TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'READY', 'REJECTED')),
  reject_reason   TEXT,
  hidden          INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  width           INTEGER NOT NULL CHECK (width > 0),    -- HD size, orientation applied
  height          INTEGER NOT NULL CHECK (height > 0),
  variant_bytes   TEXT NOT NULL CHECK (json_valid(variant_bytes)),  -- {"thumb": n, "hd": n}
  published_at    TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (device_id, client_photo_id),
  CHECK ((state = 'READY') = (published_at IS NOT NULL)),
  CHECK (state <> 'READY' OR (thumb_stored = 1 AND hd_stored = 1)),
  CHECK ((state = 'REJECTED') = (reject_reason IS NOT NULL))
);

-- Gallery page (READY, not hidden, newest first) and the photo-limit count (prefix event_id).
CREATE INDEX photos_gallery ON photos (event_id, state, hidden, published_at, id);
-- The post-shoot session filter.
CREATE INDEX photos_session ON photos (event_id, session_id);

-- No foreign key: audit rows outlive the event they describe (an event purge is audited).
CREATE TABLE audit (
  id        TEXT PRIMARY KEY,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,                           -- admin email, `svc:<id>`, `device:<id>` or `system`
  action    TEXT NOT NULL,
  event_id  TEXT,
  target_id TEXT,
  detail    TEXT CHECK (detail IS NULL OR json_valid(detail))   -- JSON, never a secret
);

CREATE INDEX audit_event_at ON audit (event_id, at);
CREATE INDEX audit_at ON audit (at);
