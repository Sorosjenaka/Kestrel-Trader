// apps/server/tests/maintenance.test.ts - Uji Rotasi Log & Retensi DB (T-4.4, NFR-07).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { db } from "../src/core/db.js";
import { pruneDatabase, rotateLogFiles } from "../src/core/maintenance.js";

describe("T-4.4 & NFR-07: Rotasi Log & Retensi DB", () => {
  it("pruneDatabase menghapus entri kadaluarsa & menghitung ukuran DB", async () => {
    // Buat entri lama (100 hari lalu)
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db.eventLog.create({
      data: {
        type: "OLD_EVENT_PRUNE_TEST",
        severity: "info",
        payload: JSON.stringify({ old: true }),
        createdAt: oldDate,
      },
    });

    const result = await pruneDatabase({
      eventLogRetentionDays: 90,
      setupCandidateRetentionDays: 30,
      leverageHistoryRetentionDays: 90,
      vacuumDb: false,
    });

    expect(result.eventLogsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.timestamp).toBeDefined();

    // Pastikan entri terhapus
    const remaining = await db.eventLog.findMany({
      where: { type: "OLD_EVENT_PRUNE_TEST" },
    });
    expect(remaining.length).toBe(0);
  });

  it("rotateLogFiles merotasi file log jika melampaui batas ukuran", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "artatrade-log-test-"));
    const logPath = path.join(tempDir, "server.log");

    // Tulis 12KB data
    const dummyData = "X".repeat(12 * 1024);
    fs.writeFileSync(logPath, dummyData);

    const rotationRes = rotateLogFiles({
      logDir: tempDir,
      maxSizeBytes: 10 * 1024, // 10KB threshold
      maxBackups: 3,
    });

    expect(rotationRes.rotatedFiles).toContain("server.log");
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toBe("");

    // Cleanup tempDir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("Endpoint HTTP /api/maintenance/status & /api/maintenance/prune berfungsi", async () => {
    const app = createApp();

    const statusRes = await request(app).get("/api/maintenance/status").set("x-api-token", "vitest-mutation-token");
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.tables).toBeDefined();
    expect(statusRes.body.retentionPolicy.targetDbMaxGb).toBe(2.0);

    const pruneRes = await request(app).post("/api/maintenance/prune").set("x-api-token", "vitest-mutation-token")
      .send({ eventLogRetentionDays: 365, vacuumDb: false });
    expect(pruneRes.status).toBe(200);
    expect(pruneRes.body.eventLogsDeleted).toBeDefined();
  });
});
