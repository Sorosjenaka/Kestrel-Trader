// apps/server/src/exec/positionOverlay.ts
// POSITION-STATE SYNC SERVICE untuk overlay chart (14 Okt 2026).
// Sumber kebenaran: state posisi terkonfirmasi (DB, diisi oleh execution engine
// & positionSupervisor dari fill Binance) — BUKAN harga menyentuh level.
// Output idempoten per positionId: adapter chart memperbarui drawing yang
// sama (key = positionId), tidak pernah menduplikasi.
//
// BATAS: service ini HANYA membaca & menyajikan state. Ia tidak pernah
// mengirim/modify order; execution engine + risk control tetap otoritatif.
// Chart line terlihat ≠ order terlindungi di exchange (dicek via tanda
// `protectionConfirmed` yang hanya true bila SL/TP state valid di DB).
import { db } from "../core/db.js";
import { SWING_RR23, usesSwingRr23 } from "../strategies/swing/researchExitPolicy.js";

export interface PositionOverlay {
  /** Key idempoten drawing chart — satu posisi = satu set drawing. */
  positionId: number;
  symbol: string;
  mode: string;
  /** 14 Okt 2026: sumber posisi apa adanya (MANUAL = fixture/demo, bukan sinyal strategi). */
  source: string;
  /** Catatan ladder: RR23 50/50 @2R/3R atau legacy 40/30/30. */
  ladderNote: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  /** Qty awal terkonfirmasi (originalQty fallback qty) — dasar split TP. */
  originalQty: number;
  /** Rencana ladder (qty). Display saja — eksekusi tetap milik engine. */
  tp1Qty: number;
  tp2Qty: number;
  tpMaxQty: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  /** Target akhir ladder (TP2/final 3R untuk RR23; TPMAX 5R untuk legacy). */
  tpMaxPrice: number;
  tp1FilledAt: string | null;
  tp1FillPrice: number | null;
  /** BEP terkonfirmasi (beMoved di-set engine, bukan harga sentuh BE). */
  bepConfirmed: boolean;
  bepPrice: number | null;
  /** Trailing stop dinamis dari state engine. */
  trailActive: boolean;
  trailPeak: number | null;
  trailPrice: number | null;
  protectionConfirmed: boolean;
  openedAt: string;
  updatedAt: string;
}

/** Rumus trailing mengikuti konvensi engine: trail 1R di belakang peak. */
export function computeTrailPrice(side: string, trailPeak: number, entryPrice: number, slPrice: number): number {
  const r = Math.abs(entryPrice - slPrice);
  if (!(r > 0)) return trailPeak;
  return side === "LONG" ? trailPeak - r : trailPeak + r;
}

/** Peta satu baris Position → overlay (murni, mudah dites). */
export function toPositionOverlay(p: {
  id: number; symbol: string; mode: string; source?: string; side: string; entryPrice: number;
  qty: number; originalQty: number | null; slPrice: number; tp1Price: number;
  tp2Price: number | null; entryAttrs?: string | null; tp1FilledAt: Date | null; tp1FillPrice: number | null;
  beMoved: boolean; trailActive: boolean; trailPeak: number | null;
  updatedAt?: Date;
}): PositionOverlay {
  const orig = p.originalQty && p.originalQty > 0 ? p.originalQty : p.qty;
  const rr23 = usesSwingRr23({ mode: p.mode, source: p.source, entryAttrs: p.entryAttrs });
  // Ladder DB valid bila TP2 benar-benar berbeda dari TP1. Posisi legacy lama
  // dapat memiliki TP2 == TP1; proyeksi fallback tetap dipertahankan.
  const hasDistinctEngineTp2 = !!(p.tp2Price && p.tp2Price > 0 && p.tp2Price !== p.tp1Price);
  const tp1Qty = +((orig * (rr23 ? SWING_RR23.tp1Frac : 0.4))).toFixed(6);
  // RR23: sisa qty setelah pembulatan step masuk ke TP2/final 3R.
  // Legacy: alokasi 30% tetap dipertahankan agar posisi lama tidak berubah.
  const tp2Qty = rr23
    ? +Math.max(0, orig - tp1Qty).toFixed(6)
    : +((orig * 0.3)).toFixed(6);
  const bepPrice = p.beMoved ? p.entryPrice : null;
  const trailPrice =
    p.trailActive && p.trailPeak && p.trailPeak > 0
      ? computeTrailPrice(p.side, p.trailPeak, p.entryPrice, p.slPrice)
      : null;
  return {
    positionId: p.id,
    symbol: p.symbol,
    mode: p.mode,
    source: p.source ?? "UNKNOWN",
    ladderNote: rr23
      ? "RR23: TP1 50% @2R, BE setelah TP1, TP2/final 50% @3R."
      : hasDistinctEngineTp2
        ? "Ladder legacy dari state engine (TP2 terisi)."
        : "Engine legacy: TP2/TPMax adalah proyeksi rencana dari R, belum dieksekusi engine.",
    side: p.side === "SHORT" ? "SHORT" : "LONG",
    entryPrice: p.entryPrice,
    originalQty: orig,
    tp1Qty, tp2Qty,
    tpMaxQty: +Math.max(0, orig - tp1Qty - tp2Qty).toFixed(6),
    slPrice: p.slPrice,
    tp1Price: p.tp1Price,
    // RR23: TP2/final is 3R and TPMAX is the same final leg (no runner).
    // Legacy: TP2 is projected 0.5R beyond TP1; TPMAX remains 3×TP1 offset.
    tp2Price: hasDistinctEngineTp2
      ? p.tp2Price!
      : p.tp1Price > 0
        ? rr23
          ? +(p.entryPrice + (p.side === "LONG" ? 1 : -1) * 3 * Math.abs(p.entryPrice - p.slPrice)).toFixed(8)
          : +(p.tp1Price + (p.side === "LONG" ? 1 : -1) * 0.5 * Math.abs(p.entryPrice - p.slPrice)).toFixed(8)
        : 0,
    // RR23 final = TP2 3R; legacy TPMAX = entry ± 3×offset TP1 (R×5).
    tpMaxPrice: rr23
      ? (hasDistinctEngineTp2 ? p.tp2Price! : (p.tp1Price > 0 ? +(p.entryPrice + (p.side === "LONG" ? 1 : -1) * 3 * Math.abs(p.entryPrice - p.slPrice)).toFixed(8) : 0))
      : p.tp1Price > 0
        ? +(p.entryPrice + (p.side === "LONG" ? 1 : -1) * 3 * Math.abs(p.tp1Price - p.entryPrice)).toFixed(8)
        : 0,
    tp1FilledAt: p.tp1FilledAt?.toISOString() ?? null,
    tp1FillPrice: p.tp1FillPrice ?? null,
    bepConfirmed: p.beMoved,
    bepPrice,
    trailActive: p.trailActive,
    trailPeak: p.trailPeak ?? null,
    trailPrice,
    // "Terkonfirmasi" = SL & TP valid (>0) di state engine; bukan klaim order exchange.
    protectionConfirmed: p.slPrice > 0 && p.tp1Price > 0,
    openedAt: (p.updatedAt ?? new Date()).toISOString(),
    updatedAt: (p.updatedAt ?? new Date()).toISOString(),
  };
}

/** Ambil overlay untuk semua posisi open terkonfirmasi (idempoten per positionId). */
export async function gatherPositionOverlays(symbol?: string): Promise<PositionOverlay[]> {
  const rows = await db.position.findMany({
    where: {
      status: "OPEN",
      source: { not: "DEMO" },
      ...(symbol ? { symbol: symbol.toUpperCase() } : {}),
    },
    orderBy: { openedAt: "desc" },
    take: 50,
    select: {
      id: true, symbol: true, mode: true, source: true, side: true, entryPrice: true, qty: true,
      originalQty: true, slPrice: true, tp1Price: true, tp2Price: true, entryAttrs: true,
      tp1FilledAt: true, tp1FillPrice: true, beMoved: true,
      trailActive: true, trailPeak: true, openedAt: true,
    },
  }).catch(() => []);
  return rows.map((r) => toPositionOverlay({ ...r, updatedAt: r.openedAt }));
}
