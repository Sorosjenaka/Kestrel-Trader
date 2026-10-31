-- Durable LONG-vs-SHORT battle audit and outcome linkage.
CREATE TABLE "DirectionBattle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "battleId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "proposedSide" TEXT NOT NULL,
    "trendSide" TEXT,
    "winner" TEXT,
    "status" TEXT NOT NULL,
    "longScore" REAL NOT NULL,
    "shortScore" REAL NOT NULL,
    "margin" REAL NOT NULL,
    "trendScore" REAL,
    "regime" TEXT,
    "adx" REAL,
    "choppiness" REAL,
    "compositeScore" REAL,
    "knnProb" REAL,
    "macroAllowed" BOOLEAN,
    "dataQuality" TEXT NOT NULL,
    "reasons" TEXT NOT NULL DEFAULT '[]',
    "inputSnapshot" TEXT NOT NULL DEFAULT '{}',
    "positionId" INTEGER,
    "outcomeStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "realizedPnlUsd" REAL,
    "realizedR" REAL,
    "closeReason" TEXT,
    "directionCorrect" BOOLEAN,
    "outcomeAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectionBattle_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DirectionBattle_battleId_key" ON "DirectionBattle"("battleId");
CREATE INDEX "DirectionBattle_symbol_createdAt_idx" ON "DirectionBattle"("symbol", "createdAt");
CREATE INDEX "DirectionBattle_status_createdAt_idx" ON "DirectionBattle"("status", "createdAt");
CREATE INDEX "DirectionBattle_positionId_idx" ON "DirectionBattle"("positionId");
CREATE INDEX "DirectionBattle_outcomeStatus_createdAt_idx" ON "DirectionBattle"("outcomeStatus", "createdAt");

CREATE TABLE "DirectionBattleVote" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "battleId" INTEGER NOT NULL,
    "agentId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "reasoning" TEXT NOT NULL,
    "byLlm" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectionBattleVote_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "DirectionBattle" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DirectionBattleVote_battleId_agentId_side_key" ON "DirectionBattleVote"("battleId", "agentId", "side");
CREATE INDEX "DirectionBattleVote_agentId_createdAt_idx" ON "DirectionBattleVote"("agentId", "createdAt");
