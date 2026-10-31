// apps/server/src/strategies/strategyCatalog.ts
// KATALOG STRATEGI AKTIF. Setiap strategi punya basis entry/SL/TP yang
// dievaluasi deterministik di TS (LLM hanya menilai, tidak menghitung).
//
// RENUMBER 6 Okt 2026 (perintah operator: "strategi yang lama hapus saja,
// cukup pakai strategi yang gw pakai aja, jadi ada 3 strategi"):
//   S-01 Liquidity Sweep Reclaim      (eks S-03 sampai cutover 6 Okt 2026)
//   S-02 Liquidity Sniper             (eks S-04 sampai cutover 6 Okt 2026)
//   S-03 Fibonacci Zone 0.5-0.618     (BARU — semua pair crypto; entry zona
//        0.5-0.618 + TP dipaksa 1.5R sejak 7 Okt 2026)
// DIHAPUS dari katalog & allowlist 6 Okt 2026 (perintah operator):
//   Squeeze Breakout Scalp, FVG Continuation, HA Smooth Scalper,
//   ORB Session Breakout & semua strategi freeze lama, S-00/S-06.
//
// Riwayat trade TIDAK diubah satu baris pun. Nomor pernah dipakai ulang
// (29 Sep 2026 dan 6 Okt 2026), jadi pembacaan riwayat memakai TANGGAL trade
// lewat strategyDisplayName()/canonicalStrategyKey() — trade lama tetap tampil
// dengan nama strateginya yang benar pada masanya.
import type { TradingModeName } from "../config/timeframes.js";

export type EntryBasis = "MARKET_BREAKOUT" | "LIMIT_ZONE" | "MARKET_PULLBACK" | "FIB_RETRACEMENT" | "MEAN_REVERSION_STRETCH";
export type SlBasis = "ZONE_INVALIDATION" | "STRUCTURE_INVALIDATION" | "RANGE_EDGE" | "SQUEEZE_EXTREME" | "SUPERTREND_BAND" | "SWEEP_EXTREME" | "LIQUIDITY_WALL" | "FIB_SWING_EXTREME" | "ATR_R_MULTIPLE";
export type TpBasis = "NEXT_ZONE" | "STRUCTURE_TARGET" | "RANGE_PROJECTION" | "R_MULTIPLE";

export interface StrategySpec {
  id: string;
  name: string;
  // 30 Sep 2026 — refactor SCALP-only: mode spesifik SCALP (tidak ada BOTH).
  mode: TradingModeName;
  entryBasis: EntryBasis;
  slBasis: SlBasis;
  tpBasis: TpBasis;
  description: string;
}

export const STRATEGY_SPECS: StrategySpec[] = [
  {
    id: "S-01",
    name: "Liquidity Sweep Reclaim",
    mode: "SCALP",
    entryBasis: "LIMIT_ZONE",
    slBasis: "SWEEP_EXTREME",
    tpBasis: "R_MULTIPLE",
    description:
      "Likuiditas sesi (high/low hari sebelumnya atau range Asia) disapu minimal X ATR, lalu harga RECLAIM level itu dengan displacement searah balasan. Entry setelah reclaim, SL di ekstrem sweep (invalidation), target tunggal 1.5R. Sumber: 'Liquidity Sweep Session [TradingFinder] ICT Killzone Times'.",
  },
  {
    id: "S-02",
    name: "Liquidity Sniper",
    mode: "SCALP",
    entryBasis: "MARKET_PULLBACK",
    slBasis: "LIQUIDITY_WALL",
    tpBasis: "R_MULTIPLE",
    description:
      "Liquidity Sniper (Alpha_Wizard): peta likuiditas dari liquidation engine tier leverage (100x/50x/25x/10x) + stop pools pivot yang di-merge jadi wall, lalu magnet atas/bawah + liquidity pull bias. Arah trade mengikuti sisi yang lebih menarik harga: pullBias UP -> LONG menuju short magnet, DOWN -> SHORT menuju long magnet. SL di belakang magnet berlawanan (invalidasi likuiditas), target tunggal 1.5R.",
  },
  // CATATAN 20 Okt 2026 (perintah operator: "hapus juga S-04 di strategi
  // scalp") — S-04 Mean-Reversion Stretch + Trend Gate DIHAPUS dari katalog
  // AKTIF. ID S-04 tetap punya arti historis (era 1/2, lihat
  // RETIRED_STRATEGY_NAMES + ERA2_STRATEGY_NAMES) supaya trade lama tidak
  // salah label. Strategi aktif sekarang: S-01, S-02 (SCALP) +
  // S-05, RSW-01/02/03 (SWING).
  // CATATAN 20 Okt 2026 (perintah operator: "polaris hapus juga / yang S-05
  // itu") — S-05 "Swing Breakout Pattern" (Polaris) DIHAPUS dari katalog
  // AKTIF. Bukti: master_v2 executed n=1.391, PF 0.7503, P(EV<=0)=99.9%,
  // 2026 PF 0.452, walk-forward train 0.867 -> test 0.642 = EDGE NEGATIF.
  // ID S-05 TETAP punya arti historis (era-1/2/3/4) supaya trade lama tidak
  // salah label — lihat ERA2/ERA3_STRATEGY_NAMES + canonicalStrategyKey.
  // Strategi aktif sekarang: S-01, S-02 (SCALP) + RSW-01/02/03 (SWING).
  {
    id: "RSW-01",
    name: "RSW BOS D1 + PHEN Locked",
    mode: "SWING",
    entryBasis: "LIMIT_ZONE",
    slBasis: "ATR_R_MULTIPLE",
    tpBasis: "R_MULTIPLE",
    description:
      "RSW-01 (port riset 'LONG_BOS_D1_SHORT_LOCKED_PHEN'): BOS_LIMIT_RETEST LONG pada H4 yang digate BTC_D1_ALIGN (BTC D1 EMA50/200 searah) + PHEN_FADE_LIMIT SHORT (compressed range break). Entry LIMIT pada close/retrace H4; SL struktural/ATR (max(1.5 ATR, 1% close), cap 6%); exit RR23 riset 1:3 (50% @ 2R -> BE -> 50% @ 3R). PAPER-only; evaluator di strategies/researchSwing/.",
  },
  {
    id: "RSW-02",
    name: "RSW PHEN Profile + PHEN Locked",
    mode: "SWING",
    entryBasis: "LIMIT_ZONE",
    slBasis: "ATR_R_MULTIPLE",
    tpBasis: "R_MULTIPLE",
    description:
      "RSW-02 (port riset 'LONG_PHEN_PROFILE_SHORT_LOCKED_PHEN'): PHEN_FADE_LIMIT LONG digate PROFILE_CONTEXT (POC/VWAP96 searah, RVOL>=1, CLV>=0.6) dengan SL struktural + PHEN_FADE_LIMIT SHORT (locked control). Entry LIMIT pada close/retrace H4; exit RR23 riset 1:3 (50% @ 2R -> BE -> 50% @ 3R). PAPER-only; evaluator di strategies/researchSwing/.",
  },
  {
    id: "RSW-03",
    name: "RSW AlgoChief Fade + Ridge",
    mode: "SWING",
    entryBasis: "LIMIT_ZONE",
    slBasis: "ATR_R_MULTIPLE",
    tpBasis: "R_MULTIPLE",
    description:
      "RSW-03 (port riset swing_paper_signals.algo_signals): AlgoChief SHORT edge (H1) + H4 ADX<25 + retracement entry 0.25 ATR + gate model Ridge (vector·beta >= 0, seed riset SHORT-only). SL struktural (max high 5 bar + 0.25 ATR); exit RR23 riset 1:3 (50% @ 2R -> BE -> 50% @ 3R). PAPER-only; evaluator di strategies/researchSwing/.",
  },
];

// ── 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu") ──
// S-03 Fibonacci Zone 0.5-0.618 DIHAPUS dari katalog AKTIF (SCALP + SWING).
// ID S-03 TETAP ADA sebagai peta histori era (lihat ERA2/ERA3_STRATEGY_NAMES
// dan RETIRED_NAME_CUTOFF_MS) supaya trade lama tidak salah label.
// Strategi aktif sekarang: S-01, S-02 (SCALP) + RSW-01/02/03 (SWING).

export const STRATEGY_NAMES: Record<string, string> = Object.fromEntries(
  STRATEGY_SPECS.filter((spec, index, all) => all.findIndex((entry) => entry.id === spec.id) === index).map((s) => [s.id, s.name])
);

/** ID yang tidak punya arti lagi di sistem (dipakai hanya untuk bucket arsip).
 * CATATAN 7 Okt 2026: "S-04" DIKELUARKAN dari daftar ini karena nomornya resmi
 * dipakai ulang sebagai strategi aktif baru (Mean-Reversion Stretch + Trend
 * Gate). Trade lama tetap dibaca era-aware via strategyDisplayName (tanggal). */
export const RETIRED_STRATEGY_IDS = ["S-05", "S-06"] as const;

/**
 * 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05 dihapus
 * dari katalog AKTIF, tapi mesinnya (swingBreakoutEngine) tetap hidup untuk
 * REPLAY HISTORIS (operator akan meracik backtest dari strategi lain).
 * Spec arsip ini dipakai HANYA oleh historicalReplay (offline), TIDAK pernah
 * oleh jalur entry. Dipisah dari STRATEGY_SPECS supaya S-05 tidak muncul
 * lagi di katalog API/allowlist.
 */
export const ARCHIVE_SWING_BREAKOUT_SPEC: StrategySpec = {
  id: "S-05",
  name: "Swing Breakout Pattern",
  mode: "SWING",
  entryBasis: "MARKET_BREAKOUT",
  slBasis: "STRUCTURE_INVALIDATION",
  tpBasis: "STRUCTURE_TARGET",
  description:
    "ARSIP (20 Okt 2026) — replay historis saja. S-05 dihapus dari katalog aktif: master_v2 executed PF 0.7503, P(EV<=0)=99.9%, 2026 PF 0.452 = edge negatif.",
};

/** Batas waktu cutover RENUMBER 29 Sep 2026 (katalog 5 strategi mulai berlaku). */
export const RETIRED_NAME_CUTOFF_MS = Date.parse("2026-09-29T00:00:00+07:00");

/**
 * Batas waktu cutover RENUMBER 6 Okt 2026 (katalog 3 strategi mulai berlaku).
 * Nilainya = waktu service lama dihentikan sebelum deploy build 3-strategi
 * (18:02:09 WIB); trade SEBELUM ini memakai nomor dengan arti era 29 Sep
 * (S-03 = Sweep, S-04 = Sniper), SESUDAH ini memakai arti baru
 * (S-01 = Sweep, S-02 = Sniper, S-03 = Fibonacci).
 */
export const RENUMBER_CUTOFF_MS = Date.parse("2026-10-06T18:02:09+07:00");

/**
 * Batas waktu cutover ZONA ENTRY S-03 (7 Okt 2026). Trade S-03 yang DIBUKA
 * sebelum ini memakai nama era sebelumnya ("Fibonacci 0.618 Retracement"),
 * sesudah ini memakai nama baru ("Fibonacci Zone 0.5-0.618") — era dibaca dari
 * position.openedAt, sama seperti RENUMBER_CUTOFF_MS. Nilai = waktu service
 * lama dihentikan sebelum deploy build zona (di-set persis saat deploy).
 */
export const FIB_ZONE_CUTOFF_MS = Date.parse("2026-10-07T04:52:00+08:00");

/**
 * Batas waktu cutover S-05 (13 Okt 2026 — perintah operator: "Swing semua
 * untuk Live trading dan paper mode backtest di website"). Nomor S-05 dipakai
 * ulang: sebelum ini S-05 = era 2 "HA Smooth Scalper" (arsip); SESUDAH
 * SWING_CUTOFF_MS S-05 = "Swing Breakout Pattern" (aktif, exit RR23 50/2R/3R).
 * Trade S-05 yang DIBUKA sebelum cutover tetap tampil dengan nama era lamanya
 * (era dibaca dari position.openedAt / trade timestamp).
 */
export const SWING_CUTOFF_MS = Date.parse("2026-10-13T22:00:00+07:00");

/** Nama era 1 (trade sebelum cutover 29 Sep 2026; nomor lama, arti beda). */
export const RETIRED_STRATEGY_NAMES: Record<string, string> = {
  "S-02": "Zona Rejection Scalp (retired)",
  "S-04": "Trend Pullback (retired)",
  "S-05": "ORB Session Breakout (retired)",
};

/** Nama era 2 (katalog 5 strategi, 29 Sep 2026 s/d cutover 6 Okt 2026). */
export const ERA2_STRATEGY_NAMES: Record<string, string> = {
  "S-01": "Squeeze Breakout Scalp",
  "S-02": "FVG Continuation",
  "S-03": "Liquidity Sweep Reclaim",
  "S-04": "Liquidity Sniper",
  "S-05": "HA Smooth Scalper",
};

/** Nama era 3 (13 Okt 2026 — S-05 dipakai ulang sebagai Swing Breakout Pattern). */
export const ERA3_STRATEGY_NAMES: Record<string, string> = {
  "S-05": "HA Smooth Scalper (retired 13 Okt 2026)",
};

/**
 * Nomor strategi yang punya arti ganda secara historis karena nomornya
 * DIPAKAI ULANG oleh katalog baru. Konstanta ini TIDAK berarti "jangan
 * dievaluasi" — nomor barunya aktif; ia hanya menandai bahwa pembacaan riwayat
 * harus memakai tanggal trade (lihat strategyDisplayName).
 */

/** 19 Okt 2026: nama tampilan empat strategi SWING PAPER (ID tidak berubah). */
export const FOUR_STRATEGY_CUTOFF_MS = Date.parse("2026-10-19T00:00:00+07:00");
export const FOUR_STRATEGY_DISPLAY_NAMES: Record<string, string> = {
  "S-05": "Polaris",
  "RSW-01": "Orion",
  "RSW-02": "Vega",
  "RSW-03": "Draco",
};

/**
 * 20 Okt 2026 (perintah operator: "untuk yang fibo tolong hapus itu") — S-03
 * Fibonacci DIHAPUS dari katalog aktif. ID-nya tetap punya arti historis:
 * trade S-03 yang sudah terjadi harus tetap tampil sebagai Fibonacci (bukan
 * "Strategi arsip"), jadi era 4 dicatat terpisah di sini.
 */
export const FIB_REMOVED_CUTOFF_MS = Date.parse("2026-10-20T00:00:00+07:00");
export const ERA4_RETIRED_NAMES: Record<string, string> = {
  // Label TIDAK diberi suffix "(retired ...)": invariant AGENT.md "label
  // history 100% benar" = trade lama harus tampil dengan nama strategist
  // PADA SAAT trade itu terjadi, persis seperti yang tercatat waktu itu.
  // Suffiks "(retired 20 Okt 2026)" mengubah label history jadi tidak sama
  // dengan catatan aslinya — itu pelanggaran invariant, bukan informasi baru.
  // Status arsip sudah tercermin di bucket kanonik "S-99" (canonicalStrategyKey)
  // + archivedSwingStrategies di API, jadi tidak perlu di moniker nama.
  "S-03": "Fibonacci Zone 0.5-0.618",
  "S-04": "Mean-Reversion Stretch + Trend Gate",
  // 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu") — S-05
  // "Swing Breakout Pattern" (nama operator "Polaris" sejak 19 Okt) dihapus
  // dari katalog aktif. Label history tetap PERSIS seperti tercatat waktu
  // itu: "Swing Breakout Pattern" untuk era 13-19 Okt, "Polaris" >= 19 Okt.
  "S-05": "Swing Breakout Pattern",
};

/** Nama tampilan satu strategi untuk sebuah trade (era-aware, anti salah label). */
export function strategyDisplayName(
  id: string,
  tradeAt?: Date | number | string | null,
  fallback?: string | null
): string {
  const key = String(id ?? "").toUpperCase();
  const atMs =
    tradeAt instanceof Date ? tradeAt.getTime()
      : typeof tradeAt === "number" ? tradeAt
        : typeof tradeAt === "string" ? Date.parse(tradeAt)
          : NaN;
  if (Number.isFinite(atMs)) {
    // 20 Okt 2026 (AU1-05, MAJOR): S-03 Fibonacci dihapus dari katalog aktif,
    // tapi label era-1/era-2 TIDAK boleh ikut berubah. Percabangan S-03/S-04
    // WAJIB di-guard `atMs >= RENUMBER_CUTOFF_MS` (6 Okt 2026 18:02) supaya
    // trade lama (era-1 < 29 Sep, era-2 29 Sep-6 Okt) — yang artinya
    // "Liquidity Sweep Reclaim" (S-01) dan "Trend Pullback"/"Liquidity Sniper"
    // (S-02) — jatuh ke peta era di bawah, bukan ke label Fibonacci/MRV.
    // Tanpa guard ini, trade era-1/era-2 S-03 salah label "Fibonacci 0.618
    // Retracement" = pelanggaran invariant AGENT.md "label history 100% benar".
    //
    // Era 4 (>= RENUMBER_CUTOFF_MS): S-03 = Fibonacci, S-04 = MRV Stretch.
    if (key === "S-03" && atMs >= RENUMBER_CUTOFF_MS) {
      if (atMs < FIB_ZONE_CUTOFF_MS) return "Fibonacci 0.618 Retracement";
      return ERA4_RETIRED_NAMES["S-03"]!;
    }
    // S-04 era MRV (setelah renumber 6 Okt 2026) tetap tampil sebagai MRV
    // Stretch (retired). Trade lebih lama mengikuti peta era di bawah
    // (era 1 = Trend Pullback, era 2 = Liquidity Sniper -> S-02).
    if (key === "S-04" && atMs >= RENUMBER_CUTOFF_MS) {
      return ERA4_RETIRED_NAMES["S-04"]!;
    }
    // Nama operator berlaku untuk trade/entry baru; histori sebelum cutover
    // tetap memakai nama era/teknis lama.
    if (atMs >= FOUR_STRATEGY_CUTOFF_MS && FOUR_STRATEGY_DISPLAY_NAMES[key]) return FOUR_STRATEGY_DISPLAY_NAMES[key]!;
    if (atMs < RETIRED_NAME_CUTOFF_MS && RETIRED_STRATEGY_NAMES[key]) return RETIRED_STRATEGY_NAMES[key]!;
    if (atMs < RENUMBER_CUTOFF_MS && ERA2_STRATEGY_NAMES[key]) return ERA2_STRATEGY_NAMES[key]!;
    // Era S-05: sebelum SWING_CUTOFF_MS (13 Okt 2026) nomor S-05 = era 2
    // "HA Smooth Scalper" (arsip); sesudahnya = era 4 "Swing Breakout Pattern"
    // (nama operator "Polaris" sejak 19 Okt 2026, lihat FOUR_STRATEGY_DISPLAY_NAMES).
    // 20 Okt 2026: S-05 dihapus dari katalog AKTIF -> era 4 (>= SWING_CUTOFF_MS)
    // memakai label historis ERA4_RETIRED_NAMES["S-05"], BUKAN nama katalog
    // aktif (sudah tidak ada). Tanpa ini trade S-05 lama jatuh ke
    // "Strategi arsip (nonaktif)" = kehilangan nama aslinya.
    if (key === "S-05") {
      if (atMs < SWING_CUTOFF_MS) return ERA2_STRATEGY_NAMES["S-05"] ?? ERA3_STRATEGY_NAMES["S-05"]!;
      return ERA4_RETIRED_NAMES["S-05"]!;
    }
    // A historical timestamp before the four-strategy cutover must keep the
    // historical/ technical name; only new rows get the operator displayName.
    return STRATEGY_NAMES[key] ?? fallback ?? "Strategi arsip (nonaktif)";
  }
  return FOUR_STRATEGY_DISPLAY_NAMES[key] ?? STRATEGY_NAMES[key]
    ?? ERA4_RETIRED_NAMES[key] ?? fallback ?? "Strategi arsip (nonaktif)";
}

/**
 * Kunci kanonik satu strategi untuk agregasi statistik lintas renumber.
 * Trade era lama dipetakan ke ID barunya bila strateginya masih hidup
 * (S-03 lama -> S-01, S-04 lama -> S-02); strategi yang dihapus masuk "S-99".
 */
export function canonicalStrategyKey(
  id: string,
  tradeAt?: Date | number | string | null
): string {
  const key = String(id ?? "").toUpperCase();
  const atMs =
    tradeAt instanceof Date ? tradeAt.getTime()
      : typeof tradeAt === "number" ? tradeAt
        : typeof tradeAt === "string" ? Date.parse(tradeAt)
          : NaN;
  const renumbered = Number.isFinite(atMs) && atMs < RENUMBER_CUTOFF_MS;
  if (renumbered) {
    if (key === "S-03") return "S-01"; // Liquidity Sweep Reclaim
    if (key === "S-04") return "S-02"; // Liquidity Sniper
    return "S-99"; // Squeeze / FVG / HA / nomor era 1 = arsip
  }
  // 13 Okt 2026: S-05 dipakai ulang — trade S-05 SEBELUM SWING_CUTOFF_MS adalah
  // era 2 (HA Smooth Scalper) = arsip; sesudahnya = S-05 baru (Swing Breakout).
  if (key === "S-05" && Number.isFinite(atMs) && atMs < SWING_CUTOFF_MS) return "S-99";
  // 20 Okt 2026: S-03 Fibonacci dihapus dari katalog aktif. Trade S-03 era
  // Fibonacci (setelah RENUMBER_CUTOFF_MS) tidak lagi punya strategi hidup
  // -> masuk bucket arsip "S-99", bukan ikut teragregasi ke ID lain.
  if (key === "S-03" && Number.isFinite(atMs) && atMs >= RENUMBER_CUTOFF_MS) return "S-99";
  // 20 Okt 2026: S-04 MRV Stretch dihapus -> trade era-MRV masuk bucket arsip.
  if (key === "S-04" && Number.isFinite(atMs) && atMs >= RENUMBER_CUTOFF_MS) return "S-99";
  // 20 Okt 2026 (operator: "polaris hapus juga / yang S-05 itu"): S-05 Swing
  // Breakout Pattern dihapus dari katalog aktif -> trade S-05 era-4 (>= 13 Okt)
  // juga masuk bucket arsip "S-99" (tidak ada strategi hidup untuk ID itu).
  if (key === "S-05" && Number.isFinite(atMs) && atMs >= SWING_CUTOFF_MS) return "S-99";
  return STRATEGY_NAMES[key] ? key : "S-99";
}

export function getStrategySpec(id: string, mode?: TradingModeName): StrategySpec | null {
  return STRATEGY_SPECS.find((s) => s.id === id && (!mode || s.mode === mode)) ?? null;
}

/** Kembalikan strategi spesifik sesuai mode (SCALP, SWING, atau ALL). */
export function strategiesForMode(mode: string): StrategySpec[] {
  const m = String(mode ?? "").toUpperCase();
  if (m === "SCALP") return STRATEGY_SPECS.filter((s) => s.mode === "SCALP");
  if (m === "SWING") return STRATEGY_SPECS.filter((s) => s.mode === "SWING");
  return [...STRATEGY_SPECS];
}
