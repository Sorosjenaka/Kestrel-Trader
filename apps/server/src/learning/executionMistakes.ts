// SMB T-01 (9 Okt 2026): taksonomi + detektor KESALAHAN EKSEKSI (proses),
// terpisah dari causeCode pasar di postMortemEvaluator. 100% deterministik TS
// (Golden Rules #1) — LLM tidak menghitung angka di sini.
//
// Prinsip SMB "Unfiltered Mistakes": akui kesalahan apa adanya tanpa menghapus
// konteks trade; hasil klasifikasi disimpan di LearningEntry (kolom baru) dan
// tidak pernah mengubah/membuang narasi penyebab pasar.
export const EXECUTION_MISTAKES = [
  "MISTAKE_NONE",
  "MISTAKE_SIZING",
  "MISTAKE_STOP_PLACEMENT",
  "MISTAKE_EARLY_EXIT",
  "MISTAKE_PLAN_DEVIATION",
  "MISTAKE_REVENGE",
  "MISTAKE_LATE",
] as const;
export type ExecutionMistake = (typeof EXECUTION_MISTAKES)[number];

export function isExecutionMistakeCode(value: unknown): value is ExecutionMistake {
  return typeof value === "string" && (EXECUTION_MISTAKES as readonly string[]).includes(value);
}

/** Exit baku sistem sejak 30 Sep 2026: SL statis, TP tunggal, TREND_FLIP. */
export const STANDARD_EXIT_REASONS = new Set(["SL", "TP1", "TP2", "TREND_FLIP"]);
/** Exit non-baku yang berarti posisi ditutup sebelum plan selesai (indikasi proses). */
const EARLY_EXIT_REASONS = new Set(["KILL", "TIMEOUT", "FUNDING"]);

/** Baseline risiko per trade (Golden Rules #4: <= $1). */
export const TARGET_RISK_BASELINE_USD = 1;

export const MISTAKE_THRESHOLDS = {
  /** Deviasi risiko sizing dari baseline yang masih wajar (10%). */
  SIZING_DEVIATION_TOL: 0.10,
  /** SL eksekusi boleh beda dari rencana maksimal 0.5% (di atas itu = digeser). */
  SL_MOVE_TOL: 0.005,
  /** Fill exit boleh meleset dari level rencana maksimal 2% jarak R (slippage wajar). */
  EXIT_FILL_DEVIATION_TOL: 0.02,
  /** Re-entry simbol yang sama dalam janela ini setelah SL = kandidat revenge. */
  REVENGE_REENTRY_WINDOW_MS: 15 * 60_000,
} as const;

export interface ExecutionMistakeInput {
  riskUsd: number;
  /** Baseline risiko per trade (Rules: $1). */
  targetRiskUsd: number;
  closeReason: string | null;
  entryAvg: number;
  exitAvg: number;
  plannedSlPrice: number | null;
  /** SL yang benar-benar terpasang saat close (Position.slPrice). */
  executedSlPrice: number | null;
  /** Only set from a versioned PAPER position with a confirmed TP1 milestone. */
  authorizedBreakeven?: boolean;
  plannedTp1Price: number | null;
  side: string;
  /** Trade sebelumnya pada simbol yang sama (urutan waktu lama->baru), opsional. */
  priorSymbolTrades?: Array<{ closedAt: Date | null; closeReason: string | null; win: boolean; openedAt: Date | null }>;
  openedAt?: Date | null;
}

export interface ExecutionMistakeResult {
  mistake: ExecutionMistake;
  isMistake: boolean;
  /** Rasio deviasi fill exit terhadap jarak R rencana (null bila tak terukur). */
  planDeviationRatio: number | null;
  /** Catatan semua check yang dijalankan (jujur, termasuk yang lolos). */
  notes: string[];
}

/**
 * Klasifikasi deterministik satu trade. Prioritas: kesalahan paling berat
 * lebih dulu (EARLY_EXIT > STOP_PLACEMENT > SIZING > PLAN_DEVIATION > REVENGE).
 * MISTAKE_LATE membutuhkan data waktu trigger vs entry yang belum direkam —
 * enum dipertahankan, deteksi ditandai tidak terukur (jujur, bukan dipaksa).
 */
export function detectExecutionMistake(input: ExecutionMistakeInput): ExecutionMistakeResult {
  const notes: string[] = [];
  const t = MISTAKE_THRESHOLDS;
  let planDeviationRatio: number | null = null;
  const validBe = input.authorizedBreakeven === true && input.executedSlPrice != null
    && Math.abs(input.executedSlPrice - input.entryAvg) <= Math.max(1e-9, Math.abs(input.entryAvg) * 1e-10);

  // 1. Exit di luar aturan baku (SL/TP/TREND_FLIP) = early exit.
  const reason = String(input.closeReason ?? "").toUpperCase();
  if (EARLY_EXIT_REASONS.has(reason)) {
    notes.push(`EARLY_EXIT: closeReason=${reason} di luar exit baku (SL/TP1/TREND_FLIP)`);
    return { mistake: "MISTAKE_EARLY_EXIT", isMistake: true, planDeviationRatio: null, notes };
  }

  // 2. SL digeser dari rencana (SL->BE sudah dihapus dari sistem; gerakan apa pun = deviasi).
  if (input.plannedSlPrice != null && input.executedSlPrice != null
    && Number.isFinite(input.plannedSlPrice) && Number.isFinite(input.executedSlPrice)
    && input.plannedSlPrice > 0) {
    const slMove = Math.abs(input.executedSlPrice - input.plannedSlPrice) / input.plannedSlPrice;
    if (slMove > t.SL_MOVE_TOL && !validBe) {
      notes.push(`STOP_PLACEMENT: SL eksekusi bergeser ${(slMove * 100).toFixed(3)}% dari rencana (tol ${t.SL_MOVE_TOL * 100}%)`);
      return { mistake: "MISTAKE_STOP_PLACEMENT", isMistake: true, planDeviationRatio: null, notes };
    }
    notes.push(validBe ? "SL check OK: authorized entry BE after confirmed TP1" : `SL check OK: pergeseran ${(slMove * 100).toFixed(3)}% <= ${t.SL_MOVE_TOL * 100}%`);
  } else {
    notes.push("SL check SKIP: planned/executed SL tidak lengkap");
  }

  // 3. Deviasi sizing dari baseline risiko.
  if (Number.isFinite(input.riskUsd) && Number.isFinite(input.targetRiskUsd) && input.targetRiskUsd > 0) {
    const sizingDev = Math.abs(input.riskUsd - input.targetRiskUsd) / input.targetRiskUsd;
    if (sizingDev > t.SIZING_DEVIATION_TOL) {
      notes.push(`SIZING: risiko ${input.riskUsd.toFixed(4)} menyimpang ${(sizingDev * 100).toFixed(1)}% dari baseline ${input.targetRiskUsd} (tol ${t.SIZING_DEVIATION_TOL * 100}%)`);
      return { mistake: "MISTAKE_SIZING", isMistake: true, planDeviationRatio: null, notes };
    }
    notes.push(`Sizing check OK: deviasi ${(sizingDev * 100).toFixed(1)}% <= ${t.SIZING_DEVIATION_TOL * 100}%`);
  }

  // 4. Deviasi fill exit dari level rencana (planDeviationRatio) — slippage wajar ditoleransi.
  const slDist = input.plannedSlPrice != null && input.entryAvg > 0
    ? Math.abs(input.entryAvg - input.plannedSlPrice) : null;
  if (slDist && slDist > 0) {
    if (reason === "TP1" && input.plannedTp1Price != null && Number.isFinite(input.plannedTp1Price)) {
      planDeviationRatio = Math.abs(input.exitAvg - input.plannedTp1Price) / slDist;
    } else if (reason === "SL" && input.plannedSlPrice != null && !validBe) {
      planDeviationRatio = Math.abs(input.exitAvg - input.plannedSlPrice) / slDist;
    }
    if (validBe && reason === "SL") notes.push("Plan deviation SKIP: aggregate TP1+BE exit needs per-leg fill evidence, not a single original SL comparison");
    if (planDeviationRatio !== null && planDeviationRatio > t.EXIT_FILL_DEVIATION_TOL) {
      notes.push(`PLAN_DEVIATION: fill exit meleset ${planDeviationRatio.toFixed(3)}R dari level rencana (tol ${t.EXIT_FILL_DEVIATION_TOL})`);
      return { mistake: "MISTAKE_PLAN_DEVIATION", isMistake: true, planDeviationRatio, notes };
    }
    if (planDeviationRatio !== null) notes.push(`Plan deviation OK: ${planDeviationRatio.toFixed(3)}R <= ${t.EXIT_FILL_DEVIATION_TOL}R`);
  } else {
    notes.push("Plan deviation SKIP: jarak SL rencana tidak terukur");
  }

  // 5. Revenge: re-entry simbol sama dalam janela pendek setelah trade sebelumnya SL/rugi.
  if (Array.isArray(input.priorSymbolTrades) && input.priorSymbolTrades.length > 0 && input.openedAt) {
    const prior = input.priorSymbolTrades[input.priorSymbolTrades.length - 1]!;
    if (prior.closedAt && prior.closeReason === "SL" && prior.win === false) {
      const gapMs = input.openedAt.getTime() - prior.closedAt.getTime();
      if (gapMs >= 0 && gapMs <= t.REVENGE_REENTRY_WINDOW_MS) {
        notes.push(`REVENGE: re-entry ${Math.round(gapMs / 1000)} dtk setelah SL sebelumnya pada simbol sama (jendela ${t.REVENGE_REENTRY_WINDOW_MS / 60000} mnt)`);
        return { mistake: "MISTAKE_REVENGE", isMistake: true, planDeviationRatio, notes };
      }
      notes.push(`Revenge check OK: jarak dari SL sebelumnya ${Math.round(gapMs / 1000)} dtk > janela`);
    } else {
      notes.push("Revenge check OK: trade sebelumnya bukan SL rugi");
    }
  }

  // 6. MISTAKE_LATE: butuh timestamp trigger vs fill yang belum direkam sistem.
  notes.push("LATE check SKIP: data waktu trigger belum direkam (enum tersedia untuk masa depan)");
  notes.push("Verdict: MISTAKE_NONE — tidak ada kesalahan eksekusi terukur pada trade ini");
  return { mistake: "MISTAKE_NONE", isMistake: false, planDeviationRatio, notes };
}

// ── SMB T-03: agregasi kesalahan berulang (jendela N trade terakhir) ──

export const RECURRING_MISTAKE_WINDOW = 20;

export interface RecurringMistakeFinding {
  mistake: ExecutionMistake;
  occurrences: number;
  windowTrades: number;
}

/**
 * Hitung tipe kesalahan yang muncul >= ambang (3) dalam jendela.
 * `codes` diurutkan terbaru -> terlama; MISTAKE_NONE diabaikan.
 */
export function detectRecurringMistakes(codes: Array<string | null | undefined>, windowTrades = RECURRING_MISTAKE_WINDOW, minOccurrences = 3): RecurringMistakeFinding[] {
  const window = codes.slice(0, windowTrades);
  const counts = new Map<ExecutionMistake, number>();
  for (const code of window) {
    if (typeof code !== "string" || code === "MISTAKE_NONE" || !isExecutionMistakeCode(code)) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const out: RecurringMistakeFinding[] = [];
  for (const [mistake, occurrences] of counts) {
    if (occurrences >= minOccurrences) out.push({ mistake, occurrences, windowTrades: window.length });
  }
  return out.sort((a, b) => b.occurrences - a.occurrences);
}
