// 25 Okt 2026 (FASE 1 auth): integrasi test memanggil route mutasi dengan
// token uji — enforcement auth aktif di createApp sungguhan.
process.env.API_MUTATION_TOKEN = process.env.API_MUTATION_TOKEN || "vitest-mutation-token";

// Hard boundary runs before any test module can create a DB client.
import { assertTestDatabaseBoundary } from "../src/core/test-db-guard.js";
assertTestDatabaseBoundary(process.env.DATABASE_URL, "setup-offline");

// Client tests may replace fetch with a deterministic mock; real external calls fail.
const fetchLocal = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return Promise.reject(new Error("OFFLINE_TEST_EXTERNAL_NETWORK_BLOCKED"));
  }
  return fetchLocal(input, init);
}) as typeof fetch;
