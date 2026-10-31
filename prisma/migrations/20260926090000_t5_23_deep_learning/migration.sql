-- T-5.23 Deep Learning: LearningEntry mencatat outcome + lesson + agen evaluator.
-- Idempoten via tools/apply-migration.mjs (ADD COLUMN dilewati bila sudah ada).
ALTER TABLE "LearningEntry" ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "LearningEntry" ADD COLUMN "lesson" TEXT;
ALTER TABLE "LearningEntry" ADD COLUMN "agentId" TEXT NOT NULL DEFAULT 'post-mortem';
CREATE INDEX "LearningEntry_outcome_idx" ON "LearningEntry"("outcome");
-- Backfill outcome dari hasil trade yang masih tertaut.
UPDATE "LearningEntry" SET "outcome" = 'LOSS' WHERE "outcome" = 'UNKNOWN' AND "tradeId" IN (SELECT "id" FROM "Trade" WHERE "win" = 0);
UPDATE "LearningEntry" SET "outcome" = 'WIN' WHERE "outcome" = 'UNKNOWN' AND "tradeId" IN (SELECT "id" FROM "Trade" WHERE "win" = 1);
