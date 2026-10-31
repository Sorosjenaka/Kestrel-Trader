-- T-01 (4 Okt 2026): snapshot atribut trigger dan kondisi market saat entry
-- (displacement ATR, kedalaman sweep ATR, bias, killzone label, rasio volume, rezim ATR)
-- sebagai JSON teks untuk analisis bucket (tools/analyze-entry-attrs.ts).
-- Murni pencatatan observabilitas, bukan logika keputusan trading.
-- Catatan: file ini tidak boleh memuat titik-koma di dalam komentar, karena
-- tools/apply-migration.mjs memisah statement per titik-koma sebelum membuang komentar.
ALTER TABLE "Position" ADD COLUMN "entryAttrs" TEXT;
ALTER TABLE "Trade" ADD COLUMN "entryAttrs" TEXT;
