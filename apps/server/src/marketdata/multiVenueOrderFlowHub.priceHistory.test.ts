// apps/server/src/marketdata/multiVenueOrderFlowHub.priceHistory.test.ts
// 24 Okt 2026 — integrasi: buktikan perbaikan "51 detik" di level hub.
//
// priceHistory.test.ts (unit) membuktikan kelas PriceHistory-nya sendiri.
// Test ini drove jalur PRODUKSI: multiVenueOrderFlowHub.ingest() -> buildSnapshot(),
// yaitu persis jalur yang dipakai SSE tiap 1,5 detik.
//
// Yang diuji:
//   1. Batas memori: 100.000 transaksi -> priceHistory tetap ~1 sampel/detik.
//   2. Latensi: buildSnapshot() selesai < 1 detik (sebelum fix: 51 detik).
//   3. Integritas data: seri harga tanpa timestamp duplikat, % perubahan masuk akal.
//
// CATATAN: test ini memakai singleton multiVenueOrderFlowHub. Tidak ada efek
// samping jaringan: ingest() murni komputasi lokal (tidak menyentuh WS/REST).

import { describe, expect, it, beforeAll } from "vitest";
import { multiVenueOrderFlowHub, type OrderFlowSnapshot, type ParsedTrade } from "./multiVenueOrderFlowHub.js";
import type { VenueId } from "./microstructureTypes.js";
import type { PriceHistory } from "./priceHistory.js";

/**
 * Jalur hub yang dipakai test. `ingest` & `symbolStates` private di TS, jadi
 * diakses lewat cast; `buildSnapshot` publik tapi ikut dicantumkan agar tipe
 * return-nya terbaca (OrderFlowSnapshot).
 */
interface HubInternals {
  ingest(venue: VenueId, t: ParsedTrade): void;
  buildSnapshot(symbol: string, window?: "15m" | "1h" | "session"): OrderFlowSnapshot;
  symbolStates: Map<string, { priceHistory: PriceHistory; tradesIngested: number; lastPrice: number | null }>;
}

const hub = multiVenueOrderFlowHub as unknown as HubInternals;

const SYMBOL = "BTC";
const VENUES: VenueId[] = ["BINANCE_PERP", "BINANCE_SPOT", "HYPERLIQUID", "COINBASE"];

/** Jumlah transaksi sintetis. Setara ~280 tps x 6 menit. */
const TOTAL_TRADES = 100_000;
/** Rentang waktu transaksi (ms) — 1 jam ke belakang dari "sekarang". */
const SPAN_MS = 3_600_000;
/**
 * Jumlah bucket detik yang masuk ke [now - SPAN_MS, now].
 * Kedua ujung inklusif, jadi satu jam = 3.601 bucket detik (bukan 3.600).
 */
const EXPECTED_SECONDS = SPAN_MS / 1000 + 1;

/**
 * Bangun transaksi sintetis yang monotonik naik dalam waktu.
 * Harga deterministik (tanpa random) supaya test tidak flaky.
 */
function seedTrades(): void {
  const now = Date.now();
  const start = now - SPAN_MS;
  for (let i = 0; i < TOTAL_TRADES; i++) {
    // Sebar merata di sepanjang 1 jam -> 3.601 detik berbeda.
    const t = start + Math.floor((i / TOTAL_TRADES) * SPAN_MS);
    const price = 100_000 + (i % 97) * 0.5;
    // qty bervariasi supaya tier flow ikut terisi (SMALL..MEGA).
    const qty = i % 11 === 0 ? 12 : i % 3 === 0 ? 1.5 : 0.05;
    hub.ingest(VENUES[i % VENUES.length]!, {
      symbol: SYMBOL,
      takerSide: i % 2 === 0 ? "BUY" : "SELL",
      price,
      qty,
      time: t,
    });
  }
}

describe("multiVenueOrderFlowHub — integrasi priceHistory", () => {
  // Seed sekali untuk seluruh blok: data di hub bersifat kumulatif (singleton),
  // jadi seeding per-test akan menjumlahkan transaksi dan merusak asumsi batas.
  beforeAll(() => {
    seedTrades();
  });

  it("tetap TERBATAS: 100.000 transaksi tidak jadi 100.000 sampel", () => {
    const state = hub.symbolStates.get(SYMBOL);
    expect(state).toBeDefined();
    expect(state!.tradesIngested).toBe(TOTAL_TRADES);

    // 1 sampel per detik, jendela 3 jam -> maksimal 3.601 entri untuk 1 jam data.
    // SEBELUM fix: 100.000 objek hidup di old-space V8 per simbol.
    expect(state!.priceHistory.size).toBeLessThanOrEqual(EXPECTED_SECONDS);
    // Kompresi minimal 10x terhadap jumlah transaksi.
    expect(state!.priceHistory.size).toBeLessThan(TOTAL_TRADES / 10);
    // Tidak kosong: data benar-benar masuk.
    expect(state!.priceHistory.size).toBeGreaterThan(1_000);
  });

  it("buildSnapshot() CEPAT (< 1 detik) dan seri harga tanpa duplikat", () => {
    const t0 = Date.now();
    const snap = hub.buildSnapshot(SYMBOL, "1h");
    const elapsed = Date.now() - t0;

    // Pra-fix: 51,5 detik untuk window 1 jam. Sekarang harus jauh di bawah 1 detik.
    expect(elapsed).toBeLessThan(1_000);

    // Seri harga: tanpa timestamp duplikat.
    const stamps = snap.priceSeries.map((p) => p.t);
    expect(new Set(stamps).size).toBe(stamps.length);
    // Dan jumlahnya jauh lebih kecil dari jumlah transaksi.
    expect(stamps.length).toBeLessThan(TOTAL_TRADES / 10);
  });

  it("data hasil snapshot masuk akal (harga & % perubahan)", () => {
    const snap = hub.buildSnapshot(SYMBOL, "1h");

    // Harga terakhir ~100k (deterministik dari seed), dibaca dari seri harga.
    const last = snap.priceSeries[snap.priceSeries.length - 1];
    expect(last).toBeDefined();
    expect(last!.v).toBeGreaterThan(99_000);
    expect(last!.v).toBeLessThan(110_000);

    // % perubahan harus terhitung (bukan null) dan kecil (harga bergerak ±0,05%).
    // priceChangePct ada di teamRead per timeframe (15M & 1H).
    expect(snap.teamRead.length).toBe(2);
    for (const tr of snap.teamRead) {
      expect(tr.priceChangePct).not.toBeNull();
      expect(typeof tr.priceChangePct).toBe("number");
      expect(Math.abs(tr.priceChangePct!)).toBeLessThan(5);
    }
  });

  it("agregasi order flow tetap jalan setelah 100.000 transaksi", () => {
    const snap = hub.buildSnapshot(SYMBOL, "1h");

    // Ada dana yang lewat di book (agregat taker buy/sell per venue).
    const totalUsd = snap.cvd.perVenue.reduce((a, v) => a + v.buyUsd + v.sellUsd, 0);
    expect(totalUsd).toBeGreaterThan(0);
    // 100.000 transaksi x rata-rata ribuan USD = ratusan juta USD, minus yang
    // jatuh di luar window. Cukup jelas bahwa agregat bekerja.
    expect(totalUsd).toBeGreaterThan(1_000_000);
  });
});
