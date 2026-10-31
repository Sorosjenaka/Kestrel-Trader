import { defineConfig } from "vitest/config";
import path from "node:path";

// A root `npx vitest run` must never fall back to the runtime DATABASE_URL.
// The actual disposable URL is created by the guarded globalSetup.
const serverRoot = path.resolve("apps/server");
export default defineConfig({
  test: {
    root: serverRoot,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 10000,
    env: {
      ARTA_OFFLINE_TEST: "true",
      NODE_ENV: "test",
      BINANCE_API_KEY: "", BINANCE_API_SECRET: "", XKIRO_API_KEY: "", DREX_API_KEY: "",
      API_MUTATION_TOKEN: "", TV_WEBHOOK_SECRET: "",
      DREX_ENABLED: "false",
      BINANCE_EXECUTION_MODE: "PAPER",
      PAPER_TOUCH_VERIFY: "false",
      PAPER_START_EQUITY_USD: "200",
      SWING_MAX_POSITIONS: "20",
    },
    globalSetup: ["./tests/setup-test-db.ts"],
    setupFiles: ["./tests/setup-offline.ts"],
  },
});
