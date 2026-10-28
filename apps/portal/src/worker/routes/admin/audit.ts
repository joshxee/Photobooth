// GET /api/audit on the admin host (DESIGN §12): the audit table, newest first, filterable by event
// and action. Read-only; the rows are written by the mutations themselves (db.batch with the change).
import { Hono } from "hono";
import { AuditList, AuditQuery } from "../../../shared/schemas";
import { listAudit } from "../../db/audit";
import { decodeCursor, encodeCursor } from "../../domain/cursor";
import { AppError } from "../../lib/errors";
import type { AppEnv } from "../../types";

export const auditApi = new Hono<AppEnv>();

auditApi.get("/", async (c) => {
  const query = AuditQuery.parse(c.req.query());
  // An audit cursor has the guest cursor's shape: the last row's time and ID (`publishedAt` here is `at`).
  const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && position === null) throw new AppError("invalid_request", "The cursor is not valid.");
  // One row more than the page tells whether there is another.
  const rows = await listAudit(c.env.DB, {
    eventId: query.event,
    action: query.action,
    cursor: position ? { at: position.publishedAt, id: position.id } : undefined,
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return c.json(
    AuditList.parse({
      entries: page.map((r) => ({
        id: r.id,
        at: r.at,
        actor: r.actor,
        action: r.action,
        eventId: r.event_id,
        targetId: r.target_id,
        detail: r.detail,
      })),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ publishedAt: last.at, id: last.id }) : null,
    }),
  );
});
