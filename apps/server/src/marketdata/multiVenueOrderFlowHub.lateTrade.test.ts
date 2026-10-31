// 25 Okt 2026 (scan sistem, HIGH) — regression test double-count trade terlambat.
// Bug: trade dengan sec < pendSec ditulis langsung ke slot aslinya LALU tetap
// masuk akumulator pending yang di-flush ke pendSec -> trade sama dihitung 2x.
// Repro scan: 3 trade (usd 10, 5, 7) dengan waktu mundur menghasilkan totalUsd 29
// dan trades 4 (salah) — seharusnya 22 dan 3.
import { describe, expect, it } from "vitest";
import { multiVenueOrderFlowHub, type OrderFlowSnapshot, type ParsedTrade } from "./multiVenueOrderFlowHub.js";
import type { VenueId } from "./microstructureTypes.js";

interface HubInternals {
  ingest(venue: VenueId, t: ParsedTrade): void;
  buildSnapshot(symbol: string, window?: "15m" | "1h" | "session"): OrderFlowSnapshot;
}

const hub = multiVenueOrderFlowHub as unknown as HubInternals;
// Simbol harus yang ter-track (ingest drop sisanya); file test terisolasi per
// file, jadi state singleton di sini bersih dari seed test lain.
const SYMBOL = "BTC";
const VENUE: VenueId = "BINANCE_PERP";

function usd(t: ParsedTrade): number {
  return t.price * t.qty;
}

describe("multiVenueOrderFlowHub — trade terlambat tidak double-count", () => {
  it("3 trade dengan timestamp mundur (10, 5, 7) -> delta = 22, bukan 29", () => {
    const now = Date.now();
    const s = Math.floor(now / 1000);
    // Detik "10 dtk lalu, 5 dtk lalu, 7 dtk lalu" — yang kedua & ketiga terlambat
    // relatif terhadap pendSec.
    const spec = [
      { dt: 10, price: 2, qty: 5 },   // usd 10
      { dt: 5, price: 1, qty: 5 },    // usd 5  (late)
      { dt: 7, price: 1, qty: 7 },    // usd 7  (late)
    ];
    let expectUsd = 0;
    for (const x of spec) {
      const t: ParsedTrade = { symbol: SYMBOL, takerSide: "BUY", price: x.price, qty: x.qty, time: (s - x.dt) * 1000 + 100 };
      expectUsd += usd(t);
      hub.ingest(VENUE, t);
    }
    // Pemicu flush bucket pending ke ring (di produksi terjadi saat detik baru
    // datang, ~1 dtk). Panggil langsung — ingest menolak timestamp masa depan,
    // jadi pemicu berbasis trade tidak stabil untuk test ini.
    const vs1 = (hub as any).states.get(`BINANCE_PERP|${SYMBOL}`);
    (hub as any).flushVenueSecond(vs1);
    expect(expectUsd).toBe(22);
    const snap = hub.buildSnapshot(SYMBOL, "15m");
    // Semua BUY -> delta == total buy. Bug lama: 29 (5 terhitung dua kali).
    expect(snap.cvd.allVenues).toBe(22);
  });

  it("trade terlambat + trade normal: tidak ada yang hilang, tidak ada yang ganda", () => {
    const now = Date.now();
    const s = Math.floor(now / 1000);
    const spec = [
      { dt: 30, price: 1, qty: 1 },  // usd 1
      { dt: 10, price: 1, qty: 2 },  // usd 2 (normal, pendSec baru)
      { dt: 20, price: 1, qty: 3 },  // usd 3 (late)
      { dt: 10, price: 1, qty: 4 },  // usd 4 (sama detik dengan pendSec)
    ];
    let expectUsd = 0;
    for (const x of spec) {
      const t: ParsedTrade = { symbol: "ETH", takerSide: "BUY", price: x.price, qty: x.qty, time: (s - x.dt) * 1000 + 200 };
      expectUsd += usd(t);
      hub.ingest(VENUE, t);
    }
    const vs2 = (hub as any).states.get(`BINANCE_PERP|ETH`);
    (hub as any).flushVenueSecond(vs2);
    expect(expectUsd).toBe(10);
    const snap = hub.buildSnapshot("ETH", "15m");
    expect(snap.cvd.allVenues).toBe(10);
  });
});
