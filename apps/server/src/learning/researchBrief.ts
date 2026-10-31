// apps/server/src/learning/researchBrief.ts
// TAHAP RESEARCH (loop 8 tahap). Semua angka deterministik (Golden Rules #1);
// LLM TIDAK dipanggil di file ini. Mengubah trade tertutup menjadi ringkasan
// + hipotesis bounded yang dibaca tahap BUILD.
//
// 8 Okt 2026 (perintah operator):
//  (1) FIX era-mixed: grouping kini ERA-AWARE lewat canonicalStrategyKey()
//      (waktu BUKA posisi menentukan makna nomor, pitfall renumber 6 Okt 2026)
//      — sebelumnya label mentah S-01..S-04 dicampur antar era di laporan.
//  (2) EV/total kini BERSIH-FEE Binance futures (maker 0.02% / taker 0.05%,
//      config/costs.ts) — dihitung TS dari notional, bukan LLM.
import { estimateTradeFeeUsd } from "../config/costs.js";
import { canonicalStrategyKey } from "../strategies/strategyCatalog.js";
import type { TradeForEvaluation } from "./postMortemEvaluator.js";

export interface StrategyStat {
  strategyId: string;
  trades: number;
  wins: number;
  winRatePct: number;
  evUsd: number;
  profitFactor: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** Jumlah trade dengan fee tercatat; legacy fee=0 bukan bukti net. */
  feeCoveredTrades?: number;
  /** Jumlah trade dengan funding terverifikasi. */
  fundingVerifiedTrades?: number;
  fundingCoverage?: "RECORDED" | "UNKNOWN" | "ZERO_LEGACY";
  accountingQuality?: "VERIFIED" | "ESTIMATED" | "LEGACY";
}

export interface Hypothesis {
  strategyId: string;
  param: "tp1R" | "pullBiasThreshold";
  from: number;
  to: number;
  rationale: string;
}

/**
 * Knob runtime yang benar-benar bisa digerakkan per strategi.
 * tp1R dikunci tepat 1.5R oleh operator (setupEngine.ts setRuntimeTp1R, 2 Okt 2026),
 * sehingga strategi tanpa knob lain tidak bisa diusulkan perubahannya.
 * 8 Okt 2026: kunci dipetakan ke ID KANONIK (S-02 = Liquidity Sniper, pemilik
 * pullBiasThreshold) — sebelumnya ID era lama "S-04".
 */
export const KNOB_BY_STRATEGY: Record<string, "tp1R" | "pullBiasThreshold"> = {
  "S-02": "pullBiasThreshold",
};

/**
 * PnL bersih satu trade untuk EVALUASI strategi (standar fee adil).
 *
 * `pnlUsd` di DB adalah NET (fee sudah termasuk, lihat config/costs.ts), maka
 * GROSS direkonstruksi = pnlUsd + feeUsd, lalu dikurangi fee STANDARD Binance
 * dari notional (entry market = taker; exit TP limit = maker, SL = taker) agar
 * semua strategi dibandingkan di bawah model fee yang sama (bukan fee tercatat
 * yang bisa beda tier/BNB). Tanpa qty, fee tercatat dipakai apa adanya sehingga
 * hasil = pnlUsd — notional TIDAK dikarang (fail-closed). Pada era FEE_RATE=0
 * (pnlUsd gross, feeUsd=0) hasil identik dengan perilaku lama. TIDAK ada
 * double-deduction terhadap fee yang sudah dibakar ke pnlUsd.
 */
export function tradeNetUsd(t: TradeForEvaluation): number {
  const recorded = Number.isFinite(t.feeUsd) ? t.feeUsd : 0;
  const gross = Number(t.pnlUsd) + recorded; // pnlUsd = NET fee; + feeUsd -> gross
  const fee = t.qty && t.qty > 0
    ? estimateTradeFeeUsd({
        entryAvg: t.entryAvg,
        exitAvg: t.exitAvg,
        qty: t.qty,
        exitIsMaker: String(t.closeReason ?? "").toUpperCase().startsWith("TP"),
      })
    : recorded;
  // DB convention: fundingUsd is signed cashflow, negative = paid. Canonical
  // cost is its negation. Only include it when fundingVerified=true; missing
  // funding is UNKNOWN, not a verified zero.
  const fundingCost = t.fundingVerified && Number.isFinite(t.fundingUsd) ? -Number(t.fundingUsd) : 0;
  return Number((gross - fee - fundingCost).toFixed(4));
}

/** Explicit accounting quality for UI/reporting; never silently claim net. */
export function tradeAccountingQuality(t: TradeForEvaluation): "VERIFIED" | "ESTIMATED" | "LEGACY" {
  const q = String(t.accountingQuality ?? "").toUpperCase();
  if (q === "VERIFIED" || (t.fundingVerified && Number(t.feeUsd) > 0)) return "VERIFIED";
  if (Number(t.feeUsd) > 0) return "ESTIMATED";
  return "LEGACY";
}

/**
 * Derivasi qty trade dari field tercatat (bukan estimasi baru):
 * utama = riskUsd / |entry - SL| (budget risiko = qty * jarak SL);
 * cadangan = |pnlUsd| / |exit - entry| (realized gross = delta harga * qty).
 * Keduanya tidak valid -> null (fee hanya yang tercatat).
 */
export function deriveTradeQty(
  t: Pick<TradeForEvaluation, "entryAvg" | "exitAvg" | "pnlUsd" | "side" | "riskUsd">,
  slPrice?: number | null
): number | null {
  const risk = Number(t.riskUsd);
  const slDist = slPrice && Number.isFinite(slPrice) && slPrice > 0
    ? Math.abs(t.entryAvg - slPrice)
    : 0;
  if (Number.isFinite(risk) && risk > 0 && slDist > 0) return Number((risk / slDist).toFixed(8));
  const delta = Math.abs(t.exitAvg - t.entryAvg);
  if (delta > 0 && Number.isFinite(t.pnlUsd) && t.pnlUsd !== 0) return Number((Math.abs(t.pnlUsd) / delta).toFixed(8));
  return null;
}

export function summarizeClosedTrades(rows: TradeForEvaluation[]): StrategyStat[] {
  const groups = new Map<string, TradeForEvaluation[]>();
  for (const r of rows) {
    // Era-aware: makna nomor strategi dibaca dari waktu BUKA posisi.
    const key = canonicalStrategyKey(r.strategyId ?? "", r.openedAt ?? r.createdAt ?? null);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: StrategyStat[] = [];
  for (const [strategyId, list] of groups) {
    const nets = list.map((t) => tradeNetUsd(t));
    const wins = nets.filter((v) => v > 0);
    const losses = nets.filter((v) => v <= 0);
    const grossWin = wins.reduce((a, v) => a + v, 0);
    const grossLoss = Math.abs(losses.reduce((a, v) => a + v, 0));
    out.push({
      strategyId,
      trades: list.length,
      wins: wins.length,
      winRatePct: list.length ? (wins.length / list.length) * 100 : 0,
      evUsd: list.length ? nets.reduce((a, v) => a + v, 0) / list.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
      avgWinUsd: wins.length ? grossWin / wins.length : 0,
      avgLossUsd: losses.length ? -grossLoss / losses.length : 0,
      feeCoveredTrades: list.filter((t) => Number(t.feeUsd) > 0).length,
      fundingVerifiedTrades: list.filter((t) => t.fundingVerified === true).length,
      fundingCoverage: list.length > 0 && list.every((t) => t.fundingVerified === true)
        ? "RECORDED" : list.length > 0 && list.every((t) => Number(t.fundingUsd ?? 0) === 0)
          ? "ZERO_LEGACY" : "UNKNOWN",
      accountingQuality: list.every((t) => tradeAccountingQuality(t) === "VERIFIED")
        ? "VERIFIED"
        : list.some((t) => Number(t.feeUsd) > 0) ? "ESTIMATED" : "LEGACY",
    });
  }
  return out.sort((a, b) => a.strategyId.localeCompare(b.strategyId));
}

/** Baris TOTAL gabungan semua strategi (permintaan operator 8 Okt 2026). */
export function totalStat(stats: StrategyStat[]): StrategyStat {
  const trades = stats.reduce((a, s) => a + s.trades, 0);
  const wins = stats.reduce((a, s) => a + s.wins, 0);
  const losses = trades - wins;
  const grossWin = stats.reduce((a, s) => a + s.avgWinUsd * s.wins, 0);
  const grossLoss = stats.reduce((a, s) => a + Math.abs(s.avgLossUsd) * (s.trades - s.wins), 0);
  return {
    strategyId: "TOTAL",
    trades,
    wins,
    winRatePct: trades ? (wins / trades) * 100 : 0,
    evUsd: trades ? stats.reduce((a, s) => a + s.evUsd * s.trades, 0) / trades : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
    avgWinUsd: wins ? grossWin / wins : 0,
    avgLossUsd: losses ? -grossLoss / losses : 0,
    feeCoveredTrades: stats.reduce((a, s) => a + (s.feeCoveredTrades ?? 0), 0),
    fundingVerifiedTrades: stats.reduce((a, s) => a + (s.fundingVerifiedTrades ?? 0), 0),
    fundingCoverage: stats.every((s) => s.fundingCoverage === "RECORDED") ? "RECORDED" : stats.some((s) => s.fundingCoverage === "UNKNOWN") ? "UNKNOWN" : "ZERO_LEGACY",
    accountingQuality: stats.every((s) => s.accountingQuality === "VERIFIED")
      ? "VERIFIED" : stats.some((s) => s.accountingQuality === "ESTIMATED") ? "ESTIMATED" : "LEGACY",
  };
}

const FEE_NOTE =
  "> Angka di atas deterministik (dihitung TS tanpa LLM). EV bersih-fee Binance futures USDⓈ-M";
const FEE_NOTE2 =
  "> (maker 0,02% / taker 0,05%, VIP0; entry taker, exit TP maker / SL taker). Funding signed: negatif = dibayar; hanya dihitung bila fundingVerified=true. Selain itu UNKNOWN, bukan nol.";

export function buildResearchBrief(stats: StrategyStat[], label: string): string {
  const lines = [
    `# Ringkasan riset ${label}`,
    "",
    "| Strategi | Trade | WR% | EV/trade | PF | AvgWin | AvgLoss | FeeCovered | FundingVerified | FundingCoverage | Quality |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  const rows = stats.length ? [...stats, totalStat(stats)] : [];
  for (const s of rows) {
    lines.push(
      `| ${s.strategyId} | ${s.trades} | ${s.winRatePct.toFixed(1)}% | ${s.evUsd.toFixed(4)} | ${s.profitFactor.toFixed(2)} | ${s.avgWinUsd.toFixed(2)} | ${s.avgLossUsd.toFixed(2)} | ${s.feeCoveredTrades ?? 0} | ${s.fundingVerifiedTrades ?? 0} | ${s.fundingCoverage ?? "UNKNOWN"} | ${s.accountingQuality ?? "LEGACY"} |`,
    );
  }
  lines.push(
    "",
    "## Hipotesis",
    "_Diisi tahap BUILD (strategyProposal) dari angka di atas._",
    "",
    FEE_NOTE,
    FEE_NOTE2,
  );
  return lines.join("\n");
}

export function proposeFromBrief(
  stats: StrategyStat[],
  opts: { minTrades?: number; minWinRatePct?: number } = {},
): Hypothesis[] {
  const minTrades = opts.minTrades ?? 4;
  const minWinRatePct = opts.minWinRatePct ?? 40;
  return stats
    .filter((s) => s.strategyId !== "TOTAL" && s.trades >= minTrades && s.winRatePct < minWinRatePct && s.evUsd < 0)
    .map((s) => {
      const param = KNOB_BY_STRATEGY[s.strategyId] ?? "tp1R";
      const [from, to] = param === "pullBiasThreshold" ? [1.6, 1.3] : [1.5, 1.5];
      return {
        strategyId: s.strategyId,
        param,
        from,
        to,
        rationale: `WR ${s.winRatePct.toFixed(1)}%, EV ${s.evUsd.toFixed(4)} pada ${s.trades} trade; uji ${param} ${from} -> ${to}.`,
      };
    });
}
