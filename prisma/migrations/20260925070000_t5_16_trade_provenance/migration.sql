-- T-5.16: Provenance data (LIVE_AI / MANUAL / DEMO) supaya history trading BEBAS data dummy.
-- DEMO = jejak pipeline uji (`POST /api/pipeline/run-disarmed`) yang tidak dihitung di history/equity.

ALTER TABLE "Position" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'LIVE_AI';
ALTER TABLE "Trade" ADD COLUMN "source" TEXT;

CREATE INDEX "Position_source_idx" ON "Position"("source");

-- Backfill: tandai baris lama yang jelas dummy (harga mock pipeline uji / teks demo) sebagai DEMO.
UPDATE "Position" SET "source" = 'DEMO'
 WHERE "source" = 'LIVE_AI'
   AND ("entryPrice" IN (3000, 60000, 62000, 100, 50000, 1000)
        OR "symbol" LIKE 'TEST%' OR "symbol" LIKE 'MOCK%' OR "symbol" LIKE 'DEMO%'
        OR "outlookText" LIKE '%tervalidasi. Target TP1 65% di +1R, sisa trailing ke TP2.%');

UPDATE "Trade" SET "source" = 'DEMO'
 WHERE "source" IS NULL
   AND "positionId" IN (SELECT "id" FROM "Position" WHERE "source" = 'DEMO');

UPDATE "Trade" SET "source" = 'LIVE_AI' WHERE "source" IS NULL;
UPDATE "Position" SET "source" = 'LIVE_AI' WHERE "source" IS NULL;
