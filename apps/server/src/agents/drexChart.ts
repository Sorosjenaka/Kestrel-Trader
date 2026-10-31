// apps/server/src/agents/drexChart.ts
// Renderer chart PNG PURE-NODE (tanpa chromium, tanpa dependensi native) untuk
// dikirim ke Drex-Max lewat field `images` (vision).
//
// Kenapa pure-Node: server produksi tidak punya chromium/puppeteer (lihat
// DIAGNOSIS-RSW02-DREX-2026-10-23.md BAGIAN 4). PNG ditulis manual: raster RGB
// -> scanline filter 0 -> zlib deflate (node:zlib) -> chunk IHDR/IDAT/IEND.
//
// Yang digambar: lilin OHLC (body + wick), garis close, grid harga + label,
// judul simbol/timeframe, dan level entry/SL/TP plan bila tersedia.
// Tanpa font eksternal: font 5x7 monospace digambar per piksel.
//
// ATURAN:
// - Fungsi ini PURE: tidak menyentuh jaringan, DB, env, atau order.
// - Data input = bar OHLC yang SUDAH TUTUP (caller yang jujur soal look-ahead).
// - Tidak pernah mengarang harga: semua angka berasal dari bar/level yang diberi.
import { deflateSync } from "node:zlib";

export interface DrexChartBar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DrexChartLevels {
  entry?: number | null;
  sl?: number | null;
  tp?: number | null;
}

export interface DrexChartOptions {
  symbol: string;
  timeframe: string;
  width?: number;
  height?: number;
  /** Maks bar yang digambar (bar paling baru). */
  maxBars?: number;
  /** Level plan (entry/SL/TP) digambar sebagai garis putus-putus. */
  levels?: DrexChartLevels | null;
}

type Rgb = readonly [number, number, number];

const BG: Rgb = [11, 14, 20];
const GRID: Rgb = [30, 36, 48];
const GRID_TEXT: Rgb = [120, 134, 156];
const TITLE_TEXT: Rgb = [190, 202, 222];
const UP: Rgb = [38, 166, 154];
const DOWN: Rgb = [239, 83, 80];
const CLOSE_LINE: Rgb = [122, 162, 247];
const LEVEL_ENTRY: Rgb = [247, 208, 96];
const LEVEL_SL: Rgb = [239, 83, 80];
const LEVEL_TP: Rgb = [38, 166, 154];

const MARGIN_LEFT = 6;
const MARGIN_RIGHT = 66;
const MARGIN_TOP = 22;
const MARGIN_BOTTOM = 20;

// ── Font 5x7 (column-major, bit 0 = baris paling atas) ──────────────────────
// Cukup untuk simbol, angka, dan label level. Huruf kecil dipetakan ke kapital.
const FONT5X7: Record<string, readonly number[]> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00],
  "!": [0x00, 0x00, 0x5f, 0x00, 0x00],
  "#": [0x14, 0x7f, 0x14, 0x7f, 0x14],
  "$": [0x24, 0x2a, 0x7f, 0x2a, 0x12],
  "%": [0x23, 0x13, 0x08, 0x64, 0x62],
  "&": [0x36, 0x49, 0x55, 0x22, 0x50],
  "'": [0x00, 0x05, 0x03, 0x00, 0x00],
  "(": [0x00, 0x1c, 0x22, 0x41, 0x00],
  ")": [0x00, 0x41, 0x22, 0x1c, 0x00],
  "*": [0x14, 0x08, 0x3e, 0x08, 0x14],
  "+": [0x08, 0x08, 0x3e, 0x08, 0x08],
  ",": [0x00, 0x50, 0x30, 0x00, 0x00],
  "-": [0x08, 0x08, 0x08, 0x08, 0x08],
  ".": [0x00, 0x60, 0x60, 0x00, 0x00],
  "/": [0x20, 0x10, 0x08, 0x04, 0x02],
  "0": [0x3e, 0x51, 0x49, 0x45, 0x3e],
  "1": [0x00, 0x42, 0x7f, 0x40, 0x00],
  "2": [0x42, 0x61, 0x51, 0x49, 0x46],
  "3": [0x21, 0x41, 0x45, 0x4b, 0x31],
  "4": [0x18, 0x14, 0x12, 0x7f, 0x10],
  "5": [0x27, 0x45, 0x45, 0x45, 0x39],
  "6": [0x3c, 0x4a, 0x49, 0x49, 0x30],
  "7": [0x01, 0x71, 0x09, 0x05, 0x03],
  "8": [0x36, 0x49, 0x49, 0x49, 0x36],
  "9": [0x06, 0x49, 0x49, 0x29, 0x1e],
  ":": [0x00, 0x36, 0x36, 0x00, 0x00],
  ";": [0x00, 0x56, 0x36, 0x00, 0x00],
  "<": [0x08, 0x14, 0x22, 0x41, 0x00],
  "=": [0x14, 0x14, 0x14, 0x14, 0x14],
  ">": [0x00, 0x41, 0x22, 0x14, 0x08],
  "?": [0x02, 0x01, 0x51, 0x09, 0x06],
  "@": [0x32, 0x49, 0x79, 0x41, 0x3e],
  "A": [0x7e, 0x11, 0x11, 0x11, 0x7e],
  "B": [0x7f, 0x49, 0x49, 0x49, 0x36],
  "C": [0x3e, 0x41, 0x41, 0x41, 0x22],
  "D": [0x7f, 0x41, 0x41, 0x22, 0x1c],
  "E": [0x7f, 0x49, 0x49, 0x49, 0x41],
  "F": [0x7f, 0x09, 0x09, 0x09, 0x01],
  "G": [0x3e, 0x41, 0x49, 0x49, 0x7a],
  "H": [0x7f, 0x08, 0x08, 0x08, 0x7f],
  "I": [0x00, 0x41, 0x7f, 0x41, 0x00],
  "J": [0x20, 0x40, 0x41, 0x3f, 0x01],
  "K": [0x7f, 0x08, 0x14, 0x22, 0x41],
  "L": [0x7f, 0x40, 0x40, 0x40, 0x40],
  "M": [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  "N": [0x7f, 0x04, 0x08, 0x10, 0x7f],
  "O": [0x3e, 0x41, 0x41, 0x41, 0x3e],
  "P": [0x7f, 0x09, 0x09, 0x09, 0x06],
  "Q": [0x3e, 0x41, 0x51, 0x21, 0x5e],
  "R": [0x7f, 0x09, 0x19, 0x29, 0x46],
  "S": [0x46, 0x49, 0x49, 0x49, 0x31],
  "T": [0x01, 0x01, 0x7f, 0x01, 0x01],
  "U": [0x3f, 0x40, 0x40, 0x40, 0x3f],
  "V": [0x1f, 0x20, 0x40, 0x20, 0x1f],
  "W": [0x3f, 0x40, 0x38, 0x40, 0x3f],
  "X": [0x63, 0x14, 0x08, 0x14, 0x63],
  "Y": [0x07, 0x08, 0x70, 0x08, 0x07],
  "Z": [0x61, 0x51, 0x49, 0x45, 0x43],
  "[": [0x00, 0x7f, 0x41, 0x41, 0x00],
  "]": [0x00, 0x41, 0x41, 0x7f, 0x00],
  "_": [0x40, 0x40, 0x40, 0x40, 0x40],
  "|": [0x00, 0x00, 0x77, 0x00, 0x00],
};

/** Raster RGB sederhana (tanpa alpha). */
class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;

  constructor(width: number, height: number, bg: Rgb) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 3] = bg[0];
      this.data[i * 3 + 1] = bg[1];
      this.data[i * 3 + 2] = bg[2];
    }
  }

  setPixel(x: number, y: number, c: Rgb): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const o = (py * this.width + px) * 3;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    const ax = Math.max(0, Math.round(Math.min(x0, x1)));
    const bx = Math.min(this.width - 1, Math.round(Math.max(x0, x1)));
    const ay = Math.max(0, Math.round(Math.min(y0, y1)));
    const by = Math.min(this.height - 1, Math.round(Math.max(y0, y1)));
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) this.setPixel(x, y, c);
  }

  vLine(x: number, y0: number, y1: number, c: Rgb): void {
    const a = Math.round(Math.min(y0, y1));
    const b = Math.round(Math.max(y0, y1));
    for (let y = a; y <= b; y++) this.setPixel(x, y, c);
  }

  hLine(y: number, x0: number, x1: number, c: Rgb): void {
    const a = Math.round(Math.min(x0, x1));
    const b = Math.round(Math.max(x0, x1));
    for (let x = a; x <= b; x++) this.setPixel(x, y, c);
  }

  dashedHLine(y: number, x0: number, x1: number, c: Rgb, on = 5, off = 5): void {
    const a = Math.round(Math.min(x0, x1));
    const b = Math.round(Math.max(x0, x1));
    let i = 0;
    for (let x = a; x <= b; x++, i++) {
      if (i % (on + off) < on) this.setPixel(x, y, c);
    }
  }

  /** Teks 5x7; mengembalikan lebar piksel teks yang digambar. */
  text(x: number, y: number, s: string, c: Rgb, scale = 1): number {
    let cx = x;
    for (const raw of s.toUpperCase()) {
      const glyph = FONT5X7[raw] ?? FONT5X7["?"]!;
      for (let col = 0; col < 5; col++) {
        const bits = glyph[col]!;
        for (let row = 0; row < 7; row++) {
          if ((bits & (1 << row)) === 0) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) this.setPixel(cx + col * scale + dx, y + row * scale + dy, c);
          }
        }
      }
      cx += 6 * scale;
    }
    return cx - x;
  }
}

function textWidth(s: string, scale = 1): number {
  return s.length * 6 * scale;
}

/** Format harga ringkas (bukan-notasi scientific) untuk label sumbu. */
function formatPrice(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(4);
  if (abs >= 0.0001) return v.toFixed(6);
  return v.toPrecision(4);
}

function isValidBar(b: DrexChartBar): boolean {
  return Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low)
    && Number.isFinite(b.close) && b.close > 0 && b.high >= b.low && b.high > 0 && b.low > 0;
}

/** ── PNG encoder (RGB truecolor, 8 bit) ──────────────────────────────────── */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) throw new Error("DREX_CHART_BAD_RASTER");
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render chart candles + garis close menjadi PNG.
 * Melempar error bila bar tidak valid (< 2 bar) — caller wajib fail-closed.
 */
export function renderChartPng(bars: DrexChartBar[], opts: DrexChartOptions): Buffer {
  const width = Math.max(320, Math.round(opts.width ?? 720));
  const height = Math.max(200, Math.round(opts.height ?? 400));
  const maxBars = Math.max(10, Math.min(Math.round(opts.maxBars ?? 120), bars.length));
  const series = bars.slice(-maxBars).filter(isValidBar);
  if (series.length < 2) throw new Error("DREX_CHART_BARS_INSUFFICIENT");

  let minP = Infinity;
  let maxP = -Infinity;
  for (const b of series) {
    if (b.low < minP) minP = b.low;
    if (b.high > maxP) maxP = b.high;
  }
  if (!(maxP > minP)) {
    // Range nol (price flat) -> bagi agar tidak division by zero.
    minP = minP * 0.999;
    maxP = maxP * 1.001;
  }
  // Level plan ikut diperhitungkan ke rentang harga, tapi DIBATASI 25% dari
  // rentang candle: level liar (mis. TP jauh) tidak boleh memipihkan chart.
  const levels = opts.levels ?? null;
  const rawRange = maxP - minP;
  for (const lv of [levels?.entry, levels?.sl, levels?.tp]) {
    if (lv == null || !Number.isFinite(lv) || lv <= 0) continue;
    if (lv < minP - rawRange * 0.25 || lv > maxP + rawRange * 0.25) continue;
    if (lv < minP) minP = lv;
    if (lv > maxP) maxP = lv;
  }
  const pad = (maxP - minP) * 0.06;
  minP -= pad;
  maxP += pad;

  const plotLeft = MARGIN_LEFT;
  const plotRight = width - MARGIN_RIGHT;
  const plotTop = MARGIN_TOP;
  const plotBottom = height - MARGIN_BOTTOM;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;
  if (plotW <= 10 || plotH <= 10) throw new Error("DREX_CHART_BAD_CANVAS");

  const raster = new Raster(width, height, BG);
  const yOf = (price: number): number => plotBottom - ((price - minP) / (maxP - minP)) * plotH;

  // Grid harga + label sumbu kanan.
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const price = minP + ((maxP - minP) * i) / gridLines;
    const y = yOf(price);
    raster.hLine(y, plotLeft, plotRight, GRID);
    const label = formatPrice(price);
    raster.text(width - MARGIN_RIGHT + 5, Math.round(y) - 3, label, GRID_TEXT, 1);
  }

  // Level plan (entry/SL/TP) — hanya digambar bila berada di dalam rentang harga.
  const drawLevel = (price: number | null | undefined, color: Rgb, tag: string): void => {
    if (price == null || !Number.isFinite(price) || price <= 0) return;
    if (price < minP || price > maxP) return;
    const y = yOf(price);
    raster.dashedHLine(y, plotLeft, plotRight, color);
    raster.text(plotLeft + 2, Math.round(y) - 9, `${tag} ${formatPrice(price)}`, color, 1);
  };
  drawLevel(levels?.entry, LEVEL_ENTRY, "E");
  drawLevel(levels?.sl, LEVEL_SL, "SL");
  drawLevel(levels?.tp, LEVEL_TP, "TP");

  // Lilin OHLC.
  const barW = plotW / series.length;
  const bodyW = Math.max(1, Math.round(barW * 0.62));
  series.forEach((b, i) => {
    const cx = plotLeft + i * barW + barW / 2;
    const yHigh = yOf(b.high);
    const yLow = yOf(b.low);
    const yOpen = yOf(b.open);
    const yClose = yOf(b.close);
    const up = b.close >= b.open;
    const color = up ? UP : DOWN;
    raster.vLine(cx, yHigh, yLow, color);
    const top = Math.min(yOpen, yClose);
    const bottom = Math.max(yOpen, yClose);
    raster.fillRect(cx - bodyW / 2, top, cx + bodyW / 2, Math.max(bottom, top + 1), color);
  });

  // Garis close.
  series.forEach((b, i) => {
    if (i === 0) return;
    const x0 = plotLeft + (i - 1) * barW + barW / 2;
    const x1 = plotLeft + i * barW + barW / 2;
    const y0 = yOf(series[i - 1]!.close);
    const y1 = yOf(b.close);
    const steps = Math.max(1, Math.round(Math.abs(x1 - x0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      raster.setPixel(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, CLOSE_LINE);
    }
  });

  // Judul + baris bawah (harga terakhir & perubahan).
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const changePct = ((last.close - first.open) / first.open) * 100;
  raster.text(MARGIN_LEFT, 4, `${opts.symbol} ${opts.timeframe} ${series.length} BARS`, TITLE_TEXT, 1);
  const sign = changePct >= 0 ? "+" : "";
  raster.text(
    MARGIN_LEFT,
    height - MARGIN_BOTTOM + 4,
    `LAST ${formatPrice(last.close)}  ${sign}${changePct.toFixed(2)}%`,
    changePct >= 0 ? UP : DOWN,
    1,
  );

  return encodePng(width, height, raster.data);
}

/** Render chart PNG -> string base64 (format `images` milik Drex). */
export function renderChartBase64(bars: DrexChartBar[], opts: DrexChartOptions): string {
  return renderChartPng(bars, opts).toString("base64");
}

// ── Cache render per (symbol, timeframe, lastBarTime) ────────────────────────
// Render chart tidak boleh on-demand di jalur request (latensi Drex 4000ms),
// jadi hasil render disimpan dan dipakai ulang selama bar terakhir sama.

export interface DrexChartCacheStats {
  size: number;
  hits: number;
  misses: number;
}

interface CacheEntry {
  base64: string;
  createdAt: number;
  bytes: number;
}

const chartCache = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;

/** Kunci cache: simbol + timeframe + waktu bar terakhir (isi cache berubah saat bar baru). */
export function drexChartCacheKey(symbol: string, timeframe: string, lastBarTime: number): string {
  return `${symbol.toUpperCase()}|${timeframe}|${lastBarTime}`;
}

/** Batas entri cache render (menggantikan entri terlama saat penuh). */
export const DREX_CHART_CACHE_MAX_ENTRIES = 64;

export const drexChartCache = {
  get(key: string): string | null {
    const entry = chartCache.get(key);
    if (!entry) {
      misses += 1;
      return null;
    }
    hits += 1;
    return entry.base64;
  },
  set(key: string, base64: string, now = Date.now(), maxEntries = DREX_CHART_CACHE_MAX_ENTRIES): void {
    // Refresh posisi entri (Map mempertahankan urutan insert).
    if (chartCache.has(key)) chartCache.delete(key);
    while (chartCache.size >= maxEntries) {
      const oldest = chartCache.keys().next();
      if (oldest.done) break;
      chartCache.delete(oldest.value);
    }
    chartCache.set(key, { base64, createdAt: now, bytes: base64.length });
  },
  stats(): DrexChartCacheStats {
    return { size: chartCache.size, hits, misses };
  },
  reset(): void {
    chartCache.clear();
    hits = 0;
    misses = 0;
  },
};
