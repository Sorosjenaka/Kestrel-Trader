// apps/web/src/lib/realtimePnl.ts
//
// Rumus PnL realtime di FRONTEND (branch feat/realtime-pnl). Mark price datang
// dari WS publik Binance Futures (<symbol>@markPrice@1s, TANPA API key); entry,
// qty, leverage, dan side tetap dari endpoint backend yang sudah ada. Modul ini
// murni fungsi (tanpa DOM/WS) supaya bisa diuji vitest.
//
// ATURAN: display-only. Tidak mengirim order, tidak menyentuh logika
// trading/risk/eksekusi, tidak membaca/menulis .env.
//
// Rumus (kontrak):
//   uPnL      LONG = (mark - entry) * qty ; SHORT = (entry - mark) * qty
//   ROI%      = uPnL / (entry * qty / leverage) * 100   (= uPnL * lev / notional)
//   % harga   = (mark - entry) / entry * 100            (gerak harga polos dari entry)
//
// Nilai tidak valid SELALU null (bukan 0) — angka 0 palsu membuat operator
// mengira PnL benar-benar nol. Sesuai konvensi "null ≠ 0, placeholder jujur".

/** Input posisi yang dibutuhkan rumus. Sumber: LanePositionRow backend. */
export interface RealtimePnlPos {
  side: string; // "LONG" | "SHORT"
  entryPrice: number;
  qty: number;
  leverage?: number | null;
}

export interface RealtimePnlResult {
  /** PnL USD bertanda (positif = untung). */
  uPnL: number | null;
  /** ROI % terhadap margin (entry*qty/leverage). */
  roiPct: number | null;
  /** Gerak harga % dari entry (polos, bukan PnL). */
  pricePct: number | null;
  /** Mark price valid yang dipakai, atau null. */
  mark: number | null;
}

/** True hanya untuk side LONG; selain itu diperlakukan SHORT (sama dengan server). */
function isLongSide(side: string): boolean {
  return side === "LONG";
}

/**
 * PnL USD belum terealisasi.
 * LONG untung saat mark > entry; SHORT untung saat mark < entry.
 * mark tak valid (null/NaN/<=0) -> null, bukan 0.
 */
export function unrealizedUsd(pos: RealtimePnlPos, mark: number | null): number | null {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  const { entryPrice, qty } = pos;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(qty)) return null;
  const dir = isLongSide(pos.side) ? 1 : -1;
  return (mark - entryPrice) * dir * qty;
}

/**
 * ROI % terhadap margin. margin = entry*qty/leverage.
 * Leverage tak diketahui (null/0) -> null (margin tak bisa dihitung).
 */
export function roiPct(
  uPnL: number | null,
  entryPrice: number,
  qty: number,
  leverage: number | null | undefined,
): number | null {
  if (uPnL == null || !Number.isFinite(uPnL)) return null;
  if (leverage == null || !Number.isFinite(leverage) || leverage <= 0) return null;
  const notional = entryPrice * qty;
  if (!Number.isFinite(notional) || notional === 0) return null;
  const margin = notional / leverage;
  if (!Number.isFinite(margin) || margin === 0) return null;
  return (uPnL / margin) * 100;
}

/** Gerak harga % dari entry (polos). entry 0 -> null. */
export function priceFromEntryPct(entryPrice: number, mark: number | null): number | null {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return null;
  if (!Number.isFinite(entryPrice) || entryPrice === 0) return null;
  return ((mark - entryPrice) / entryPrice) * 100;
}

/** Hitung uPnL + ROI% + % harga dari entry untuk satu posisi pada satu mark. */
export function computeRealtimePnl(pos: RealtimePnlPos, mark: number | null): RealtimePnlResult {
  const validMark = mark != null && Number.isFinite(mark) && mark > 0 ? mark : null;
  const uPnL = unrealizedUsd(pos, validMark);
  return {
    uPnL,
    roiPct: roiPct(uPnL, pos.entryPrice, pos.qty, pos.leverage ?? null),
    pricePct: priceFromEntryPct(pos.entryPrice, validMark),
    mark: validMark,
  };
}

/** Total uPnL & ROI agregat untuk beberapa posisi (untuk StatCard). */
export function aggregatePnl(
  rows: Array<{ pos: RealtimePnlPos; mark: number | null }>,
): { uPnL: number | null; roiPct: number | null } {
  let total = 0;
  let totalMargin = 0;
  let any = false;
  for (const { pos, mark } of rows) {
    const u = unrealizedUsd(pos, mark);
    if (u == null) continue;
    any = true;
    total += u;
    const lev = pos.leverage;
    if (lev != null && Number.isFinite(lev) && lev > 0) {
      const notional = pos.entryPrice * pos.qty;
      if (Number.isFinite(notional)) totalMargin += notional / lev;
    }
  }
  if (!any) return { uPnL: null, roiPct: null };
  return {
    uPnL: Number(total.toFixed(4)),
    roiPct: totalMargin > 0 ? Number(((total / totalMargin) * 100).toFixed(2)) : null,
  };
}

// ── Format presisi ─────────────────────────────────────────────────────────

/** Jumlah desimal dari tickSize (0.1 -> 1, 0.01 -> 2, 0.00001 -> 5). */
export function decimalsForTick(tickSize: number | null | undefined): number {
  if (tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0) return 2;
  const exp = Number(tickSize.toExponential().split("e")[1]);
  return Math.max(0, -exp);
}

/** Harga dengan presisi tickSize. */
export function fmtPriceTick(v: number | null | undefined, tickSize: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "·";
  return v.toFixed(decimalsForTick(tickSize));
}

/** USD bertanda: 20 -> "+$20.00", -16.8655 -> "-$16.87", null -> "·". */
export function fmtUsdSigned(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "·";
  const s = Math.abs(v).toFixed(digits);
  return v >= 0 ? `+$${s}` : `-$${s}`;
}

/** Persen bertanda: 5.26997 -> "+5.27%", -10.5399 -> "-10.54%", null -> "·". */
export function fmtPctSigned(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "·";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
