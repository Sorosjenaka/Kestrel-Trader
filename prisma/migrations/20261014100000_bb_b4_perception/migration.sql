-- Big Brain Tahap B4 (14 Okt 2026): fitur persepsi Open Interest & beta-BTC
-- pada memori keputusan (DecisionLog). Nullable — baris lama tetap valid.
ALTER TABLE "DecisionLog" ADD COLUMN "oiChangePct" FLOAT;
ALTER TABLE "DecisionLog" ADD COLUMN "betaBtc" FLOAT;
