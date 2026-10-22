import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Only tests have this binding (vitest.config.ts reads ./migrations into it), so it is typed
// here rather than on the Worker's Env.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

// Runs before each test file. Applying is idempotent (it records what ran in d1_migrations).
await applyD1Migrations(env.DB, TEST_MIGRATIONS);
