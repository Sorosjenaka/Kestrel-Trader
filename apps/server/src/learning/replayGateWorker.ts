// apps/server/src/learning/replayGateWorker.ts
// WORKER THREAD (14 Okt 2026): replay historis untuk gate rule playbook dipindah
// dari main thread ke worker. Dulu `loadNearestValidReplayReference` me-replay
// dataset 1m 90 hari (~130 ribu bar, masing-masing menghitung strategi +
// indikator penuh) SECARA SINKRON di event loop utama — bot beku berbab menit
// setiap boot (API 000, funnel mati, CPU pegged) dan loop learning mengulanginya
// tiap 60 dtk. Worker menjaga main thread bebas; hasilnya sama persis karena
// memakai replayHistoricalDataset yang sama (single source of truth).
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import { replayHistoricalDataset } from "../backtest/historicalReplay.js";

export interface ReplayGateRequest {
  candidates: string[];
  strategyId: string;
  mode: "SCALP" | "SWING";
}

export interface ReplayGateResult {
  source: string;
  valid: boolean;
  errors: string[];
  tradeCount: number;
}

const req = workerData as ReplayGateRequest;

try {
  for (const file of req.candidates) {
    if (!fs.existsSync(file)) continue;
    const dataset = JSON.parse(fs.readFileSync(file, "utf8"));
    const replay = replayHistoricalDataset(dataset, {
      strategyId: req.strategyId, mode: req.mode,
      fees: { makerRate: 0.0002, takerRate: 0.0005 }, slippageBps: 0,
      initialEquityUsd: 200, targetRiskUsd: 1,
    });
    if (replay.errors.length) {
      // Dataset invalid -> coba kandidat berikutnya (konvensi loader lama).
      continue;
    }
    const result: ReplayGateResult = { source: file, valid: true, errors: replay.errors, tradeCount: replay.trades.length };
    parentPort!.postMessage(result);
    process.exit(0);
  }
  const result: ReplayGateResult = { source: req.candidates.join(","), valid: false, errors: ["NO_VALID_LOCAL_1M_DATASET"], tradeCount: 0 };
  parentPort!.postMessage(result);
  process.exit(0);
} catch (error) {
  const result: ReplayGateResult = {
    source: "LOCAL_HISTORICAL_REPLAY", valid: false,
    errors: [error instanceof Error ? error.message.slice(0, 180) : "REPLAY_LOAD_FAILED"], tradeCount: 0,
  };
  parentPort!.postMessage(result);
  process.exit(0);
}
