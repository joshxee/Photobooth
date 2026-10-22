// `devices` table (DESIGN §6, D8). Secrets are stored only as SHA-256 hex (domain/tokens.ts).
import { HEARTBEAT_INTERVAL_MS } from "../domain/device";

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string | null;
  enrol_code_hash: string | null;
  enrol_expires_at: string | null;
  enrolled_at: string | null;
  revoked_at: string | null;
  last_seen_at: string | null;
  last_backlog: number | null;
  app_version: string | null;
}

const COLUMNS =
  "id, name, token_hash, enrol_code_hash, enrol_expires_at, enrolled_at, revoked_at, last_seen_at, last_backlog, app_version";

export function insertDevice(db: D1Database, d: DeviceRow): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO devices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      d.id, d.name, d.token_hash, d.enrol_code_hash, d.enrol_expires_at, d.enrolled_at, d.revoked_at,
      d.last_seen_at, d.last_backlog, d.app_version,
    );
}

export function getDevice(db: D1Database, id: string): Promise<DeviceRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM devices WHERE id = ?`).bind(id).first<DeviceRow>();
}

/** The bearer-auth lookup. The caller checks `revoked_at`. */
export function getDeviceByTokenHash(db: D1Database, tokenHash: string): Promise<DeviceRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM devices WHERE token_hash = ?`).bind(tokenHash).first<DeviceRow>();
}

/** In creation order (ids are UUIDv7). */
export async function listDevices(db: D1Database): Promise<DeviceRow[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM devices ORDER BY id`).all<DeviceRow>();
  return results;
}

/** Issues (or re-issues, replacing any old one) a one-time code. Not for revoked devices. */
export function setEnrolCode(db: D1Database, id: string, codeHash: string, expiresAt: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE devices SET enrol_code_hash = ?, enrol_expires_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(codeHash, expiresAt, id);
}

/**
 * Swaps a valid code for a credential in one statement, so a code can be used only once even
 * under concurrent requests. The device takes the name the booth sends and counts as seen.
 * RETURNING gives the enrolled device, or no row for an unknown, expired or used code or a revoked
 * device (the route gives all of these one identical error). A statement, so the route can batch
 * it with `insertEnrolAudit`. Redeeming a code re-issued to an enrolled device replaces its
 * credential: the old one stops working.
 */
export function redeemEnrolCode(
  db: D1Database,
  args: { codeHash: string; tokenHash: string; name: string; appVersion: string; now: Date },
): D1PreparedStatement {
  const now = args.now.toISOString();
  return db
    .prepare(
      `UPDATE devices SET token_hash = ?, enrolled_at = ?, name = ?, app_version = ?, last_seen_at = ?,
         enrol_code_hash = NULL, enrol_expires_at = NULL
       WHERE enrol_code_hash = ? AND enrol_expires_at > ? AND revoked_at IS NULL
       RETURNING ${COLUMNS}`,
    )
    .bind(args.tokenHash, now, args.name, args.appVersion, now, args.codeHash, now);
}

/**
 * The heartbeat of an authenticated device call (DESIGN §8): last seen, plus the backlog and app
 * version when the request sent them (null keeps the stored value). The route skips it when the
 * row it read was written less than a minute ago; the same condition here stops two concurrent
 * requests both writing. A stored time in the future is overwritten. Never for a revoked device.
 */
export function recordHeartbeat(
  db: D1Database,
  args: { id: string; now: Date; backlog: number | null; appVersion: string | null },
): D1PreparedStatement {
  const now = args.now.toISOString();
  const due = new Date(args.now.getTime() - HEARTBEAT_INTERVAL_MS).toISOString();
  return db
    .prepare(
      `UPDATE devices SET last_seen_at = ?, last_backlog = COALESCE(?, last_backlog), app_version = COALESCE(?, app_version)
       WHERE id = ? AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at <= ? OR last_seen_at > ?)`,
    )
    .bind(now, args.backlog, args.appVersion, args.id, due, now);
}

/** Revokes a device (its credential stops working at once) and voids any pending code. */
export function revokeDevice(db: D1Database, id: string, now: Date): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE devices SET revoked_at = ?, enrol_code_hash = NULL, enrol_expires_at = NULL
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(now.toISOString(), id);
}
