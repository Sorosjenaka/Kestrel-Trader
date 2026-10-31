import { describe, expect, it } from "vitest";
import {
  buildResearchBrief,
  proposeFromBrief,
  summarizeClosedTrades,
  totalStat,
  tradeNetUsd,
  deriveTradeQty,
} from "../src/learning/researchBrief";
import type { TradeForEvaluation } from "../src/learning/postMortemEvaluator";

function trade(
  id: number,
  strategyId: string,
  pnlUsd: number,
  openedAt = "2026-10-01T00:00:00.000Z"
): TradeForEvaluation {
  return {
    id,
    strategyId,
    mode: "SCALP",
    symbol: "BTCUSDT",
    side: "LONG",
    pnlUsd,
    feeUsd: 0,
    entryAvg: 100,
    exitAvg: pnlUsd > 0 ? 101.6 : 99,
    riskUsd: 1,
    openedAt,
    closedAt: "2026-10-01T00:10:00.000Z",
  } as unknown as TradeForEvaluation;
}

describe("researchBrief", () => {
  // Tanggal 2026-10-01 = SEBELUM renumber 6 Okt 2026 -> S-03 lama = Sweep (S-01),
  // S-04 lama = Sniper (S-02). Grouping era-aware.
  const rows = [
    trade(1, "S-03", 1.6), trade(2, "S-03", -1), trade(3, "S-03", 1.6),
    trade(4, "S-04", -1), trade(5, "S-04", -1), trade(6, "S-04", 1.6), trade(7, "S-04", -1),
  ];

  it("statistik per strategi deterministik dan era-aware", () => {
    const stats = summarizeClosedTrades(rows);
    const sniper = stats.find((s) => s.strategyId === "S-02"); // eks S-04 pra-renumber
    expect(sniper?.trades).toBe(4);
    expect(sniper?.wins).toBe(1);
    expect(sniper?.winRatePct).toBeCloseTo(25, 6);
    expect(sniper?.evUsd).toBeCloseTo(-0.35, 6);
    const sweep = stats.find((s) => s.strategyId === "S-01"); // eks S-03 pra-renumber
    expect(sweep?.trades).toBe(3);
  });

  it("nomor sama dibaca berbeda sesudah cutover renumber", () => {
    const post = summarizeClosedTrades([trade(1, "S-03", -1, "2026-10-07T00:00:00.000Z")]);
    // 20 Okt 2026: S-03 Fibonacci DIHAPUS dari katalog -> trade era-Fibonacci
    // masuk bucket arsip "S-99", tidak lagi diklaim sebagai strategi hidup.
    expect(post[0]?.strategyId).toBe("S-99");
    const pre = summarizeClosedTrades([trade(1, "S-03", -1, "2026-10-05T00:00:00.000Z")]);
    expect(pre[0]?.strategyId).toBe("S-01"); // era lama = Sweep Reclaim
  });

  it("fee Binance futures dihitung dari notional saat qty tersedia", () => {
    // TP limit -> exit maker 0.02%; entry taker 0.05%.
    const winTp = trade(1, "S-03", 16);
    winTp.entryAvg = 100; winTp.exitAvg = 101.6; winTp.qty = 10; winTp.closeReason = "TP1";
    // fee = 10*(100*0.0005 + 101.6*0.0002) = 0.7032
    expect(tradeNetUsd(winTp)).toBeCloseTo(16 - 0.7032, 4);
    // SL -> exit taker 0.05%
    const lossSl = trade(2, "S-03", -16);
    lossSl.entryAvg = 100; lossSl.exitAvg = 98.4; lossSl.qty = 10; lossSl.closeReason = "SL";
    // fee = 10*(100*0.0005 + 98.4*0.0005) = 0.992
    expect(tradeNetUsd(lossSl)).toBeCloseTo(-16 - 0.992, 4);
  });

  it("funding hanya dikurangkan jika fundingVerified=true; kualitas legacy jujur", () => {
    const t = trade(1, "S-03", 1.6);
    t.entryAvg = 100; t.exitAvg = 101.6; t.qty = 10; t.closeReason = "TP1";
    t.feeUsd = 0.7032; t.fundingUsd = -0.2; t.fundingVerified = false;
    expect(tradeNetUsd(t)).toBeCloseTo(1.6, 4); // fee standard menutup fee tercatat; funding unverified tidak dikurangi
    t.fundingVerified = true;
    expect(tradeNetUsd(t)).toBeCloseTo(1.4, 4); // standard fee tidak double-deduct; funding verified dikurangi
    const st = summarizeClosedTrades([t])[0]!;
    expect(st.fundingVerifiedTrades).toBe(1);
  });

  it("tanpa qty: fee tidak dikarang (fail-closed), pakai fee tercatat", () => {
    const t = trade(1, "S-03", 1.6);
    expect(tradeNetUsd(t)).toBeCloseTo(1.6, 4);
  });

  it("deriveTradeQty dari risk/SL, fallback delta harga", () => {
    const t = trade(1, "S-03", -1);
    expect(deriveTradeQty(t, 101)).toBeCloseTo(1, 6); // risk 1 / |100-101|
    expect(deriveTradeQty(t, null)).toBeCloseTo(1, 6); // |pnl|/|exit-entry| = 1/1
  });

  it("baris TOTAL digabung dari semua strategi", () => {
    const total = totalStat(summarizeClosedTrades(rows));
    expect(total.trades).toBe(7);
    expect(total.wins).toBe(3);
    expect(total.evUsd).toBeCloseTo((3 * 1.6 - 4) / 7, 4);
  });

  it("brief markdown memuat angka nyata, TOTAL, dan catatan fee Binance", () => {
    const md = buildResearchBrief(summarizeClosedTrades(rows), "2026-10-03");
    expect(md).toContain("Ringkasan riset");
    expect(md).toContain("S-02");
    expect(md).toContain("25.0%");
    expect(md).toContain("| TOTAL | 7 |");
    expect(md).toContain("Binance futures");
  });

  it("usulan hanya untuk strategi rugi dengan sampel cukup", () => {
    const props = proposeFromBrief(summarizeClosedTrades(rows), { minTrades: 4, minWinRatePct: 40 });
    expect(props).toHaveLength(1);
    expect(props[0]?.strategyId).toBe("S-02");
  });

  it("S-02 (Sniper) memakai knob pullBiasThreshold (tp1R dikunci operator)", () => {
    const props = proposeFromBrief(summarizeClosedTrades(rows));
    expect(props[0]?.param).toBe("pullBiasThreshold");
  });

  it("baris TOTAL tidak pernah diusulkan sebagai hipotesis", () => {
    const stats = summarizeClosedTrades(rows);
    const props = proposeFromBrief([...stats, totalStat(stats)]);
    expect(props.every((p) => p.strategyId !== "TOTAL")).toBe(true);
  });

  it("sampel kurang -> tidak mengusulkan apa pun", () => {
    expect(proposeFromBrief(summarizeClosedTrades([trade(1, "S-03", -1)]), { minTrades: 4 })).toHaveLength(0);
  });
});
