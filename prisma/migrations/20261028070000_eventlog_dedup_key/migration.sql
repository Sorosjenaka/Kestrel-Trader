-- Durable idempotency key for watcher and guard event emission.
-- Kolom belum pernah dibuat di DB hidup (schema.prisma memuat dedupKey tanpa
-- migrasi ADD COLUMN; pragma_table_info 28 Okt 2026 hanya id,type,severity,
-- payload,createdAt). CREATE INDEX tanpa kolomnya pasti gagal -> tambah kolom.
ALTER TABLE "EventLog" ADD COLUMN "dedupKey" TEXT;
CREATE UNIQUE INDEX "EventLog_dedupKey_key" ON "EventLog"("dedupKey");
