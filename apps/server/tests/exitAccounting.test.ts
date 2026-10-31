// tests/exitAccounting.test.ts — 12 Okt 2026 (CP-1 + review gate 12 Okt).
// Akuntansi exit dari FILL ASLI exchange (bukan harga trigger). Test deterministik:
// normal fill, partial fills, event duplikat, API failure (fallback ESTIMATED),
// pagination (+ truncated), baris tidak lengkap/rusak, out-of-order, atribusi
// segmen netting (re-entry generasi berikutnya, flip manual -> AMBIGUOUS),
// fee entry+exit & denominasi, funding sign, dan semantik gross vs net.
import { describe, expect, it, vi } from "vitest";
import { aggregateExitFills, decideExitAccounting, fetchUserTradesWindow, type RawUserTradeRow, type UserTradesClient } from "../src/exec/exitAccounting.js";

function fill(overrides: Partial<RawUserTradeRow>): RawUserTradeRow {
  return { id: 1, time: 2_000_000, side: "SELL", price: "1", qty: "1", realizedPnl: "0", commission: "0", ...overrides };
}

const OPENED = 1_000_000;

describe("aggregateExitFills — weighted-average + atribusi segmen", () => {
  it("fill tunggal normal: exitAvg = harga fill, complete, realized dari exchange, atribusi FULL", () => {
    // Kasus nyata USUSDT: qty 2158 fill 0.013189 realized 1.62929 fee 0.01423093
    const agg = aggregateExitFills({
      posSide: "SHORT", posQty: 2158, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 1000, side: "SELL", price: "0.013944", qty: "2158", commission: "0.0149" }),
        fill({ id: 10, time: OPENED + 60_000, side: "BUY", price: "0.013189", qty: "2158", realizedPnl: "1.62929", commission: "0.01423093" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.attribution).toBe("FULL");
    expect(agg.exitAvg).toBeCloseTo(0.013189, 10);
    expect(agg.filledQty).toBeCloseTo(2158, 6);
    expect(agg.realizedPnlUsd).toBeCloseTo(1.62929, 10);
    expect(agg.feeUsd).toBeCloseTo(0.01423093, 10);
    expect(agg.entryFeeUsd).toBeCloseTo(0.0149, 10);
    expect(agg.exitFillCount).toBe(1);
  });

  it("partial fills: exitAvg = rata-rata tertimbang kuantitas", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, time: OPENED + 1000, side: "SELL", price: "10", qty: "40", realizedPnl: "-4", commission: "0.02" }),
        fill({ id: 3, time: OPENED + 2000, side: "SELL", price: "12", qty: "60", realizedPnl: "6", commission: "0.03" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.attribution).toBe("FULL");
    expect(agg.exitAvg).toBeCloseTo((40 * 10 + 60 * 12) / 100, 10); // 11.2
    expect(agg.realizedPnlUsd).toBeCloseTo(2, 10);
    expect(agg.feeUsd).toBeCloseTo(0.05, 10);
    expect(agg.exitFillCount).toBe(2);
  });

  it("REVIEW: kelebihan qty penutup melewati flat (flip manual) = AMBIGUOUS, tidak diprorata diam-diam", () => {
    // Posisi LONG 100; user manual menambah SHORT 150 (net: -50) lalu harga turun.
    // Fill SELL total 150 > qty berjalan 100 -> penyebab kelebihan tidak bisa
    // dibuktikan milik posisi ini -> AMBIGUOUS -> tidak pernah VERIFIED.
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, time: OPENED + 2000, side: "SELL", price: "10", qty: "150", realizedPnl: "3", commission: "0.075" }),
      ],
    });
    expect(agg.attribution).toBe("AMBIGUOUS");
    expect(agg.filledQty).toBeCloseTo(100, 10);
    expect(agg.exitFillCount).toBe(1);
    const d = decideExitAccounting({
      pos: { side: "LONG", entryPrice: 9, qty: 100 },
      exchange: { ...agg, fundingUsd: 0, fundingVerified: false },
      fallback: { price: 8, reason: "SL" },
    });
    expect(d.quality).toBe("ESTIMATED");
    expect(d.attribution).toBe("AMBIGUOUS");
    expect(d.note).toBe("AMBIGUOUS_ATTRIBUTION");
    expect(d.exitPrice).toBe(8); // fallback, bukan fill
  });

  it("REVIEW: penambahan qty manual (entry extra) diisolasi netting — exit tetap teratribusi", () => {
    // LONG 100 oleh bot + BUY manual 50 (openQty 150) -> exit SELL 150 menutup
    // semuanya; segmen flat; filled 150 >= posQty 100; exitAvg tertimbang penuh.
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, time: OPENED + 700, side: "BUY", price: "9.5", qty: "50" }),
        fill({ id: 3, time: OPENED + 2000, side: "SELL", price: "10", qty: "150", realizedPnl: "10", commission: "0.06" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.attribution).toBe("FULL");
    expect(agg.filledQty).toBeCloseTo(150, 10);
    expect(agg.exitAvg).toBeCloseTo(10, 10);
    expect(agg.realizedPnlUsd).toBeCloseTo(10, 10);
  });

  it("REVIEW: re-entry generasi berikutnya setelah flat DIBUANG (TRUNCATED_REENTRY), tetap VERIFIED", () => {
    // Bot LONG 100 -> tertutup penuh oleh SELL id=2; lalu user re-entry BUY id=3
    // dan close SELL id=4 (generasi berikutnya) -> tidak boleh ikut dihitung.
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, time: OPENED + 2000, side: "SELL", price: "10", qty: "100", realizedPnl: "100", commission: "0.01" }),
        fill({ id: 3, time: OPENED + 3000, side: "BUY", price: "10.2", qty: "50" }),
        fill({ id: 4, time: OPENED + 4000, side: "SELL", price: "9", qty: "50", realizedPnl: "-60", commission: "0.02" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.attribution).toBe("TRUNCATED_REENTRY");
    expect(agg.exitAvg).toBeCloseTo(10, 10);
    expect(agg.exitFillCount).toBe(1);
    expect(agg.realizedPnlUsd).toBeCloseTo(100, 10);
    expect(agg.feeUsd).toBeCloseTo(0.01, 10);
    const d = decideExitAccounting({
      pos: { side: "LONG", entryPrice: 9, qty: 100 },
      exchange: { ...agg, fundingUsd: 0, fundingVerified: true },
      fallback: { price: 10, reason: "TP1" },
    });
    expect(d.quality).toBe("VERIFIED");
    expect(d.attribution).toBe("TRUNCATED_REENTRY");
  });

  it("REVIEW: fill penutup SEBELUM entry (aktivitas generasi sebelumnya) diabaikan", () => {
    // SELL id=1 sebelum entry BUY id=2 -> bukan bagian posisi ini; tanpa fill
    // penutup lain, bukti tidak lengkap -> complete=false -> ESTIMATED.
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, time: OPENED + 100, side: "SELL", price: "8", qty: "200", realizedPnl: "-50" }),
        fill({ id: 2, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
      ],
    });
    expect(agg.complete).toBe(false);
    expect(agg.exitFillCount).toBe(0);
    expect(agg.exitAvg).toBeNull();
    const d = decideExitAccounting({
      pos: { side: "LONG", entryPrice: 9, qty: 100 },
      exchange: { ...agg, fundingUsd: 0, fundingVerified: false },
      fallback: { price: 8.5, reason: "SL" },
    });
    expect(d.quality).toBe("ESTIMATED");
    expect(d.note).toBe("INCOMPLETE_FILLS");
  });

  it("event duplikat (id sama) dihitung SEKALI — cegah duplikasi ledger", () => {
    const entry = fill({ id: 1, side: "BUY", price: "9", qty: "100" });
    const row = fill({ id: 7, price: "10", qty: "100", realizedPnl: "1", commission: "0.01" });
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [entry, row, { ...row }, { ...row }],
    });
    expect(agg.complete).toBe(true);
    expect(agg.exitFillCount).toBe(1);
    expect(agg.realizedPnlUsd).toBeCloseTo(1, 10);
    expect(agg.feeUsd).toBeCloseTo(0.01, 10);
  });

  it("out-of-order events: tetap benar (diurutkan waktu lalu id)", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 9, time: OPENED + 9000, side: "SELL", price: "12", qty: "50", realizedPnl: "5", commission: "0.03" }),
        fill({ id: 8, time: OPENED + 1000, side: "SELL", price: "10", qty: "50", realizedPnl: "-5", commission: "0.02" }),
        fill({ id: 1, time: OPENED + 500, side: "BUY", price: "9", qty: "100" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.exitAvg).toBeCloseTo(11, 10);
    expect(agg.realizedPnlUsd).toBeCloseTo(0, 10);
    expect(agg.exitFillCount).toBe(2);
  });

  it("baris rusak / tidak lengkap DITOLAK (non-finite, tanpa id, qty<=0)", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 0.5, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 1, price: "NaN", qty: "100" }),
        fill({ id: 2, price: undefined, qty: "100" }),
        fill({ id: undefined, price: "10", qty: "100" }),
        fill({ id: 4, price: "10", qty: "0" }),
        fill({ id: 5, price: "-3", qty: "100" }),
      ],
    });
    expect(agg.complete).toBe(false);
    expect(agg.exitAvg).toBeNull();
    expect(agg.exitFillCount).toBe(0);
  });

  it("fill sebelum jendela posisi (stale/lain sesi) ditolak", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED, clockSkewMs: 5000,
      rows: [
        fill({ id: 1, time: OPENED - 60_000, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, time: OPENED - 59_000, side: "SELL", price: "10", qty: "100" }),
      ],
    });
    expect(agg.complete).toBe(false);
    expect(agg.exitAvg).toBeNull();
  });

  it("qty fill kurang dari posisi -> complete=false (data belum lengkap)", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, price: "10", qty: "60", realizedPnl: "-1", commission: "0.01" }),
      ],
    });
    expect(agg.complete).toBe(false);
    expect(agg.filledQty).toBeCloseTo(60, 10);
  });

  it("tanpa fill entry di jendela -> tidak dapat diatribusi -> kosong", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [fill({ id: 1, side: "SELL", price: "10", qty: "100" })],
    });
    expect(agg.complete).toBe(false);
    expect(agg.exitAvg).toBeNull();
  });

  it("realizedPnl tidak valid -> null (caller menghitung dari harga fill)", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, side: "BUY", price: "9", qty: "100" }),
        fill({ id: 2, price: "10", qty: "100", realizedPnl: "bukan-angka", commission: "0.01" }),
      ],
    });
    expect(agg.complete).toBe(true);
    expect(agg.realizedPnlUsd).toBeNull();
  });

  it("REVIEW: komisi non-USDT -> feeAssetClean=false (fee tidak terverifikasi penuh)", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, side: "BUY", price: "9", qty: "100", commissionAsset: "USDT" }),
        fill({ id: 2, price: "10", qty: "100", realizedPnl: "1", commission: "0.0001", commissionAsset: "BNB" }),
      ],
    });
    expect(agg.feeAssetClean).toBe(false);
    const d = decideExitAccounting({
      pos: { side: "LONG", entryPrice: 9, qty: 100 },
      exchange: { ...agg, fundingUsd: 0, fundingVerified: true },
      fallback: { price: 10, reason: "TP1" },
    });
    expect(d.quality).toBe("VERIFIED"); // fill tetap terverifikasi...
    expect(d.feeVerified).toBe(false);  // ...tetapi fee ditandai belum terverifikasi
  });

  it("orderId fill penutup terekam sebagai jejak atribusi", () => {
    const agg = aggregateExitFills({
      posSide: "LONG", posQty: 100, openedAtMs: OPENED,
      rows: [
        fill({ id: 1, side: "BUY", price: "9", qty: "100", orderId: 111 }),
        fill({ id: 2, price: "10", qty: "100", orderId: 222 }),
      ],
    });
    expect(agg.exitOrderIds).toEqual([222]);
  });
});

describe("decideExitAccounting — semantik gross/net & status terpisah", () => {
  const pos = { side: "LONG" as const, entryPrice: 10, qty: 100 };
  const fallback = { price: 9, reason: "SL" as const };
  const agg = (over: Partial<ReturnType<typeof aggregateExitFills>> = {}) => ({
    complete: true, exitAvg: 8.7, filledQty: 100, realizedPnlUsd: -130,
    feeUsd: 0.05, entryFeeUsd: 0.02, exitFillCount: 2,
    attribution: "FULL" as const, feeAssetClean: true, exitOrderIds: [1], ...over,
  });

  it("fill lengkap + FULL -> VERIFIED; realized=GROSS, fee=entry+exit, funding bertanda; NET = realized-fee+funding", () => {
    const d = decideExitAccounting({
      pos, fallback,
      exchange: { ...agg(), fundingUsd: -0.002, fundingVerified: true },
    });
    expect(d.quality).toBe("VERIFIED");
    expect(d.basis).toBe("EXCHANGE_FILLS");
    expect(d.exitPrice).toBeCloseTo(8.7, 10); // fill asli, bukan fallback 9
    expect(d.realizedPnlUsd).toBeCloseTo(-130, 4); // GROSS (belum kurangi fee/funding)
    expect(d.closeReason).toBe("SL");
    expect(d.feeUsd).toBeCloseTo(0.07, 10); // exit + entry
    expect(d.fundingUsd).toBeCloseTo(-0.002, 10); // tanda dipertahankan (negatif = bayar)
    expect(d.fundingVerified).toBe(true);
    expect(d.feeVerified).toBe(true);
    // Rekonsiliasi NET (kasus USUSDT: 1.62929 - 0.029277 + (-0.002226) ≈ 1.5978)
    const net = d.realizedPnlUsd - d.feeUsd + d.fundingUsd;
    expect(net).toBeCloseTo(-130.072, 3);
  });

  it("profit exchange -> closeReason TP1", () => {
    const d = decideExitAccounting({
      pos, fallback: { price: 11.7, reason: "TP1" },
      exchange: { ...agg({ exitAvg: 11.7, realizedPnlUsd: 170, feeUsd: 0.03, entryFeeUsd: 0, exitFillCount: 1 }), fundingUsd: 0, fundingVerified: true },
    });
    expect(d.closeReason).toBe("TP1");
    expect(d.quality).toBe("VERIFIED");
  });

  it("exchange=null (API failure) -> ESTIMATED, alasan EXCHANGE_EVIDENCE_UNAVAILABLE, fee/funding nol", () => {
    const d = decideExitAccounting({ pos, fallback, exchange: null });
    expect(d.quality).toBe("ESTIMATED");
    expect(d.basis).toBe("TRIGGER_FALLBACK");
    expect(d.note).toBe("EXCHANGE_EVIDENCE_UNAVAILABLE");
    expect(d.exitPrice).toBe(9);
    expect(d.realizedPnlUsd).toBeCloseTo((9 - 10) * 100, 4);
    expect(d.feeUsd).toBe(0);
    expect(d.fundingUsd).toBe(0);
    expect(d.fundingVerified).toBe(false);
    expect(d.feeVerified).toBe(false);
  });

  it("fill TIDAK lengkap -> ESTIMATED walau ada data exchange parsial (note INCOMPLETE_FILLS)", () => {
    const d = decideExitAccounting({
      pos, fallback,
      exchange: { ...agg({ complete: false, filledQty: 60, realizedPnlUsd: -78 }), fundingUsd: 0, fundingVerified: false },
    });
    expect(d.quality).toBe("ESTIMATED");
    expect(d.note).toBe("INCOMPLETE_FILLS");
    expect(d.exitPrice).toBe(9);
  });

  it("REVIEW: atribusi AMBIGUOUS -> tidak pernah VERIFIED meski fill lengkap", () => {
    const d = decideExitAccounting({
      pos, fallback,
      exchange: { ...agg({ attribution: "AMBIGUOUS" }), fundingUsd: 0, fundingVerified: true },
    });
    expect(d.quality).toBe("ESTIMATED");
    expect(d.note).toBe("AMBIGUOUS_ATTRIBUTION");
    expect(d.attribution).toBe("AMBIGUOUS");
  });

  it("realizedPnl null -> dihitung dari harga fill, tetap VERIFIED", () => {
    const d = decideExitAccounting({
      pos, fallback,
      exchange: { ...agg({ realizedPnlUsd: null }), fundingUsd: 0, fundingVerified: false },
    });
    expect(d.quality).toBe("VERIFIED");
    expect(d.realizedPnlUsd).toBeCloseTo(-130, 4); // (8.7-10)*100 dari harga fill
    expect(d.closeReason).toBe("SL");
  });
});

describe("fetchUserTradesWindow — pagination, truncated, dan kontrak API", () => {
  function mockClient(pages: RawUserTradeRow[][]): UserTradesClient & { calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    return {
      calls,
      getUserTrades: vi.fn(async (input) => {
        calls.push({ ...input });
        return pages[Math.min(i++, pages.length - 1)] ?? [];
      }),
    };
  }

  it("satu halaman (<1000): tidak ada panggilan lanjutan, truncated=false", async () => {
    const client = mockClient([[fill({ id: 1 })]]);
    const w = await fetchUserTradesWindow(client, "BTCUSDT", 1000, 2000);
    expect(w.rows).toHaveLength(1);
    expect(w.truncated).toBe(false);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ symbol: "BTCUSDT", startTime: 1000, endTime: 2000, limit: 1000 });
  });

  it("halaman penuh 1000 -> lanjut via fromId (tanpa startTime/endTime), truncated=false bila halaman akhir < 1000", async () => {
    const page1 = Array.from({ length: 1000 }, (_, k) => fill({ id: k + 1 }));
    const page2 = [fill({ id: 1001 })];
    const client = mockClient([page1, page2]);
    const w = await fetchUserTradesWindow(client, "BTCUSDT", 1000, 2000);
    expect(w.rows).toHaveLength(1001);
    expect(w.truncated).toBe(false);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]).toMatchObject({ symbol: "BTCUSDT", fromId: 1001, limit: 1000 });
    expect(client.calls[1]).not.toHaveProperty("startTime");
    expect(client.calls[1]).not.toHaveProperty("endTime");
  });

  it("REVIEW: cap maxPages tercapai dengan halaman terakhir masih penuh -> truncated=true", async () => {
    const full = Array.from({ length: 1000 }, (_, k) => fill({ id: k + 1 }));
    const client = { calls: [] as unknown[], getUserTrades: vi.fn(async () => full) } as unknown as UserTradesClient;
    const w = await fetchUserTradesWindow(client, "BTCUSDT", 1000, 2000, 3);
    expect(w.rows).toHaveLength(3000);
    expect(w.truncated).toBe(true); // data mungkin terpotong -> tidak boleh VERIFIED
    expect((client.getUserTrades as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("respons bukan array diperlakukan sebagai kosong (defensif)", async () => {
    const client = { getUserTrades: vi.fn(async () => ({ code: -1121 }) as unknown as RawUserTradeRow[]) };
    const w = await fetchUserTradesWindow(client, "BTCUSDT", 1000, 2000);
    expect(w.rows).toEqual([]);
    expect(w.truncated).toBe(false);
  });
});

describe("kontrak client: fromId tidak boleh digabung startTime/endTime", () => {
  it("getUserTrades menolak kombinasi terlarang sebelum menyentuh jaringan", async () => {
    const { BinanceUsdMClient } = await import("../src/exec/binanceUsdMClient.js");
    const client = new BinanceUsdMClient({ apiKey: "***", apiSecret: "TEST_SECRET", fetcher: vi.fn() as unknown as typeof fetch });
    await expect(client.getUserTrades({ symbol: "BTCUSDT", fromId: 5, startTime: 1000 }))
      .rejects.toThrow(/fromId cannot be combined/);
  });
});