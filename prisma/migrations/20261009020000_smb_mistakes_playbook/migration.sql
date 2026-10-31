-- SMB Capital Momentum Model (T-01 + T-05): taksonomi kesalahan eksekusi pada
-- LearningEntry yang sudah ada (tanpa tabel baru) dan model PlaybookRule untuk
-- solusi If-Then berstatus PROPOSED (butuh approval operator, tanpa auto-aktivasi).
-- SQLite tidak punya enum native: executionMistake/source/status disimpan sebagai
-- TEXT dengan default konstan dan divalidasi oleh allowlist di TypeScript.
-- Catatan: file ini tidak boleh memuat titik-koma di dalam komentar, karena
-- tools/apply-migration.mjs memisah statement per titik-koma sebelum membuang komentar.
ALTER TABLE "LearningEntry" ADD COLUMN "executionMistake" TEXT NOT NULL DEFAULT 'MISTAKE_NONE';
ALTER TABLE "LearningEntry" ADD COLUMN "isExecutionMistake" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LearningEntry" ADD COLUMN "planDeviationRatio" REAL;
ALTER TABLE "LearningEntry" ADD COLUMN "mistakeNotes" TEXT;
CREATE INDEX "LearningEntry_executionMistake_idx" ON "LearningEntry"("executionMistake");
CREATE TABLE "PlaybookRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleText" TEXT NOT NULL,
    "triggerCondition" TEXT NOT NULL,
    "actionStatement" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "violatedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "PlaybookRule_status_idx" ON "PlaybookRule"("status");