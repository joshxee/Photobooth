// The shared contract (DESIGN D13): every fixture in contract/fixtures is listed in
// contract/manifest.json, parses with the schema the manifest names, and stops parsing as soon
// as an unknown field is added at any depth. Session 09 loads the same files into serde.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import manifest from "../../contract/manifest.json";
import * as schemas from "../shared/schemas";
import { ERROR_CODES, ERROR_STATUS } from "../shared/schemas";

interface Entry {
  schema: string;
  kind: "request" | "response";
  route: string;
  status?: number;
}

const entries = manifest.fixtures as Record<string, Entry>;
const files = Object.fromEntries(
  Object.entries(import.meta.glob<unknown>("../../contract/fixtures/*.json", { eager: true, import: "default" })).map(
    ([path, json]) => [path.split("/").at(-1)!, json],
  ),
);

function schemaFor(name: string): z.ZodType {
  const schema = (schemas as Record<string, unknown>)[name];
  if (!schema || typeof (schema as z.ZodType).safeParse !== "function") throw new Error(`no schema named ${name}`);
  return schema as z.ZodType;
}

/** Open maps by design: an upload's `headers` (schemas.ts `UploadHeaders`, DESIGN §9.4). */
const OPEN_MAPS = new Set(["headers"]);

/** Every path to a strict JSON object inside `value`, the root included. */
function objectPaths(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) return value.flatMap((item, i) => objectPaths(item, [...path, i]));
  if (value === null || typeof value !== "object") return [];
  const children = Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]));
  return OPEN_MAPS.has(String(path.at(-1))) ? children : [path, ...children];
}

function withUnknownField(value: unknown, path: (string | number)[]): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let node = copy;
  for (const key of path) node = node[key] as Record<string | number, unknown>;
  node["unexpectedField"] = true;
  return copy;
}

describe("contract fixtures", () => {
  it("every fixture file is in the manifest, and every manifest entry has a file", () => {
    expect(Object.keys(files).sort()).toEqual(Object.keys(entries).sort());
  });

  it("names follow <area>.<message>.<variant>.json", () => {
    for (const name of Object.keys(files)) expect(name).toMatch(/^(device|gallery|error)\.[a-z0-9-]+\.[a-z0-9_-]+\.json$/);
  });

  for (const [name, entry] of Object.entries(entries)) {
    describe(name, () => {
      it(`parses as ${entry.schema}`, () => {
        const result = schemaFor(entry.schema).safeParse(files[name]);
        expect(result.error?.issues ?? []).toEqual([]);
        // Parsing must not change the fixture (no transforms or defaults in contract schemas).
        expect(result.data).toEqual(files[name]);
      });

      for (const path of objectPaths(files[name])) {
        it(`rejects an unknown field at /${path.join("/")}`, () => {
          expect(schemaFor(entry.schema).safeParse(withUnknownField(files[name], path)).success).toBe(false);
        });
      }

      if (entry.kind === "response") {
        it("has a status, which for an error body matches its code", () => {
          expect(entry.status).toBeTypeOf("number");
          const code = (files[name] as { code?: string }).code;
          if (entry.schema === "ErrorBody") expect(entry.status).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
        });
      }
    });
  }

  it("there is an error fixture for every error code", () => {
    const covered = Object.entries(entries)
      .filter(([, e]) => e.schema === "ErrorBody")
      .map(([name]) => (files[name] as { code: string }).code);
    expect(new Set(covered)).toEqual(new Set(ERROR_CODES));
  });

  it("covers every device and gallery message", () => {
    const schemasUsed = new Set(Object.values(entries).map((e) => e.schema));
    for (const schema of [
      "EnrolRequest", "EnrolResponse", "DeviceEventsResponse", "DeviceEventDetail", "PhotoIntentRequest",
      "PhotoIntentResponse", "UploadResponse", "GallerySessionRequest", "GallerySessionResponse", "GalleryPhotosPage",
      "ErrorBody",
    ]) {
      expect(schemasUsed).toContain(schema);
    }
  });

  it("has every intent and upload outcome (D14)", () => {
    const states = (schema: string) =>
      Object.entries(entries)
        .filter(([, e]) => e.schema === schema)
        .map(([name]) => {
          const body = files[name] as { state: string; uploads?: object };
          return body.uploads ? `${body.state}:${Object.keys(body.uploads).sort().join("+")}` : body.state;
        })
        .sort();
    expect(states("PhotoIntentResponse")).toEqual(["PENDING:hd", "PENDING:hd+thumb", "READY", "REJECTED"]);
    expect(states("UploadResponse")).toEqual(["PROCESSING", "READY", "STORED"]);
  });
});
