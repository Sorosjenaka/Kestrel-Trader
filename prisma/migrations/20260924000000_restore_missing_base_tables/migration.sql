-- Restore missing phase-1 base tables without rewriting applied migrations.
-- IF NOT EXISTS also permits baselining an already populated installation.
-- Backfill/normalization remains in the original subsequent migrations.

CREATE TABLE IF NOT EXISTS "LeverageHistory" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "maxLeverage" INTEGER NOT NULL,
    "previousMaxLeverage" INTEGER,
    "observedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SetupCandidate" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "regime" TEXT NOT NULL,
    "zoneScore" INTEGER NOT NULL,
    "triggerScore" INTEGER NOT NULL,
    "trendScore" INTEGER NOT NULL,
    "knnProb" REAL,
    "knnN" INTEGER,
    "gatesPass" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAIT',
    "rejectReason" TEXT
);

CREATE TABLE IF NOT EXISTS "BacktestRun" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "strategyId" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "fromDate" DATETIME NOT NULL,
    "toDate" DATETIME NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "winrate" REAL NOT NULL,
    "evUsd" REAL NOT NULL,
    "evR" REAL NOT NULL,
    "maxDdUsd" REAL NOT NULL,
    "feeModel" TEXT NOT NULL,
    "paramsVersion" TEXT NOT NULL DEFAULT 'v0.1.0-base',
    "status" TEXT NOT NULL,
    "failedReasons" TEXT,
    "distributionR" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "BacktestTrade" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL NOT NULL,
    "entryAt" DATETIME NOT NULL,
    "exitAt" DATETIME NOT NULL,
    "rMultiple" REAL NOT NULL,
    "grossPnl" REAL NOT NULL,
    "netPnl" REAL NOT NULL,
    "feesUsd" REAL NOT NULL,
    "exitReason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BacktestTrade_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Position" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "qty" REAL NOT NULL,
    "notional" REAL NOT NULL,
    "leverage" INTEGER NOT NULL,
    "marginUsd" REAL NOT NULL,
    "slPrice" REAL NOT NULL,
    "tp1Price" REAL NOT NULL,
    "tp2Price" REAL NOT NULL,
    "beMoved" BOOLEAN NOT NULL DEFAULT false,
    "tp1FilledAt" DATETIME,
    "tp2FilledAt" DATETIME,
    "realizedPnlUsd" REAL NOT NULL DEFAULT 0,
    "tp1FillPrice" REAL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "closeReason" TEXT,
    "pnlUsd" REAL,
    "pnlR" REAL,
    "outlookText" TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS "OrderExec" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "positionId" INTEGER,
    "clientOrderId" TEXT NOT NULL,
    "binanceOrderId" TEXT,
    "symbol" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "qty" REAL NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "fillPrice" REAL,
    "feeUsd" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" DATETIME,
    CONSTRAINT "OrderExec_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Trade" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "positionId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "riskUsd" REAL NOT NULL DEFAULT 1.0,
    "entryAvg" REAL NOT NULL,
    "exitAvg" REAL NOT NULL,
    "rMultiple" REAL NOT NULL,
    "pnlUsd" REAL NOT NULL,
    "feeUsd" REAL NOT NULL,
    "fundingUsd" REAL NOT NULL DEFAULT 0.0,
    "win" BOOLEAN NOT NULL,
    "mfeR" REAL NOT NULL DEFAULT 0.0,
    "maeR" REAL NOT NULL DEFAULT 0.0,
    "holdMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trade_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "LearningEntry" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tradeId" INTEGER,
    "causeCode" TEXT NOT NULL,
    "narrative" TEXT NOT NULL,
    "proposal" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearningEntry_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ParameterVersion" (
"id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "version" TEXT NOT NULL,
    "params" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "backtestRunId" INTEGER,
    "activatedAt" DATETIME,
    "rollbackAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "LeverageHistory_symbol_observedAt_idx" ON "LeverageHistory"("symbol", "observedAt");
CREATE INDEX IF NOT EXISTS "SetupCandidate_symbol_createdAt_idx" ON "SetupCandidate"("symbol", "createdAt");
CREATE INDEX IF NOT EXISTS "SetupCandidate_status_score_idx" ON "SetupCandidate"("status", "score");
CREATE INDEX IF NOT EXISTS "BacktestRun_strategyId_mode_idx" ON "BacktestRun"("strategyId", "mode");
CREATE INDEX IF NOT EXISTS "BacktestRun_status_createdAt_idx" ON "BacktestRun"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "BacktestTrade_runId_symbol_idx" ON "BacktestTrade"("runId", "symbol");
CREATE INDEX IF NOT EXISTS "BacktestTrade_exitReason_idx" ON "BacktestTrade"("exitReason");
CREATE INDEX IF NOT EXISTS "Position_status_symbol_idx" ON "Position"("status", "symbol");
CREATE INDEX IF NOT EXISTS "Position_openedAt_idx" ON "Position"("openedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "OrderExec_clientOrderId_key" ON "OrderExec"("clientOrderId");
CREATE INDEX IF NOT EXISTS "OrderExec_clientOrderId_idx" ON "OrderExec"("clientOrderId");
CREATE INDEX IF NOT EXISTS "OrderExec_status_createdAt_idx" ON "OrderExec"("status", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Trade_positionId_key" ON "Trade"("positionId");
CREATE INDEX IF NOT EXISTS "Trade_symbol_createdAt_idx" ON "Trade"("symbol", "createdAt");
CREATE INDEX IF NOT EXISTS "Trade_win_idx" ON "Trade"("win");
CREATE INDEX IF NOT EXISTS "LearningEntry_tradeId_idx" ON "LearningEntry"("tradeId");
CREATE INDEX IF NOT EXISTS "LearningEntry_causeCode_idx" ON "LearningEntry"("causeCode");
CREATE UNIQUE INDEX IF NOT EXISTS "ParameterVersion_version_key" ON "ParameterVersion"("version");
CREATE INDEX IF NOT EXISTS "ParameterVersion_status_idx" ON "ParameterVersion"("status");
