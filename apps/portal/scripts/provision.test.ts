import { describe, expect, it } from "bun:test";
import { provisionCommands } from "./provision";

const config = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text()) as Parameters<
  typeof provisionCommands
>[0];

const commands = (env: string) => provisionCommands(config, env).filter((l) => !l.startsWith("#"));

describe("provisionCommands", () => {
  it("creates staging's one D1 and one R2 and sets both secrets on both staging Workers", () => {
    const lines = commands("staging");
    expect(lines).toContain("npx wrangler d1 create portal-staging --location oc --no-update-config");
    expect(lines).toContain("npx wrangler r2 bucket create portal-media-staging --location oc --no-update-config");
    for (const secret of ["UPLOAD_KEY", "SESSION_KEY"]) {
      for (const env of ["staging", "staging-admin"]) {
        expect(lines).toContain(`$k | npx wrangler secret put ${secret} --env ${env}`);
      }
    }
    // A fresh value per secret, never written out.
    expect(lines.filter((l) => l.startsWith("$k = ")).length).toBe(2);
    expect(lines.join("\n")).not.toMatch(/echo|Write-Output|Out-File|Set-Content/);
  });

  it("prints production's own names and never touches staging", () => {
    const lines = commands("production");
    expect(lines).toContain("npx wrangler d1 create portal --location oc --no-update-config");
    expect(lines).toContain("npx wrangler r2 bucket create portal-media --location oc --no-update-config");
    expect(lines).toContain("$k | npx wrangler secret put UPLOAD_KEY --env production");
    expect(lines.join("\n")).not.toContain("staging");
  });

  it("never deploys, and refuses an unknown environment", () => {
    for (const env of ["staging", "production"]) expect(commands(env).join("\n")).not.toMatch(/deploy|lifecycle/);
    expect(() => provisionCommands(config, "local")).toThrow(/unknown environment/);
  });
});
