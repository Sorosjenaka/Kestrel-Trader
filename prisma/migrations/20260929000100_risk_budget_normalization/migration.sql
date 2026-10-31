-- Normalisasi R ke budget risiko (opsi b, perintah operator 29 Sep 2026).
-- Alasan: rMultiple lama = realized / |entry-SL|*qty (GROSS price risk), sementara
-- sizing berjalan dengan riskBudgetMode "NET" sehingga rugi dolar selalu < budget
-- dan R bisa lebih buruk dari -1R meski rugi < $1. Budget risiko hanya tersimpan
-- sebagai teks di outlookText. Kolom ini menjadikannya data yang bisa dihitung.
-- Catatan: file ini tidak boleh memuat titik-koma di dalam komentar, karena
-- tools/apply-migration.mjs memisah statement per titik-koma sebelum membuang komentar.
ALTER TABLE "Position" ADD COLUMN "riskBudgetUsd" REAL;
ALTER TABLE "Trade" ADD COLUMN "riskBudgetUsd" REAL;