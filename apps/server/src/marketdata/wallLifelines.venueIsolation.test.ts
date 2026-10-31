// 25 Okt 2026 (FASE 5, scan sistem) — regression test isolasi venue Wall Lifelines.
// Bug: state wall keyed per simbol tanpa filter venue -> update book Binance
// menandai wall Hyperliquid sebagai hilang/pulled/eaten palsu.
import { describe, expect, it } from "vitest";
import { WallLifelinesTracker, WALL_MIN_USD } from "./wallLifelines.js";
import type { BookSnapshot } from "./microstructureTypes.js";

function book(venue: "HYPERLIQUID" | "BINANCE_PERP", t: number, bidUsd: number | null, mid = 100_000): BookSnapshot {
  return {
    venue,
    symbol: "BTC",
    t,
    mid,
    bids: bidUsd == null ? [] : [{ price: mid - 50, notionalUsd: bidUsd }],
    asks: [],
  } as unknown as BookSnapshot;
}

describe("wallLifelines — identitas wall dipisah per venue", () => {
  it("book venue BUKAN tempat wall berada tidak menandai wall itu hilang/pulled", () => {
    const tr = new WallLifelinesTracker();
    const T = Date.now() - 10_000;

    // Wall muncul di Hyperliquid (bid besar).
    tr.onBook(book("HYPERLIQUID", T, WALL_MIN_USD * 2));
    const hl = tr.snapshot("BTC", "HYPERLIQUID");
    expect(hl.summary.appeared).toBe(1);
    expect(hl.summary.active).toBe(1);

    // Update Binance TANPA level itu, di luar grace period (2 dtk kemudian).
    // Pra-fix: wall HL dicocokkan/ditandai lewat book Binance -> pulled/gone palsu.
    tr.onBook(book("BINANCE_PERP", T + 2_000, null));
    tr.onBook(book("BINANCE_PERP", T + 4_000, null));

    const hlAfter = tr.snapshot("BTC", "HYPERLIQUID");
    expect(hlAfter.summary.pulled).toBe(0);
    expect(hlAfter.summary.eaten).toBe(0);
    expect(hlAfter.summary.active).toBe(1); // wall HL masih hidup
    expect(hlAfter.events.filter((e) => e.kind === "pulled" || e.kind === "eaten")).toHaveLength(0);

    // Wall di venue lain (Binance) tetap independen: muncul & hilang sendiri.
    tr.onBook(book("BINANCE_PERP", T + 5_000, WALL_MIN_USD * 2));
    expect(tr.snapshot("BTC", "BINANCE_PERP").summary.appeared).toBe(1);
  });

  it("pulled yang asli TETAP terdeteksi di venue yang sama", () => {
    const tr = new WallLifelinesTracker();
    const T = Date.now() - 10_000;
    tr.onBook(book("BINANCE_PERP", T, WALL_MIN_USD * 2));
    expect(tr.snapshot("BTC", "BINANCE_PERP").summary.active).toBe(1);
    // Book Binance TANPA wall itu di luar grace -> GONE, lalu markPulled menandai PULLED.
    tr.onBook(book("BINANCE_PERP", T + 2_000, null));
    tr.markPulled(T + 120_000);
    const after = tr.snapshot("BTC", "BINANCE_PERP");
    expect(after.summary.pulled + after.summary.eaten).toBeGreaterThanOrEqual(1);
  });
});
