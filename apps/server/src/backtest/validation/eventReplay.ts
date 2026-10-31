// apps/server/src/backtest/validation/eventReplay.ts
// Big Brain — "futuretest" ala riset hedge fund (konteks artikel QuantGPT
// 12 Okt 2026), diadaptasi untuk crypto: replay STRATEGI lo ke jendela
// shock historis yang sudah diketahui, lalu lihat perilaku nyata trade di
// dalamnya (bukan agregat tahunan yang bisa menyembunyikan tail risk).
//
// KONTRAK (Golden Rule §10):
//  - Jendela event adalah FAKTA HISTORIS (tanggal UTC hard-coded), bukan
//    parameter yang bisa diutak-atik supaya hasil bagus.
//  - Event yang TIDAK tercakup jendela OOS dataset dilaporkan NOT_COVERED —
//    TIDAK difabrikasi, TIDAK diam-diam dilewati.
//  - Buy-and-hold dihitung dari bar dataset yang sama (harga close), hanya
//    sebagai pembanding konteks, bukan klaim kinerja strategi.
import type { HistoricalDataset, ReplayOptions } from "../historicalReplay.js";
import { replayHistoricalDataset } from "../historicalReplay.js";
import type { FeeStructure, StrategyMode } from "../backtestEngine.js";

export interface CryptoShockEvent {
  key: string;
  name: string;
  fromMs: number;
  toMs: number; // eksklusif
  description: string;
}

const U = (iso: string) => Date.parse(iso);

/** Jendela shock crypto yang dikenal luas (UTC). Ditambahkan sekali, tidak dioptimalkan. */
export const CRYPTO_SHOCK_EVENTS: CryptoShockEvent[] = [
  {
    key: "COVID_CRASH_2020_03",
    name: "COVID Crash",
    fromMs: U("2020-03-12T00:00:00Z"),
    toMs: U("2020-03-14T00:00:00Z"),
    description: "Black Thursday — BTC turun >40% dalam 2 hari, likuiditas kering",
  },
  {
    key: "CHINA_BAN_2021_05",
    name: "China Mining Ban Crash",
    fromMs: U("2021-05-19T00:00:00Z"),
    toMs: U("2021-05-21T00:00:00Z"),
    description: "19 Mei 2021 — flash crash >30%, liquidation cascade terbesar saat itu",
  },
  {
    key: "LUNA_COLLAPSE_2022_05",
    name: "LUNA/UST Collapse",
    fromMs: U("2022-05-09T00:00:00Z"),
    toMs: U("2022-05-12T00:00:00Z"),
    description: "Death spiral UST — pasar turun bertahap 3 hari",
  },
  {
    key: "FTX_COLLAPSE_2022_11",
    name: "FTX Collapse",
    fromMs: U("2022-11-08T00:00:00Z"),
    toMs: U("2022-11-11T00:00:00Z"),
    description: "Kebangkrutan FTX — gap turun tajam, spread melebar ekstrem",
  },
  {
    key: "YEN_CARRY_FLASH_2024_08",
    name: "Yen Carry Unwind Flash Crash",
    fromMs: U("2024-08-05T00:00:00Z"),
    toMs: U("2024-08-06T00:00:00Z"),
    description: "5 Agustus 2024 — flash crash global, BTC -15% intraday lalu rebound",
  },
];

export interface EventReplayEventResult {
  key: string;
  name: string;
  description: string;
  windowFrom: number;
  windowTo: number;
  coverage: "COVERED" | "NOT_COVERED";
  tradeCount: number;
  winrate: number | null;
  netPnlUsd: number | null;
  worstNetR: number | null;
  maxDdUsd: number | null;
  buyAndHoldPct: number | null;
  slippageNote: string;
}

export interface EventReplayReport {
  strategyId: string;
  mode: StrategyMode;
  events: EventReplayEventResult[];
  coveredCount: number;
  notCoveredKeys: string[];
  totalNetPnlUsd: number; // hanya dari trade di dalam jendela event yang tercakup
  replayErrors: string[];
  ambiguousBars: number;
}

export interface EventReplayOptions {
  slippageBps?: number;
  initialEquityUsd?: number;
  targetRiskUsd?: number;
  tp1ROverride?: number;
  events?: CryptoShockEvent[];
}

function priceAtOrBefore(d: HistoricalDataset, timeMs: number): number | null {
  for (let i = d.bars.length - 1; i >= 0; i--) {
    const b = d.bars[i]!;
    if (b.openTime + d.intervalMs <= timeMs) return b.close;
  }
  return null;
}

export function runEventReplay(
  dataset: HistoricalDataset,
  strategyId: string,
  mode: StrategyMode,
  fees: FeeStructure,
  opts: EventReplayOptions = {}
): EventReplayReport {
  const events = opts.events ?? CRYPTO_SHOCK_EVENTS;
  const replayOptions: ReplayOptions = {
    strategyId,
    mode,
    fees,
    slippageBps: opts.slippageBps ?? 5,
    initialEquityUsd: opts.initialEquityUsd ?? 200,
    targetRiskUsd: opts.targetRiskUsd ?? 1,
    tp1ROverride: opts.tp1ROverride,
  };

  // Satu replay penuh untuk seluruh jendela OOS — trade lalu dikelompokkan
  // per jendela event berdasarkan entryAt. Tidak ada replay terpisah per
  // event yang bisa mengubah perilaku gate/equity.
  const out = replayHistoricalDataset(dataset, replayOptions);

  const results: EventReplayEventResult[] = [];
  let totalNetPnlUsd = 0;
  const notCoveredKeys: string[] = [];

  for (const ev of events) {
    const covered = ev.fromMs >= dataset.outOfSampleFrom && ev.toMs <= dataset.outOfSampleTo;
    if (!covered) {
      notCoveredKeys.push(ev.key);
      results.push({
        key: ev.key, name: ev.name, description: ev.description,
        windowFrom: ev.fromMs, windowTo: ev.toMs, coverage: "NOT_COVERED",
        tradeCount: 0, winrate: null, netPnlUsd: null, worstNetR: null, maxDdUsd: null,
        buyAndHoldPct: null,
        slippageNote: "Shock ekstrem membuat slippage model 5-10 bps bisa jauh di bawah kenyataan",
      });
      continue;
    }

    const inWindow = out.trades.filter(
      (t) => t.entryAt.getTime() >= ev.fromMs && t.entryAt.getTime() < ev.toMs
    );
    const n = inWindow.length;
    const wins = inWindow.filter((t) => t.netPnlUsd > 0).length;
    let cum = 0, peak = 0, maxDd = 0;
    for (const t of inWindow) {
      cum += t.netPnlUsd;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDd) maxDd = peak - cum;
    }
    const bhStart = priceAtOrBefore(dataset, ev.fromMs);
    const bhEnd = priceAtOrBefore(dataset, ev.toMs);
    totalNetPnlUsd += inWindow.reduce((s, t) => s + t.netPnlUsd, 0);

    results.push({
      key: ev.key, name: ev.name, description: ev.description,
      windowFrom: ev.fromMs, windowTo: ev.toMs, coverage: "COVERED",
      tradeCount: n,
      winrate: n > 0 ? Number(((wins / n) * 100).toFixed(2)) : null,
      netPnlUsd: n > 0 ? Number(inWindow.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(4)) : null,
      worstNetR: n > 0 ? Number(Math.min(...inWindow.map((t) => t.netR)).toFixed(4)) : null,
      maxDdUsd: n > 0 ? Number(maxDd.toFixed(4)) : null,
      buyAndHoldPct:
        bhStart !== null && bhEnd !== null && bhStart > 0
          ? Number((((bhEnd - bhStart) / bhStart) * 100).toFixed(2))
          : null,
      slippageNote: "Shock ekstrem membuat slippage model 5-10 bps bisa jauh di bawah kenyataan",
    });
  }

  return {
    strategyId,
    mode,
    events: results,
    coveredCount: results.length - notCoveredKeys.length,
    notCoveredKeys,
    totalNetPnlUsd: Number(totalNetPnlUsd.toFixed(4)),
    replayErrors: out.errors,
    ambiguousBars: out.ambiguousBars,
  };
}
