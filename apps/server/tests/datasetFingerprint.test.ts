import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultDatasetFingerprint } from "../src/learning/swingEvalLoop.js";
import { TEST_ROOT } from "../src/core/test-db-guard.js";

const root = fs.mkdtempSync(path.join(TEST_ROOT, "fingerprint-"));
const oldCwd = process.cwd();
const history = path.join(root, "data", "history");
fs.mkdirSync(history, { recursive: true });
const file = path.join(history, "BTCUSDT_1m.json");
fs.writeFileSync(file, JSON.stringify({ bars: [{ openTime: 1, close: 1 }] }));

afterAll(() => {
  process.chdir(oldCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("dataset fingerprint", () => {
  it("uses content identity, not mtime/size alone", () => {
    process.chdir(root);
    const first = defaultDatasetFingerprint();
    expect(first).toBeTruthy();
    const now = new Date();
    fs.utimesSync(file, now, now);
    expect(defaultDatasetFingerprint()).toBe(first);
    fs.writeFileSync(file, JSON.stringify({ bars: [{ openTime: 1, close: 2 }] }));
    expect(defaultDatasetFingerprint()).not.toBe(first);
  });
});
