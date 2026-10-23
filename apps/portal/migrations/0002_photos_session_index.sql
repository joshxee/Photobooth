-- Session 11: the post-shoot view lists one booth session's READY, visible photos newest first,
-- and polls it every 10 s. On `photos_session (event_id, session_id)` SQLite chose `photos_gallery`
-- and read every READY photo of the event to find the session's few (D1 bills rows read), so the
-- session index now covers the whole gallery filter and order, as `photos_gallery` does for the event.
-- Replacing the index changes no data: the old columns are a prefix of the new ones.
DROP INDEX photos_session;
CREATE INDEX photos_session ON photos (event_id, session_id, state, hidden, published_at, id);
