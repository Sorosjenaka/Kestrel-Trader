import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertTestDatabaseBoundary, TEST_ROOT } from "../src/core/test-db-guard.js";

const dir = fs.mkdtempSync(path.join(TEST_ROOT, "canary-"));
const canary = path.join(dir, "artatrade.db");
const old = process.env.DATABASE_URL;

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

afterAll(() => {
  process.env.DATABASE_URL = old;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("test database hard boundary", () => {
  it("rejects a legacy/active database name without touching the canary", () => {
    const db = new DatabaseSync(canary);
    db.exec("CREATE TABLE sentinel (v TEXT); INSERT INTO sentinel VALUES ('unchanged')");
    db.close();
    const before = digest(canary);
    expect(() => assertTestDatabaseBoundary("file:" + canary, "canary")).toThrow(/ACTIVE_OR_LEGACY/);
    expect(digest(canary)).toBe(before);
  });

  it("rejects a path outside the disposable root", () => {
    const live = path.resolve(process.cwd(), "..", "data", "artatrade.db");
    expect(() => assertTestDatabaseBoundary("file:" + live, "outside")).toThrow(/OUTSIDE_DISPOSABLE/);
  });

  it("rejects missing URLs and accepts only a run-scoped disposable file", () => {
    expect(() => assertTestDatabaseBoundary("", "missing")).toThrow(/URL_REQUIRED/);
    const valid = path.join(TEST_ROOT, "valid-run", "worker-1.db");
    const result = assertTestDatabaseBoundary("file:" + valid, "valid");
    expect(result).toContain("/data/test-runs/valid-run/worker-1.db");
  });
});
