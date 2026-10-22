import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker tests run inside workerd with the real local D1/R2 bindings. The SPA tests
// (src/web) run under `bun test` instead, so Vitest only looks at src/worker.
// The D1 migrations are read here (in Node) and applied in workerd by src/worker/test/setup.ts.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
    })),
  ],
  test: {
    include: ["src/worker/**/*.test.ts"],
    setupFiles: ["./src/worker/test/setup.ts"],
  },
});
