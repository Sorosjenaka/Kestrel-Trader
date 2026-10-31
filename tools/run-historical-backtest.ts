import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runStrategyBacktest, type HistoricalDataset } from "../apps/server/src/backtest/backtestEngine.js";

// No download, live order, LLM call, or DB mutation. Inputs/outputs are local JSON files.
const [datasetPath,strategyId="S-01",outputPath="historical-backtest-result.json",maxDrawdownArg] = process.argv.slice(2);
if(!datasetPath || !maxDrawdownArg) {
  console.error("Usage: npx tsx tools/run-historical-backtest.ts dataset.json S-01 result.json MAX_DRAWDOWN_USD");
  process.exitCode=2;
} else {
  const dataset=JSON.parse(readFileSync(resolve(datasetPath),"utf8")) as HistoricalDataset;
  const result=runStrategyBacktest({strategyId,dataset,maxDrawdownUsd:Number(maxDrawdownArg)});
  writeFileSync(resolve(outputPath),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,metrics:result.metrics,reasons:result.failedGateReasons,provenance:result.provenance,output:resolve(outputPath)},null,2));
  process.exitCode=result.gatePassed?0:1;
}
