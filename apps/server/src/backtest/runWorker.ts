import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Source-mode uses tsx's scoped loader; built-mode imports emitted JS. Never
 * fall back to CPU work on the trading event loop when a worker cannot start. */
export function runWorkerTask<T>(requestedModule: URL, data: unknown, timeoutMs = 180_000): Promise<T> {
  let moduleUrl = requestedModule;
  if (!existsSync(fileURLToPath(moduleUrl)) && moduleUrl.pathname.endsWith(".js")) {
    moduleUrl = new URL(moduleUrl.href.replace(/\.js$/, ".ts"));
  }
  if (!existsSync(fileURLToPath(moduleUrl))) return Promise.reject(new Error("WORKER_MODULE_NOT_FOUND"));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("INVALID_WORKER_TIMEOUT"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      (async () => {
        const { workerData, parentPort } = await import("node:worker_threads");
        if (workerData.__moduleUrl.endsWith(".ts")) {
          const { register } = await import("tsx/esm/api");
          register();
        }
        await import(workerData.__moduleUrl);
      })().catch(async (error) => {
        const { parentPort } = await import("node:worker_threads");
        parentPort.postMessage({ __workerError: error.message });
        process.exitCode = 1;
      });
    `, { eval: true, workerData: { ...(data as object), __moduleUrl: moduleUrl.href } });
    let settled = false;
    const finish = (error: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(result as T);
    };
    const timer = setTimeout(() => finish(new Error("WORKER_TIMEOUT")), timeoutMs);
    worker.on("message", (result: T & { __workerError?: string }) => {
      if (result?.__workerError) finish(new Error(result.__workerError));
      else finish(null, result);
    });
    worker.on("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", code => finish(new Error(`WORKER_EXIT_WITHOUT_RESULT_${code}`)));
  });
}
