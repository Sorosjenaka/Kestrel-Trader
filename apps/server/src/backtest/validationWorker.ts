import { parentPort, workerData } from "node:worker_threads";
import type { HistoricalDataset, ReplayOptions } from "./historicalReplay.js";
import type { StrategyMode, FeeStructure } from "./backtestEngine.js";
import { runCpcvValidation } from "./validation/cpcvRunner.js";
import { runSensitivityAnalysis } from "./validation/sensitivityRunner.js";
import { runStressTest } from "./validation/stressTester.js";
import { runLookAheadAudit } from "./validation/lookAheadAudit.js";
import { runOutOfSampleValidation, type OosRunOptions } from "./validation/oosRunner.js";
import { runEventReplay, type EventReplayOptions } from "./validation/eventReplay.js";
import type { CpcvConfig } from "./validation/cpcvTypes.js";

export interface ValidationWorkerRequest {
  validationType: "cpcv" | "sensitivity" | "stress" | "lookahead" | "oos" | "events" | "audit";
  dataset: HistoricalDataset;
  strategyId: string;
  mode: StrategyMode;
  fees: FeeStructure;
  cpcv?: CpcvConfig;
  options?: OosRunOptions & EventReplayOptions;
}

const req = workerData as ValidationWorkerRequest;
const { dataset, strategyId, mode, fees } = req;
const replayOptions: ReplayOptions = {
  strategyId, mode, fees, slippageBps: req.options?.slippageBps ?? 5,
  initialEquityUsd: req.options?.initialEquityUsd ?? 200,
  targetRiskUsd: req.options?.targetRiskUsd ?? 1, tp1ROverride: req.options?.tp1ROverride,
};
let output: unknown;
switch (req.validationType) {
  case "cpcv": output = runCpcvValidation(dataset, strategyId, mode, fees, req.cpcv ?? { nGroups: 10, kTestGroups: 2, purgeWindowMs: 3_600_000, embargoMs: 900_000 }); break;
  case "sensitivity": output = runSensitivityAnalysis(dataset, strategyId, mode, fees); break;
  case "stress": output = runStressTest(dataset, strategyId, mode, fees); break;
  case "lookahead": output = runLookAheadAudit(dataset, replayOptions); break;
  case "oos": output = runOutOfSampleValidation(dataset, strategyId, mode, fees, req.options); break;
  case "events": output = runEventReplay(dataset, strategyId, mode, fees, req.options); break;
  case "audit": output = {
    lookAhead: runLookAheadAudit(dataset, replayOptions),
    outOfSample: runOutOfSampleValidation(dataset, strategyId, mode, fees, req.options),
    eventReplay: runEventReplay(dataset, strategyId, mode, fees, req.options),
  }; break;
  default: throw new Error("UNSUPPORTED_VALIDATION_TYPE");
}
parentPort?.postMessage({ output });
