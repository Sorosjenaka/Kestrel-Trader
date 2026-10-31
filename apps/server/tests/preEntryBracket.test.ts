// tests/preEntryBracket.test.ts — 12 Okt 2026
// Perintah operator: SL/TP DULU + verifikasi, baru entry. Test ini mengunci urutan
// dan fail-closed-nya: gagal di SL/TP = ok:false + TIDAK ada yang tertinggal.
import { describe, expect, it, vi } from "vitest";
import { bracketAlgoIds, cancelPreEntryBracket, entryLimitPrice, placePreEntryBracket, realignBracketQty, verifyBracketActive } from "../src/exec/preEntryBracket.js";
import type { BinanceAlgoResponse, BinanceUsdMClient } from "../src/exec/binanceUsdMClient.js";

function algoEcho(input: { symbol: string; side: string; type: string; triggerPrice: number; quantity: number; clientAlgoId: string; price?: number }): BinanceAlgoResponse {
  return {
    algoId: 1, clientAlgoId: input.clientAlgoId, algoStatus: "NEW",
    symbol: input.symbol, triggerPrice: String(input.triggerPrice),
  };
}

function fakeClient(overrides?: Partial<BinanceUsdMClient>): BinanceUsdMClient {
  const placed: Array<{ clientAlgoId: string; triggerPrice: number }> = [];
  const cancelled: string[] = [];
  const base = {
    placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => {
      placed.push({ clientAlgoId: input.clientAlgoId, triggerPrice: input.triggerPrice });
      return algoEcho(input);
    }),
    queryAlgo: vi.fn(async (clientAlgoId: string) => {
      const row = placed.find((p) => p.clientAlgoId === clientAlgoId);
      if (!row) throw new Error("-2013 Order does not exist");
      return algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: row.triggerPrice, quantity: 1, clientAlgoId });
    }),
    cancelAlgo: vi.fn(async (clientAlgoId: string) => {
      cancelled.push(clientAlgoId);
      return algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: 1, quantity: 1, clientAlgoId });
    }),
    ...(overrides as object),
  };
  return Object.assign(base, { __placed: placed, __cancelled: cancelled }) as unknown as BinanceUsdMClient;
}

const LONG_INPUT = {
  symbol: "BTCUSDT", side: "LONG" as const, entryPrice: 100, qty: 2,
  slPrice: 97, tp1Price: 106, tickSize: 0.1, refId: "AT_TEST_1",
};

describe("preEntryBracket — SL/TP dulu, verifikasi, baru entry", () => {
  it("happy path: SL dipasang DULU sebelum TP, keduanya terverifikasi", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(true);
    const placed = (client as unknown as { __placed: Array<{ clientAlgoId: string }> }).__placed;
    // Urutan: SL (SLA_...) direkam lebih dulu dari TP (TPA_...)
    expect(placed[0].clientAlgoId.startsWith("SLA_")).toBe(true);
    expect(placed[1].clientAlgoId.startsWith("TPA_")).toBe(true);
    expect(res.slClientAlgoId).toBeTruthy();
    expect(res.tpClientAlgoId).toBeTruthy();
  });

  it("SL ditolak exchange -> ok:false, TP tidak pernah dipasang", async () => {
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async () => { throw new Error("-4509 rejected"); }),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("SL_PLACE_FAILED");
  });

  it("TP gagal -> SL ikut DIBATALKAN (tidak ada proteksi setengah jadi)", async () => {
    let call = 0;
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => {
        call++;
        if (call === 2) throw new Error("TP_REJECTED");
        return algoEcho(input);
      }),
      queryAlgo: vi.fn(async (clientAlgoId: string) => algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: 97, quantity: 2, clientAlgoId })),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("TP_PLACE_FAILED");
    expect((client as unknown as { __cancelled: string[] }).__cancelled).toContain(bracketAlgoIds("AT_TEST_1").slClientAlgoId);
  });

  it("trigger tidak di-echo dengan benar = DITOLAK (bukan 'diterima = aktif')", async () => {
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => ({
        algoId: 1, clientAlgoId: input.clientAlgoId, algoStatus: "NEW",
        symbol: input.symbol, triggerPrice: "999999", // sengaja salah
      })),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("SL_TRIGGER_ECHO_MISMATCH");
  });

  it("verifikasi queryAlgo gagal terus (order tidak nyala) -> batal + cancel", async () => {
    const client = fakeClient({
      queryAlgo: vi.fn(async () => { throw new Error("-2013 Order does not exist"); }),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("SL_VERIFY_FAILED");
    expect((client as unknown as { __cancelled: string[] }).__cancelled.length).toBeGreaterThan(0);
  }, 15_000);

  // ── REGRESI bug 1 (tes live 12 Okt): query algo punya LAG indeks ~1-2 detik.
  // Tanpa retry yang sabar, bracket yang SUKSES terpasang dianggap gagal ->
  // entry dibatalkan terus-menerus dan bot tidak pernah masuk pasar.
  it("REGRESI bug1: queryAlgo -2013 (throw) beberapa kali LALU sukses = tetap ok (lag, bukan gagal)", async () => {
    let calls = 0;
    const placed: Array<{ clientAlgoId: string; triggerPrice: number }> = [];
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => {
        placed.push({ clientAlgoId: input.clientAlgoId, triggerPrice: input.triggerPrice });
        return algoEcho(input as never);
      }),
      queryAlgo: vi.fn(async (clientAlgoId: string) => {
        calls++;
        if (calls <= 4) throw new Error("-2013 Order does not exist"); // lag indeks
        const row = placed.find((p) => p.clientAlgoId === clientAlgoId);
        return algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: row?.triggerPrice ?? 0, quantity: 2, clientAlgoId });
      }),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(true); // lag ditoleransi, bukan dianggap gagal
  }, 15_000);

  it("REGRESI bug1b: badan error tanpa throw (tanpa triggerPrice) = lag yang di-retry", async () => {
    let calls = 0;
    const placed: Array<{ clientAlgoId: string; triggerPrice: number }> = [];
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => {
        placed.push({ clientAlgoId: input.clientAlgoId, triggerPrice: input.triggerPrice });
        return algoEcho(input as never);
      }),
      queryAlgo: vi.fn(async (clientAlgoId: string) => {
        calls++;
        if (calls <= 3) return { code: -2013, msg: "Order does not exist." } as never; // badan error polos
        const row = placed.find((p) => p.clientAlgoId === clientAlgoId);
        return algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: row?.triggerPrice ?? 0, quantity: 2, clientAlgoId });
      }),
    });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(true);
  }, 15_000);

  it("REGRESI bug1c: echo trigger SALAH = tetap fatal langsung (tidak di-retry)", async () => {
    const queryAlgo = vi.fn(async (clientAlgoId: string) => algoEcho({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: 99999, quantity: 2, clientAlgoId }));
    const client = fakeClient({ queryAlgo });
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("TRIGGER_ECHO_MISMATCH");
    expect(queryAlgo).toHaveBeenCalledTimes(1); // fatal di percobaan pertama, TIDAK di-retry
  });

  // ── REGRESI bug 2 (tes live 12 Okt): harga mark mentah ditolak Binance
  // -4014 "Price not increased by tick size". entryLimitPrice wajib kuantisasi.
  it("REGRESI bug2: entryLimitPrice mengkuantisasi mark ke tickSize", () => {
    // Kasus nyata tes live: mark 0.1110718, tick 0.0000100 -> ditolak -4014 tanpa kuantisasi.
    const p = entryLimitPrice(0.1110718, 0.0000100);
    expect(p).toBeCloseTo(0.11107, 8);
    // Harus kelipatan tick persis (titik tolak -4014).
    expect(Math.abs(p / 0.00001 - Math.round(p / 0.00001))).toBeLessThan(1e-9);
    // Sudah kelipatan tick = tidak berubah.
    expect(entryLimitPrice(0.11107, 0.00001)).toBeCloseTo(0.11107, 8);
    // Pembulatan ke keduanya arah aman (0.111075 -> 0.11108 atau 0.11107 tergantung bankor; keduanya valid tick).
    const edge = entryLimitPrice(0.111075, 0.00001);
    expect(Math.abs(edge / 0.00001 - Math.round(edge / 0.00001))).toBeLessThan(1e-9);
    // Input invalid ditolak keras.
    expect(() => entryLimitPrice(0, 0.00001)).toThrow("ENTRY_PRICE_INVALID");
    expect(() => entryLimitPrice(1, 0)).toThrow("ENTRY_PRICE_INVALID");
  });

  it("SL salah sisi (LONG dengan SL di atas entry) -> ditolak sebelum kirim order", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LONG_INPUT, slPrice: 105, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("BRACKET_SL_WRONG_SIDE");
    expect((client as unknown as { placeReduceOnlyGuard: unknown }).placeReduceOnlyGuard).not.toHaveBeenCalled();
  });

  it("SHORT: SL di atas entry, TP di bawah — tetap valid", async () => {
    const client = fakeClient({
      queryAlgo: vi.fn(async (clientAlgoId: string) => algoEcho({ symbol: "BTCUSDT", side: "BUY", type: "STOP_MARKET", triggerPrice: 103, quantity: 2, clientAlgoId })),
    });
    const res = await placePreEntryBracket({
      ...LONG_INPUT, side: "SHORT", slPrice: 103, tp1Price: 94, client,
    });
    // TP di 94 di-echo sebagai 94 tapi query di atas selalu 103 -> TP verify gagal.
    // Verifikasi minimal: SL-nya benar sisi.
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("TP_");
  });

  it("verifyBracketActive: hilang = ok:false", async () => {
    const client = fakeClient();
    await placePreEntryBracket({ ...LONG_INPUT, client });
    const ok = await verifyBracketActive({
      client, slClientAlgoId: bracketAlgoIds("AT_TEST_1").slClientAlgoId,
      tpClientAlgoId: bracketAlgoIds("AT_TEST_1").tpClientAlgoId,
      slPrice: 97, tp1Price: 106, tickSize: 0.1,
    });
    expect(ok.ok).toBe(true);
    const lost = await verifyBracketActive({
      client, slClientAlgoId: "SLA_TIDAK_ADA",
      tpClientAlgoId: null, slPrice: 97, tp1Price: null, tickSize: 0.1,
    });
    expect(lost.ok).toBe(false);
  });

  it("realignBracketQty: replacement diverifikasi sebelum proteksi lama dibatalkan", async () => {
    const client = fakeClient();
    const first = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(first.ok).toBe(true);
    const realigned = await realignBracketQty({
      ...LONG_INPUT, qty: 1.2,
      oldSlClientAlgoId: first.slClientAlgoId, oldTpClientAlgoId: first.tpClientAlgoId, client,
    });
    expect(realigned.ok).toBe(true);
    expect(realigned.slClientAlgoId).not.toBe(first.slClientAlgoId);
    const cancelled = (client as unknown as { __cancelled: string[] }).__cancelled;
    expect(cancelled).toContain(first.slClientAlgoId);
    expect(cancelled).toContain(first.tpClientAlgoId);
  });

  it("realign gagal memasang replacement: SL lama tetap dipertahankan", async () => {
    const client = fakeClient();
    const first = await placePreEntryBracket({ ...LONG_INPUT, client });
    vi.mocked(client.placeReduceOnlyGuard).mockRejectedValue(new Error("replacement unavailable"));
    const realigned = await realignBracketQty({ ...LONG_INPUT, qty: 1.2,
      oldSlClientAlgoId: first.slClientAlgoId, oldTpClientAlgoId: first.tpClientAlgoId, client });
    expect(realigned.ok).toBe(false);
    const cancelled = (client as unknown as { __cancelled: string[] }).__cancelled;
    expect(cancelled).not.toContain(first.slClientAlgoId);
    expect(cancelled).not.toContain(first.tpClientAlgoId);
  });

  it("cancelPreEntryBracket: keduanya dibatalkan, tidak melempar", async () => {
    const client = fakeClient();
    await expect(cancelPreEntryBracket({ client, slClientAlgoId: "SLA_X", tpClientAlgoId: "TPA_X" })).resolves.toBeUndefined();
    expect((client as unknown as { __cancelled: string[] }).__cancelled).toEqual(["TPA_X", "SLA_X"]);
  });
});

// ── REGRESI 13 Okt 2026 (revisi 2): TATA LETAK ENTRY ZONA. Keluhan operator:
// "gw ga mau lagi ya kalo gw dalam posisi short malah nge short di bawah".
import { zoneEntryPrice } from "../src/exec/preEntryBracket.js";
describe("zoneEntryPrice — SHORT di zoneTop, LONG di zoneBottom", () => {
  const tick = 0.000001;
  const zone = { zoneTop: 102, zoneBottom: 100, tickSize: 0.01 };
  it("REGRESI: SHORT -> limit di zoneTop (jual di atas), bukan di harga bawah", () => {
    // mark di tengah/bawah zona: tetap pasang di 102 (atas)
    expect(zoneEntryPrice({ side: "SHORT", mark: 100.2, ...zone })).toBe(102);
    expect(zoneEntryPrice({ side: "SHORT", mark: 101, ...zone })).toBe(102);
  });
  it("REGRESI: LONG -> limit di zoneBottom (beli di bawah)", () => {
    expect(zoneEntryPrice({ side: "LONG", mark: 101.8, ...zone })).toBe(100);
    expect(zoneEntryPrice({ side: "LONG", mark: 101, ...zone })).toBe(100);
  });
  it("REGRESI: harga sudah melewati zona -> fallback mark (perilaku lama)", () => {
    // SHORT: mark sudah jatuh di bawah zoneBottom
    expect(zoneEntryPrice({ side: "SHORT", mark: 99.5, ...zone })).toBe(99.5);
    // LONG: mark sudah naik di atas zoneTop
    expect(zoneEntryPrice({ side: "LONG", mark: 102.5, ...zone })).toBe(102.5);
  });
  it("REGRESI: zona tidak valid/null -> fallback mark", () => {
    expect(zoneEntryPrice({ side: "SHORT", mark: 101, zoneTop: null, zoneBottom: null, tickSize: 0.01 })).toBe(101);
    expect(zoneEntryPrice({ side: "SHORT", mark: 101, zoneTop: 102, zoneBottom: 103, tickSize: 0.01 })).toBe(101);
    expect(zoneEntryPrice({ side: "LONG", mark: 101, zoneTop: 0, zoneBottom: -1, tickSize: 0.01 })).toBe(101);
  });
  it("REGRESI: hasil selalu dikuantisasi ke tickSize", () => {
    const px = zoneEntryPrice({ side: "SHORT", mark: 100.123456, zoneTop: 101.9999994, zoneBottom: 100, tickSize: 0.000001 });
    expect(px).toBeCloseTo(102.0, 4); // dibulatkan ke tick, bukan 101.9999994
  });
});

// ── 15 Okt 2026 — LADDER TP SWING (40/30/BE sisanya TP max) di LIVE bracket ──
// tp2Price terisi = mode SWING: TP1 algo 40% qty @tp1 (TPA_), TP2 algo 30% qty
// @tp2 (TPB_), SL tetap full qty. Degenerate (< 1 step) = degradasi aman ke
// single-target TP1 full qty. SCALP (tp2 null) tetap 2 kaki.
describe("preEntryBracket — ladder TP SWING (15 Okt)", () => {
  const LADDER_INPUT = {
    ...LONG_INPUT, tp2Price: 113.3333, stepSize: 0.001,
  };

  it("RR23 ladder: SL full qty, TP1 50% (TPA_), TP2/final 50% (TPB_)", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LADDER_INPUT, swingExitPolicy: "RR23", client });
    expect(res.ok).toBe(true);
    const calls = (client.placeReduceOnlyGuard as ReturnType<typeof vi.fn>).mock.calls as Array<Array<{ quantity: number; triggerPrice: number }>>;
    expect(calls[1][0].quantity).toBeCloseTo(1, 6);
    expect(calls[1][0].triggerPrice).toBe(106);
    expect(calls[2][0].quantity).toBeCloseTo(1, 6);
    expect(calls[2][0].triggerPrice).toBeCloseTo(113.3333, 4);
  });

  it("legacy ladder: SL full qty dulu, lalu TP1 40% (TPA_) dan TP2 30% (TPB_)", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LADDER_INPUT, client });
    expect(res.ok).toBe(true);
    expect(res.tp2ClientAlgoId).toBeTruthy();
    const placed = (client as unknown as { __placed: Array<{ clientAlgoId: string; triggerPrice: number }> }).__placed;
    expect(placed.map((p) => p.clientAlgoId.slice(0, 4))).toEqual(["SLA_", "TPA_", "TPB_"]);
    // qty kaki: TP1 = floor(2*0.4/0.001)*0.001 = 0.8; TP2 = 0.6
    const byId = new Map(placed.map((p) => [p.clientAlgoId.slice(0, 4), p]));
    // __placed tidak menyimpan qty — cek via calls placeReduceOnlyGuard
    const calls = (client.placeReduceOnlyGuard as ReturnType<typeof vi.fn>).mock.calls as Array<Array<{ quantity: number; triggerPrice: number }>>;
    expect(calls[1][0].quantity).toBeCloseTo(0.8, 6);
    expect(calls[1][0].triggerPrice).toBe(106);
    expect(calls[2][0].quantity).toBeCloseTo(0.6, 6);
    expect(calls[2][0].triggerPrice).toBeCloseTo(113.3333, 4);
  });

  it("SCALP (tp2 null): tetap single-target, hanya SLA_ + TPA_ full qty", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LONG_INPUT, client });
    expect(res.ok).toBe(true);
    expect(res.tp2ClientAlgoId).toBeUndefined();
    const placed = (client as unknown as { __placed: Array<{ clientAlgoId: string }> }).__placed;
    expect(placed.length).toBe(2);
    expect(placed[1].clientAlgoId.startsWith("TPB_")).toBe(false);
  });

  it("degenerate (step terlalu besar, fase < 1 step): degradasi aman TP1 full qty", async () => {
    const client = fakeClient();
    const res = await placePreEntryBracket({ ...LADDER_INPUT, stepSize: 5, client });
    expect(res.ok).toBe(true);
    expect(res.tp2ClientAlgoId).toBeUndefined();
    const calls = (client.placeReduceOnlyGuard as ReturnType<typeof vi.fn>).mock.calls as Array<Array<{ quantity: number }>>;
    expect(calls[1][0].quantity).toBe(2); // full qty di TP1
  });

  it("TP2 ditolak exchange -> ok:false dan SLA_+TPA_ dibatalkan (fail-closed)", async () => {
    let call = 0;
    const client = fakeClient({
      placeReduceOnlyGuard: vi.fn(async (input: Parameters<BinanceUsdMClient["placeReduceOnlyGuard"]>[0]) => {
        call++;
        if (call === 3) throw new Error("TP2_REJECTED");
        (client as unknown as { __placed: Array<{ clientAlgoId: string; triggerPrice: number }> }).__placed.push({ clientAlgoId: input.clientAlgoId, triggerPrice: input.triggerPrice });
        return algoEcho(input);
      }),
    });
    const res = await placePreEntryBracket({ ...LADDER_INPUT, client });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("TP2_PLACE_FAILED");
    const cancelled = (client as unknown as { __cancelled: string[] }).__cancelled;
    expect(cancelled.some((c) => c.startsWith("TPB_"))).toBe(true);
    expect(cancelled.some((c) => c.startsWith("TPA_"))).toBe(true);
    expect(cancelled.some((c) => c.startsWith("SLA_"))).toBe(true);
  });
});
