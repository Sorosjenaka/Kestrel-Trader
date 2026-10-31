// apps/server/src/marketdata/structureTracker.ts
// Struktur pasar deterministik: swing high/low (fractal) -> BOS & CHOCH.
//
// Definisi yang dipakai (dokumentasi, bukan tebakan):
//  - Swing point = titik harga tertinggi/terendah dalamighborhood N
//    (N = 3 masing-masing sisi) pada seri harga per-detik.
//  - BOS (Break of Structure): harga PENEMBUS swing high terakhir (arah naik)
//    atau swing low terakhir (arah turun) -> VALIDASI lanjutan tren.
//  - CHOCH (Change of Character): harga menembus swing point BERLAWANAN
//    (yaitu-high saat tren turun, atau swing-low saat tren naik) -> tanda
//    perpotongan arah.
//
// Output: label ringkas + timestamp harga saat kejadian, dipakai kolom
// "ENGINE STRUCTURE" di Panel 1. Tidak ada angka karangan: kalau belum ada
// swing yang valid, label = "UNDEFINED" dan tidak ada harga.

export type StructureDirection = "UP" | "DOWN" | "UNDEFINED";
export type StructureEventKind = "BOS" | "CHOCH";

export interface StructureEvent {
  kind: StructureEventKind;
  direction: StructureDirection;
  price: number;
  time: number;
}

export interface StructureState {
  direction: StructureDirection;
  label: string;
  lastEvent: StructureEvent | null;
  lastSwingHigh: number | null;
  lastSwingLow: number | null;
  events: StructureEvent[];
}

const FRACTAL_LOOKBACK = 3;      // titik kiri/kanan untuk swing
const MAX_EVENTS = 40;
const PRICE_BUFFER = 600;        // ~10 menit @1Hz

export class StructureTracker {
  private readonly prices: number[] = [];
  private readonly times: number[] = [];
  private swingHigh: number | null = null;
  private swingLow: number | null = null;
  private direction: StructureDirection = "UNDEFINED";
  private lastEvent: StructureEvent | null = null;
  private readonly events: StructureEvent[] = [];

  /** Masukkan harga baru (epoch ms). Kembalikan event bila terbentuk. */
  push(price: number, time: number): StructureEvent | null {
    if (!(price > 0) || !Number.isFinite(price)) return null;
    this.prices.push(price);
    this.times.push(time);
    while (this.prices.length > PRICE_BUFFER) { this.prices.shift(); this.times.shift(); }
    if (this.prices.length < FRACTAL_LOOKBACK * 2 + 1) return null;

    const n = this.prices.length;
    const i = n - 1 - FRACTAL_LOOKBACK; // kandidat swing
    if (i < FRACTAL_LOOKBACK) return null;

    const mid = this.prices[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = i - FRACTAL_LOOKBACK; k <= i + FRACTAL_LOOKBACK; k++) {
      if (k === i) continue;
      const p = this.prices[k]!;
      if (p >= mid) isHigh = false;
      if (p <= mid) isLow = false;
    }
    if (!isHigh && !isLow) return null;

    const last = this.prices[n - 1]!;
    let ev: StructureEvent | null = null;

    if (isHigh) {
      // Break di atas swing high terakhir?
      if (this.swingHigh != null && last > this.swingHigh) {
        const kind: StructureEventKind = this.direction === "DOWN" ? "CHOCH" : "BOS";
        ev = { kind, direction: "UP", price: this.swingHigh, time: this.times[n - 1]! };
        this.direction = "UP";
      }
      this.swingHigh = mid;
      if (this.swingLow == null || mid > this.swingLow) { /* biarkan swingLow */ }
    } else if (isLow) {
      if (this.swingLow != null && last < this.swingLow) {
        const kind: StructureEventKind = this.direction === "UP" ? "CHOCH" : "BOS";
        ev = { kind, direction: "DOWN", price: this.swingLow, time: this.times[n - 1]! };
        this.direction = "DOWN";
      }
      this.swingLow = mid;
    }

    if (ev) {
      this.lastEvent = ev;
      this.events.push(ev);
      while (this.events.length > MAX_EVENTS) this.events.shift();
    }
    return ev;
  }

  state(now = Date.now()): StructureState {
    const ev = this.lastEvent;
    let label: string;
    if (this.direction === "UNDEFINED" || !ev) {
      label = "UNDEFINED";
    } else {
      const age = Math.max(0, Math.round((now - ev.time) / 1000));
      const priceTxt = ev.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
      label = `${this.direction} · ${ev.kind} ${ev.direction === "UP" ? "UP" : "DN"} @ ${priceTxt} (${age}s ago)`;
    }
    return {
      direction: this.direction,
      label,
      lastEvent: ev,
      lastSwingHigh: this.swingHigh,
      lastSwingLow: this.swingLow,
      events: this.events.slice(-MAX_EVENTS),
    };
  }

  /** Reset (mis. ganti simbol). */
  reset(): void {
    this.prices.length = 0;
    this.times.length = 0;
    this.swingHigh = null;
    this.swingLow = null;
    this.direction = "UNDEFINED";
    this.lastEvent = null;
    this.events.length = 0;
  }
}

/**
 * Klasifikasi "flow vs price" dari arah harga & arah CVD pada window yang sama.
 * Empat kemungkinan; TIDAK ada nilai netral palsu — Unknown kalau data kurang.
 */
export type FlowVsPrice =
  | "price up · takers net buying"
  | "price up · takers net selling"
  | "price down · takers net buying"
  | "price down · takers net selling"
  | "UNKNOWN";

export function classifyFlowVsPrice(priceChangePct: number | null, cvdDeltaUsd: number | null): FlowVsPrice {
  if (priceChangePct == null || cvdDeltaUsd == null) return "UNKNOWN";
  if (!Number.isFinite(priceChangePct) || !Number.isFinite(cvdDeltaUsd)) return "UNKNOWN";
  const priceUp = priceChangePct > 0;
  const flowUp = cvdDeltaUsd > 0;
  if (priceUp && flowUp) return "price up · takers net buying";
  if (priceUp && !flowUp) return "price up · takers net selling";
  if (!priceUp && flowUp) return "price down · takers net buying";
  return "price down · takers net selling";
}
