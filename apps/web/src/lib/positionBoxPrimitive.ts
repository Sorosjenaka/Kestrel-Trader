// apps/web/src/lib/positionBoxPrimitive.ts
//
// POSITION BOX ala TradingView Long/Short Position tool (spec bagian I):
// zona rugi/untung + garis batas + label pill di dalam chart, menggantikan
// price line polos. LWC v5.2.1 ISeriesPrimitive via series.attachPrimitive().
//
// Prinsip (WAJIB, kontrak tes):
// - autoscaleInfo() SELALU return null — yang memasukkan level ke skala adalah
//   autoscaleInfoProvider series saat FIT LEVELS ON (lihat positionMath.ts).
// - setPosition(null) -> paneViews() kosong (box dilepas bersih).
// - setLastPrice(p) per tick -> shading entry->harga terakhir + pill uPnL,
//   pakai requestUpdate tanpa re-render React.
//
// Rendering terpisah jadi dua layer pane view: zona (zOrder "bottom", di bawah
// candle) dan label (zOrder "top"). Lifecycle attach/detach diatur panel chart.
import type {
  AutoscaleInfo,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import {
  fmtDayMonthWib,
  pctFromEntry,
  pnlR,
  rMultiple,
  riskDistance,
  tickFmt,
  unrealizedUsd,
} from "./positionMath.js";

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
type DrawUtils = Parameters<IPrimitivePaneRenderer["draw"]>[1];

export interface PositionBoxState {
  positionId: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  qty: number;
  /** Waktu buka posisi, Unix DETIK (domain sama dengan series.data()). */
  entryTimeSec: number;
}

export const BOX_COLORS = {
  loss: "rgba(242,65,74, 0.18)", // #F2414A alpha 0.18
  profit: "rgba(58,168,242, 0.18)", // #3AA8F2 alpha 0.18 (entry->TP1)
  profitFar: "rgba(58,168,242, 0.10)", // #3AA8F2 alpha 0.10 (TP1->TP2)
  liveProfit: "rgba(58,168,242, 0.12)",
  liveLoss: "rgba(242,65,74, 0.12)",
  entryLine: "rgba(255, 255, 255, 0.85)",
  slLine: "#F2414A",
  tpLine: "#3AA8F2",
  pillEntryBg: "#FFFFFF",
  pillEntryFg: "#111827",
  pillSlBg: "#F2414A",
  pillSlFg: "#FFFFFF",
  pillTpBg: "#3AA8F2",
  pillTpFg: "#080a17",
} as const;

/* ------------------------------------------------------------------ */
/* Fungsi murni (diuji tanpa canvas)                                    */
/* ------------------------------------------------------------------ */

/** Format harga presisi adaptif: 3.0882 -> "3.0882", 0.06497 -> "0.06497". */
export function fmtPrice(v: number): string {
  return String(parseFloat(v.toPrecision(6)));
}

/** Format qty tanpa nol belakang: 445.0000 -> "445", 6.5 -> "6.5". */
export function fmtQty(v: number): string {
  return String(parseFloat(v.toFixed(4)));
}

/** Format R-multiple: bulat -> "2R"/"-1R", pecahan 2 desimal -> "-0.25R". */
export function fmtR(v: number): string {
  if (Math.abs(v - Math.round(v)) < 0.005) return `${Math.round(v)}R`;
  // Pembulatan half-up eksplisit: (−0.245).toFixed(2) di JS = "-0.24"
  // (0.245 tidak presisi biner), padahal kontrak pill = "-0.25R".
  const scaled = Math.round((v + Math.sign(v) * 1e-9) * 100) / 100;
  return `${scaled.toFixed(2)}R`;
}

/** Format persen selalu bertanda: 5.26997 -> "+5.27%", -10.5399 -> "-10.54%". */
export function fmtSignedPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** Format dolar PnL: -9.475 -> "$-9.48". */
export function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export type LevelPillKind = "sl" | "entry" | "tp1" | "tp2";

export interface LevelPill {
  kind: LevelPillKind;
  text: string;
  price: number;
  bg: string;
  fg: string;
}

/**
 * Label pill per batas level (teks dikunci kontrak spec):
 * "SL 3.0882 · -1R · +5.27%", "SHORT · ENTRY 2.9336 · qty",
 * "TP1 2.6244 · 2R · -10.54%", "TP2 2.4698 · 3R · -15.81%".
 * Persen di sini = perubahan harga terhadap entry (bertanda harga).
 */
export function buildLevelPills(pos: PositionBoxState): LevelPill[] {
  const pills: LevelPill[] = [];
  const pct = (price: number) => fmtSignedPct(pctFromEntry(pos.entryPrice, price));
  const r = (price: number) => fmtR(rMultiple(pos, price) ?? 0);
  if (pos.slPrice != null) {
    pills.push({ kind: "sl", price: pos.slPrice, bg: BOX_COLORS.pillSlBg, fg: BOX_COLORS.pillSlFg, text: `SL ${fmtPrice(pos.slPrice)} · ${r(pos.slPrice)} · ${pct(pos.slPrice)}` });
  }
  pills.push({ kind: "entry", price: pos.entryPrice, bg: BOX_COLORS.pillEntryBg, fg: BOX_COLORS.pillEntryFg, text: `${pos.side} · ENTRY ${fmtPrice(pos.entryPrice)} · ${fmtQty(pos.qty)}` });
  if (pos.tp1Price != null) {
    pills.push({ kind: "tp1", price: pos.tp1Price, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg, text: `TP1 ${fmtPrice(pos.tp1Price)} · ${r(pos.tp1Price)} · ${pct(pos.tp1Price)}` });
  }
  if (pos.tp2Price != null) {
    pills.push({ kind: "tp2", price: pos.tp2Price, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg, text: `TP2 ${fmtPrice(pos.tp2Price)} · ${r(pos.tp2Price)} · ${pct(pos.tp2Price)}` });
  }
  return pills;
}

/** Pill kanan untuk harga terakhir: "uPnL -0.25R · -1.29% · $-9.48". */
export function buildUPnLText(pos: PositionBoxState, lastPrice: number): string {
  const r = pnlR(pos, lastPrice) ?? 0;
  const dir = pos.side === "LONG" ? 1 : -1;
  const pct = pctFromEntry(pos.entryPrice, lastPrice) * dir; // bertanda PnL
  const usd = unrealizedUsd(pos, lastPrice) ?? 0;
  return `uPnL ${fmtR(r)} · ${fmtSignedPct(pct)} · ${fmtUsd(usd)}`;
}

/**
 * Anti-tumpuk label pill: jarak minimum vertikal antar pill (kontrak: 20px).
 * Input ys bebas urutan; output terpetakan ke urutan input yang sama.
 */
export function resolvePillYs(ys: readonly number[], minGap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  let prev = -Infinity;
  for (const item of order) {
    if (item.y - prev < minGap) item.y = prev + minGap;
    prev = item.y;
  }
  const out = new Array<number>(ys.length);
  for (const item of order) out[item.i] = item.y;
  return out;
}

/**
 * Binary search bar entry: bar dengan time <= entryTimeSec (bar yang berisi
 * saat posisi dibuka). Null bila entry sebelum data pertama.
 */
export function findEntryBarTime(bars: readonly { time: number }[], entryTimeSec: number): number | null {
  if (!bars.length || entryTimeSec < bars[0]!.time) return null;
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid]!.time <= entryTimeSec) lo = mid; else hi = mid - 1;
  }
  return bars[lo]!.time;
}

/** Pill tepi ▲/▼ untuk level di luar layar. HANYA dibangun saat FIT LEVELS OFF. */
export function buildEdgePills(
  pos: Pick<PositionBoxState, "slPrice" | "tp1Price" | "tp2Price">,
  fitLevels: boolean,
  priceToY: (price: number) => number | null,
  mediaHeight: number,
): Array<{ y: number; text: string; bg: string; fg: string }> {
  const out: Array<{ y: number; text: string; bg: string; fg: string }> = [];
  if (fitLevels) return out;
  const edges: Array<{ price: number | null; text: string; bg: string; fg: string }> = [
    { price: pos.slPrice, text: `SL ${pos.slPrice != null ? fmtPrice(pos.slPrice) : ""}`, bg: BOX_COLORS.pillSlBg, fg: BOX_COLORS.pillSlFg },
    { price: pos.tp1Price, text: `TP1 ${pos.tp1Price != null ? fmtPrice(pos.tp1Price) : ""}`, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg },
    { price: pos.tp2Price, text: `TP2 ${pos.tp2Price != null ? fmtPrice(pos.tp2Price) : ""}`, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg },
  ];
  for (const e of edges) {
    if (e.price == null) continue;
    const y = priceToY(e.price);
    if (y == null) continue;
    if (y < 0) out.push({ y: 12, text: `▲ ${e.text}`, bg: e.bg, fg: e.fg });
    else if (y > mediaHeight) out.push({ y: mediaHeight - 12, text: `▼ ${e.text}`, bg: e.bg, fg: e.fg });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Primitive                                                           */
/* ------------------------------------------------------------------ */

type Attached = SeriesAttachedParameter<Time, SeriesType>;

interface BoxGeometry {
  x0: number;
  xRight: number;
  zones: Array<{ y1: number; y2: number; fill: string }>;
  lines: Array<{ y: number; color: string; dashed: boolean }>;
  live: { y1: number; y2: number; fill: string } | null;
  pills: Array<{ y: number; text: string; bg: string; fg: string }>;
  uPnL: { y: number; text: string; bg: string; fg: string } | null;
  edgePills: Array<{ y: number; text: string; bg: string; fg: string }>;
}

/**
 * Primitive position box. Dipakai per seri candlestick:
 *   series.attachPrimitive(box) saat posisi ada, detach saat tutup/ganti simbol.
 * Mendukung banyak posisi sekaligus (satu box per posisi).
 */
export class PositionBoxPrimitive implements ISeriesPrimitive<Time> {
  private positions: PositionBoxState[] = [];
  private lastPrice: number | null = null;
  private fitLevels = true;
  private params: Attached | null = null;
  private paneViewCache: IPrimitivePaneView[] | null = null;
  private axisViewCache: ISeriesPrimitiveAxisView[] | null = null;

  private readonly zoneView: IPrimitivePaneView;
  private readonly labelView: IPrimitivePaneView;

  constructor() {
    this.zoneView = {
      zOrder: (): PrimitivePaneViewZOrder => "bottom", // di bawah candle
      renderer: (): IPrimitivePaneRenderer | null => ({ draw: (t, u) => this.drawZones(t, u) }),
    };
    this.labelView = {
      zOrder: (): PrimitivePaneViewZOrder => "top", // di atas candle
      renderer: (): IPrimitivePaneRenderer | null => ({ draw: (t, u) => this.drawLabels(t, u) }),
    };
  }

  /* ---------- state (tanpa re-render React) ---------- */

  /** Ganti set posisi; null/kosong = lepas semua box. */
  setPosition(pos: PositionBoxState | PositionBoxState[] | null): void {
    this.positions = pos == null ? [] : Array.isArray(pos) ? [...pos] : [pos];
    this.paneViewCache = null;
    this.axisViewCache = null;
    this.requestRedraw();
  }

  /** Harga terakhir per tick -> shading entry->harga + pill uPnL. */
  setLastPrice(price: number | null): void {
    this.lastPrice = price;
    this.requestRedraw();
  }

  /** FIT LEVELS OFF -> pill ▲/▼ di tepi untuk level di luar layar. */
  setFitLevels(on: boolean): void {
    this.fitLevels = on;
    this.requestRedraw();
  }

  getPositions(): readonly PositionBoxState[] {
    return this.positions;
  }

  getLastPrice(): number | null {
    return this.lastPrice;
  }

  isFitLevels(): boolean {
    return this.fitLevels;
  }

  /* ---------- lifecycle LWC ---------- */

  attached(param: Attached): void {
    this.params = param;
    this.requestRedraw();
  }

  detached(): void {
    this.params = null;
  }

  updateAllViews(): void {
    /* koordinat dihitung saat draw (bergantung viewport) */
  }

  // Kontrak: TIDAK PERNAH menyumbang ke skala — level masuk skala lewat
  // autoscaleInfoProvider series (FIT LEVELS ON) di TradingChartPanel.
  autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    return null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    if (!this.positions.length) {
      this.paneViewCache = [];
      return this.paneViewCache;
    }
    if (!this.paneViewCache) this.paneViewCache = [this.zoneView, this.labelView];
    return this.paneViewCache;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    if (!this.axisViewCache) {
      const views: ISeriesPrimitiveAxisView[] = [];
      for (const pos of this.positions) {
        const levels: Array<{ price: number; label: string; bg: string; fg: string }> = [
          { price: pos.entryPrice, label: `E ${fmtPrice(pos.entryPrice)}`, bg: BOX_COLORS.pillEntryBg, fg: BOX_COLORS.pillEntryFg },
        ];
        if (pos.slPrice != null) levels.push({ price: pos.slPrice, label: `SL ${fmtPrice(pos.slPrice)}`, bg: BOX_COLORS.pillSlBg, fg: BOX_COLORS.pillSlFg });
        if (pos.tp1Price != null) levels.push({ price: pos.tp1Price, label: `TP1 ${fmtPrice(pos.tp1Price)}`, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg });
        if (pos.tp2Price != null) levels.push({ price: pos.tp2Price, label: `TP2 ${fmtPrice(pos.tp2Price)}`, bg: BOX_COLORS.pillTpBg, fg: BOX_COLORS.pillTpFg });
        for (const lv of levels) {
          views.push({
            coordinate: () => this.priceToY(lv.price) ?? -1,
            text: () => lv.label,
            textColor: () => lv.fg,
            backColor: () => lv.bg,
            visible: () => this.priceToY(lv.price) != null,
            tickVisible: () => false,
          });
        }
      }
      this.axisViewCache = views;
    }
    return this.axisViewCache;
  }

  /* ---------- geometri ---------- */

  private priceToY(price: number): number | null {
    return this.params?.series.priceToCoordinate(price) ?? null;
  }

  /** x awal box = tepi kiri bar entry (binary search series.data()). */
  private entryX(entryTimeSec: number, fallbackX: number): number {
    const p = this.params;
    if (!p) return fallbackX;
    let barTime: number | null = null;
    try {
      barTime = findEntryBarTime(p.series.data() as unknown as { time: number }[], entryTimeSec);
    } catch {
      barTime = null;
    }
    if (barTime == null) return fallbackX;
    const c = p.chart.timeScale().timeToCoordinate(barTime as Time);
    return c != null ? Math.max(0, c) : fallbackX;
  }

  private geometry(pos: PositionBoxState, mediaWidth: number, mediaHeight: number): BoxGeometry | null {
    const entryY = this.priceToY(pos.entryPrice);
    if (entryY == null) return null;
    const x0 = this.entryX(pos.entryTimeSec, 0);
    const xRight = mediaWidth;
    const zones: BoxGeometry["zones"] = [];
    const lines: BoxGeometry["lines"] = [];

    const slY = pos.slPrice != null ? this.priceToY(pos.slPrice) : null;
    const tp1Y = pos.tp1Price != null ? this.priceToY(pos.tp1Price) : null;
    const tp2Y = pos.tp2Price != null ? this.priceToY(pos.tp2Price) : null;

    if (slY != null) zones.push({ y1: entryY, y2: slY, fill: BOX_COLORS.loss }); // zona rugi entry->SL
    if (tp1Y != null) zones.push({ y1: entryY, y2: tp1Y, fill: BOX_COLORS.profit }); // entry->TP1 (2R)
    if (tp1Y != null && tp2Y != null) zones.push({ y1: tp1Y, y2: tp2Y, fill: BOX_COLORS.profitFar }); // TP1->TP2 (3R)

    lines.push({ y: entryY, color: BOX_COLORS.entryLine, dashed: false });
    if (slY != null) lines.push({ y: slY, color: BOX_COLORS.slLine, dashed: false });
    if (tp1Y != null) lines.push({ y: tp1Y, color: BOX_COLORS.tpLine, dashed: false });
    if (tp2Y != null) lines.push({ y: tp2Y, color: BOX_COLORS.tpLine, dashed: true }); // TP2 putus-putus

    // Shading entry -> harga terakhir (live)
    let live: BoxGeometry["live"] = null;
    const lastY = this.lastPrice != null ? this.priceToY(this.lastPrice) : null;
    if (lastY != null && this.lastPrice != null) {
      const profit = (this.lastPrice - pos.entryPrice) * (pos.side === "LONG" ? 1 : -1) >= 0;
      live = { y1: entryY, y2: lastY, fill: profit ? BOX_COLORS.liveProfit : BOX_COLORS.liveLoss };
    }

    // Pill level (anti-tumpuk, jarak min 20px)
    const levelPills = buildLevelPills(pos);
    const wanted = levelPills.map((pill) => this.priceToY(pill.price));
    const haveAll = wanted.every((y) => y != null);
    const pills: BoxGeometry["pills"] = [];
    if (haveAll) {
      const adjusted = resolvePillYs(wanted as number[], 20);
      levelPills.forEach((pill, i) => {
        pills.push({ y: adjusted[i]!, text: pill.text, bg: pill.bg, fg: pill.fg });
      });
    }

    // Pill uPnL kanan pada harga terakhir
    let uPnL: BoxGeometry["uPnL"] = null;
    if (lastY != null && this.lastPrice != null) {
      const usd = unrealizedUsd(pos, this.lastPrice) ?? 0;
      uPnL = {
        y: lastY,
        text: buildUPnLText(pos, this.lastPrice),
        bg: usd >= 0 ? BOX_COLORS.pillTpBg : BOX_COLORS.pillSlBg,
        fg: usd >= 0 ? BOX_COLORS.pillTpFg : BOX_COLORS.pillSlFg,
      };
    }

    // Pill tepi ▲/▼ HANYA saat FIT LEVELS OFF & level di luar layar
    const edgePills: BoxGeometry["edgePills"] = buildEdgePills(pos, this.fitLevels, (p) => this.priceToY(p), mediaHeight);

    return { x0, xRight, zones, lines, live, pills, uPnL, edgePills };
  }

  /* ---------- rendering ---------- */

  private forEachGeometry(target: DrawTarget, fn: (g: BoxGeometry, ctx: CanvasRenderingContext2D) => void): void {
    const p = this.params;
    if (!p || !this.positions.length) return;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      for (const pos of this.positions) {
        const g = this.geometry(pos, mediaSize.width, mediaSize.height);
        if (g) fn(g, context);
      }
    });
  }

  private drawZones(target: DrawTarget, _utils?: DrawUtils): void {
    this.forEachGeometry(target, (g, ctx) => {
      for (const z of g.zones) {
        const y = Math.min(z.y1, z.y2);
        const h = Math.abs(z.y2 - z.y1);
        ctx.fillStyle = z.fill;
        ctx.fillRect(g.x0, y, Math.max(0, g.xRight - g.x0), h);
      }
      if (g.live) {
        const y = Math.min(g.live.y1, g.live.y2);
        const h = Math.abs(g.live.y2 - g.live.y1);
        ctx.fillStyle = g.live.fill;
        ctx.fillRect(g.x0, y, Math.max(0, g.xRight - g.x0), h);
      }
      for (const ln of g.lines) {
        ctx.save();
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = 1;
        if (ln.dashed) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(g.x0, ln.y + 0.5);
        ctx.lineTo(g.xRight, ln.y + 0.5);
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  private drawLabels(target: DrawTarget, _utils?: DrawUtils): void {
    this.forEachGeometry(target, (g, ctx) => {
      const pills = [...g.pills.map((p) => ({ ...p, x: g.x0 + 6, align: "left" as const })), ...(g.uPnL ? [{ ...g.uPnL, x: g.xRight - 6, align: "right" as const }] : []), ...g.edgePills.map((p) => ({ ...p, x: g.x0 + 6, align: "left" as const }))];
      for (const pill of pills) this.drawPill(ctx, pill.x, pill.y, pill.text, pill.bg, pill.fg, pill.align);
    });
  }

  private drawPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, align: "left" | "right"): void {
    ctx.save();
    ctx.font = "10px Inter, system-ui, sans-serif";
    const padX = 6;
    const h = 16;
    const w = ctx.measureText(text).width + padX * 2;
    const left = align === "right" ? x - w : x;
    const top = y - h - 3; // kiri-atas tiap batas: pill melayang di atas garis
    ctx.fillStyle = bg;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, 4);
      ctx.fill();
    } else {
      ctx.fillRect(left, top, w, h);
    }
    ctx.fillStyle = fg;
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + padX, top + h / 2);
    ctx.restore();
  }

  private requestRedraw(): void {
    this.params?.requestUpdate();
  }
}

// Dipakai panel untuk narik data tanggal/jam sumbu dari modul yang sama.
export { fmtDayMonthWib, tickFmt };
