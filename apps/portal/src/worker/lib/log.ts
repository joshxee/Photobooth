// Structured JSON logs for Workers Observability (DESIGN §15).
//
// Safety comes from an allowlist, not from remembering to leave things out: only the fields below
// are ever written, so a cookie, auth header, body or query string handed in by mistake is dropped.
// `path` is cut at `?` and `#` because share tokens and signed-URL signatures travel there.

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  eventId?: string;
  photoId?: string;
  deviceId?: string;
  version?: string;
  outcome?: string;
  method?: string;
  /** Pathname only; any query string or fragment is removed. */
  path?: string;
  status?: number;
  durationMs?: number;
  /** Which app handled the request: gallery, admin or unknown. Never the raw Host header. */
  host?: string;
  errorName?: string;
  cron?: string;
}

const ALLOWED = new Set<string>([
  "requestId",
  "eventId",
  "photoId",
  "deviceId",
  "version",
  "outcome",
  "method",
  "path",
  "status",
  "durationMs",
  "host",
  "errorName",
  "cron",
] satisfies (keyof LogFields)[]);

function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

// info goes to console.log, but warn and error use their own methods so Workers Observability
// records the right severity for dashboard filtering.
const consoleSink: LogSink = (line, level) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(sink: LogSink = consoleSink): Logger {
  const write = (level: LogLevel, fields: LogFields) => {
    const entry: Record<string, unknown> = { level, ts: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields)) {
      if (!ALLOWED.has(key) || value === undefined) continue;
      entry[key] = key === "path" && typeof value === "string" ? stripQuery(value) : value;
    }
    sink(JSON.stringify(entry), level);
  };
  return {
    info: (fields) => write("info", fields),
    warn: (fields) => write("warn", fields),
    error: (fields) => write("error", fields),
  };
}

export const log: Logger = createLogger();
