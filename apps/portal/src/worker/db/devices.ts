// `devices` table (DESIGN §6, D8). Secrets are stored only as SHA-256 hex (domain/tokens.ts).

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
 * under concurrent requests. Returns the enrolled device, or null for an unknown, expired or used
 * code or a revoked device (the route gives all of these one identical error).
 */
export function redeemEnrolCode(
  db: D1Database,
  args: { codeHash: string; tokenHash: string; appVersion: string; now: Date },
): Promise<DeviceRow | null> {
  const now = args.now.toISOString();
  return db
    .prepare(
      `UPDATE devices SET token_hash = ?, enrolled_at = ?, app_version = ?, enrol_code_hash = NULL, enrol_expires_at = NULL
       WHERE enrol_code_hash = ? AND enrol_expires_at > ? AND revoked_at IS NULL
       RETURNING ${COLUMNS}`,
    )
    .bind(args.tokenHash, now, args.appVersion, args.codeHash, now)
    .first<DeviceRow>();
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
