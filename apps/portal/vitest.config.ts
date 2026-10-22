import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker tests run inside workerd with the real local D1/R2 bindings. The SPA tests
// (src/web) run under `bun test` instead, so Vitest only looks at src/worker.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["src/worker/**/*.test.ts"] },
});
