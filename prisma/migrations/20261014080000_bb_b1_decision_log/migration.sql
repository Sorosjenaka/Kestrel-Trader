-- Big Brain Tahap B1 (14 Okt 2026): DecisionLog — memori keputusan untuk kalibrasi.
-- Satu baris per keputusan judge (GO dan NO-GO sama-sama di-log).
-- Catatan: file ini tidak boleh memuat titik-koma di dalam komentar.
CREATE TABLE "DecisionLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "strategyId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'NO_GO',
    "rejectReason" TEXT,
    "knnProb" REAL,
    "knnN" INTEGER,
    "drexProb" REAL,
    "drexStrength" REAL,
    "compositeScore" REAL,
    "trendScore" REAL,
    "regime" TEXT,
    "er" REAL,
    "choppiness" REAL,
    "adx" REAL,
    "atrPct" REAL,
    "pocDistanceBins" REAL,
    "macroAllowed" BOOLEAN,
    "cooldownAgeMs" INTEGER,
    "positionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionLog_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "DecisionLog_symbol_createdAt_idx" ON "DecisionLog"("symbol", "createdAt");
CREATE INDEX "DecisionLog_decision_idx" ON "DecisionLog"("decision");
CREATE INDEX "DecisionLog_positionId_idx" ON "DecisionLog"("positionId");
