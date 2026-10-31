// apps/server/src/learning/decisionLog.ts
// Big Brain Tahap B1 (14 Okt 2026): memori keputusan — lapisan yang hilang
// antara "apa yang dipikirkan otak saat entry" dan "apa yang terjadi".
//
// KONTRAK:
//  - SATU baris per keputusan judge (GO maupun NO-GO — NO-GO = data negatif
//    yang sama pentingnya untuk kalibrasi).
//  - TANPA angka uang (Golden Rule §1.1) — hanya fitur keputusan 0..100 / 0..1
//    / label regime. Harga TIDAK disimpan (yang punya harga = Position/Trade).
//  - Fail-open pada pencatatan: kegagalan log TIDAK boleh menggagalkan
//    keputusan trading (logging = observability, bukan gerbang). Tapi error
//    WAJIB ter-log agar tidak jadi jalur mampet diam-diam.
//  - positionId di-update belakangan oleh pemanggil bila keputusan GO jadi
//    posisi nyata (linkDecisionToPosition) supaya JOIN kalibrasi bisa jalan.
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

/** Fitur keputusan yang dicatat — semua opsional, tanpa fabrikasi nilai. */
export interface DecisionFeatures {
  symbol: string;
  side: "LONG" | "SHORT";
  mode: string; // "SCALP"
  strategyId?: string | null;
  decision: "GO" | "NO_GO" | "SKIPPED";
  rejectReason?: string | null;
  knnProb?: number | null;
  knnN?: number | null;
  drexProb?: number | null;
  drexStrength?: number | null;
  compositeScore?: number | null;
  trendScore?: number | null;
  regime?: string | null;
  er?: number | null;
  choppiness?: number | null;
  adx?: number | null;
  atrPct?: number | null;
  pocDistanceBins?: number | null;
  /** Big Brain B4: perubahan Open Interest % (~30 menit). */
  oiChangePct?: number | null;
  /** Big Brain B4: beta simbol terhadap BTC (5m). */
  betaBtc?: number | null;
  macroAllowed?: boolean | null;
  cooldownAgeMs?: number | null;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Tulis satu baris DecisionLog. Kembalikan id (null bila gagal — fail-open). */
export async function logDecision(f: DecisionFeatures): Promise<number | null> {
  try {
    const row = await db.decisionLog.create({
      data: {
        symbol: f.symbol,
        side: f.side,
        mode: f.mode,
        strategyId: f.strategyId ?? null,
        decision: f.decision,
        rejectReason: f.rejectReason ?? null,
        knnProb: finiteOrNull(f.knnProb),
        knnN: finiteOrNull(f.knnN),
        drexProb: finiteOrNull(f.drexProb),
        drexStrength: finiteOrNull(f.drexStrength),
        compositeScore: finiteOrNull(f.compositeScore),
        trendScore: finiteOrNull(f.trendScore),
        regime: f.regime ?? null,
        er: finiteOrNull(f.er),
        choppiness: finiteOrNull(f.choppiness),
        adx: finiteOrNull(f.adx),
        atrPct: finiteOrNull(f.atrPct),
        pocDistanceBins: finiteOrNull(f.pocDistanceBins),
        oiChangePct: finiteOrNull(f.oiChangePct),
        betaBtc: finiteOrNull(f.betaBtc),
        macroAllowed: typeof f.macroAllowed === "boolean" ? f.macroAllowed : null,
        cooldownAgeMs: finiteOrNull(f.cooldownAgeMs),
      },
    });
    return row.id;
  } catch (err) {
    // Fail-open: logging tidak boleh menggagalkan trading, tapi tidak boleh hening.
    logger.error({ err: err instanceof Error ? err.message : String(err), symbol: f.symbol }, "DECISION_LOG_WRITE_FAIL");
    return null;
  }
}

/** Hubungkan keputusan GO dengan posisi yang benar-benar terbentuk (untuk JOIN kalibrasi). */
export async function linkDecisionToPosition(decisionLogId: number | null, positionId: number): Promise<void> {
  if (decisionLogId === null || !Number.isFinite(positionId)) return;
  try {
    await db.decisionLog.update({ where: { id: decisionLogId }, data: { positionId } });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), decisionLogId, positionId }, "DECISION_LOG_LINK_FAIL");
  }
}
