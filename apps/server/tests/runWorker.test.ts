import { describe, expect, it } from "vitest";
import { runWorkerTask } from "../src/backtest/runWorker.js";
const worker = new URL("./fixtures/auditWorker.js", import.meta.url);
describe("source and built CPU workers", () => {
  it("resolves the source .ts worker and runs outside the main thread", async () => {
    const out = await runWorkerTask<{ threadId: number; value: number }>(worker, { value: 7 }, 10000);
    expect(out.threadId).toBeGreaterThan(0);
    expect(out.value).toBe(7);
  });
  it("rejects worker failures and exits without output", async () => {
    await expect(runWorkerTask(worker, { action: "throw" }, 10000)).rejects.toThrow("OFFLINE_WORKER_FAILURE");
    await expect(runWorkerTask(worker, { action: "empty" }, 10000)).rejects.toThrow("WORKER_EXIT_WITHOUT_RESULT");
  });
  it("terminates an overdue worker without blocking the caller", async () => {
    await expect(runWorkerTask(worker, { action: "delay" }, 20)).rejects.toThrow("WORKER_TIMEOUT");
  });
});
