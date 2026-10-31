// 15 Okt 2026 — TAHAP 3 rencana audit: backtest berat TIDAK boleh jalan di main
// thread (dulu memblokir event loop & supervisor tick). Eksekusi dipindah ke
// worker thread dengan timeout fail-closed (pola replayGateWorker).
import { parentPort, workerData } from "node:worker_threads";
import { runStrategyBacktest } from "./backtestEngine.js";
import type { RunBacktestOptions, BacktestRunOutput } from "./backtestEngine.js";

export interface BacktestWorkerRequest {
  options: RunBacktestOptions;
}

const req = workerData as BacktestWorkerRequest;
const output: BacktestRunOutput = runStrategyBacktest(req.options);
parentPort?.postMessage({ output });
