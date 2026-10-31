-- T-5.15: Mesin setup (zona/POI entry, SL struktural, strategi S-01..S-05, trailing stop).
-- Semua kolom nullable / punya default => tidak ada kehilangan data.

-- SetupCandidate: hasil rencana strategi + POI zona
ALTER TABLE "SetupCandidate" ADD COLUMN "strategyId" TEXT;
ALTER TABLE "SetupCandidate" ADD COLUMN "strategyName" TEXT;
ALTER TABLE "SetupCandidate" ADD COLUMN "entryType" TEXT;
ALTER TABLE "SetupCandidate" ADD COLUMN "entryPrice" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "slPrice" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "tp1Price" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "tp2Price" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "zoneType" TEXT;
ALTER TABLE "SetupCandidate" ADD COLUMN "zoneTop" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "zoneBottom" REAL;
ALTER TABLE "SetupCandidate" ADD COLUMN "tfSummary" TEXT;
ALTER TABLE "SetupCandidate" ADD COLUMN "planQuality" INTEGER;
ALTER TABLE "SetupCandidate" ADD COLUMN "planNotes" TEXT;

-- Position: strategi + POI + state trailing stop
ALTER TABLE "Position" ADD COLUMN "strategyId" TEXT;
ALTER TABLE "Position" ADD COLUMN "strategyName" TEXT;
ALTER TABLE "Position" ADD COLUMN "entryType" TEXT;
ALTER TABLE "Position" ADD COLUMN "zoneType" TEXT;
ALTER TABLE "Position" ADD COLUMN "zoneTop" REAL;
ALTER TABLE "Position" ADD COLUMN "zoneBottom" REAL;
ALTER TABLE "Position" ADD COLUMN "trailPeak" REAL;
ALTER TABLE "Position" ADD COLUMN "trailActive" BOOLEAN NOT NULL DEFAULT false;

-- Trade: jejak strategi untuk statistik per strategi
ALTER TABLE "Trade" ADD COLUMN "strategyId" TEXT;
ALTER TABLE "Trade" ADD COLUMN "zoneType" TEXT;

CREATE INDEX "SetupCandidate_strategyId_createdAt_idx" ON "SetupCandidate"("strategyId", "createdAt");
