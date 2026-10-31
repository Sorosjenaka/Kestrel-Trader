-- SwingSignalLog: ingatan terstruktur jalur SWING (bahan riset LLM Market Analyst)
CREATE TABLE "SwingSignalLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "entryPrice" REAL,
    "slPrice" REAL,
    "tp1Price" REAL,
    "rr" REAL,
    "mode" TEXT NOT NULL DEFAULT 'SWING',
    "positionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SwingSignalLog_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "SwingSignalLog_symbol_createdAt_idx" ON "SwingSignalLog"("symbol", "createdAt");
CREATE INDEX "SwingSignalLog_strategyId_createdAt_idx" ON "SwingSignalLog"("strategyId", "createdAt");
CREATE INDEX "SwingSignalLog_decision_idx" ON "SwingSignalLog"("decision");
