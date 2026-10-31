// apps/server/src/lab/pineParser.ts — Parser Pine -> LabSpec (CP-9, T-29).
// PARSER TERBATAS: hanya pola yang dikenali; sisanya dilaporkan sebagai unmapped
// (tidak pernah mengarang logika). Gap -> "perlu adapter" (T-31).
import type { LabSpec, LabCondition, LabOperand, LabExitSpec, LabInterval } from "./labTypes.js";

export interface PineParseResult {
  ok: boolean;
  spec: Partial<LabSpec>;
  mapped: string[];
  unmapped: string[];
  notes: string[];
}

const TF_MAP: Record<string, LabInterval> = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", "D": "1d",
};

function operandFromText(x: string): LabOperand | null {
  const s = x.trim();
  let m = s.match(/^ta\.rsi\(\s*close\s*,\s*(\d+)\s*\)/i) || s.match(/^rsi\(\s*close\s*,\s*(\d+)\s*\)/i);
  if (m) return { kind: "INDICATOR", indicator: "RSI", period: +m[1], source: "close" };
  m = s.match(/^ta\.ema\(\s*close\s*,\s*(\d+)\s*\)/i) || s.match(/^ema\(\s*close\s*,\s*(\d+)\s*\)/i);
  if (m) return { kind: "INDICATOR", indicator: "EMA", period: +m[1], source: "close" };
  m = s.match(/^ta\.sma\(\s*close\s*,\s*(\d+)\s*\)/i) || s.match(/^sma\(\s*close\s*,\s*(\d+)\s*\)/i);
  if (m) return { kind: "INDICATOR", indicator: "SMA", period: +m[1], source: "close" };
  m = s.match(/^ta\.atr\(\s*(\d+)\s*\)/i) || s.match(/^atr\(\s*(\d+)\s*\)/i);
  if (m) return { kind: "INDICATOR", indicator: "ATR", period: +m[1] };
  if (/^close$/i.test(s)) return { kind: "INDICATOR", indicator: "PRICE", source: "close" };
  if (/^open$/i.test(s)) return { kind: "INDICATOR", indicator: "PRICE", source: "open" };
  if (/^high$/i.test(s)) return { kind: "INDICATOR", indicator: "PRICE", source: "high" };
  if (/^low$/i.test(s)) return { kind: "INDICATOR", indicator: "PRICE", source: "low" };
  if (/^volume$/i.test(s)) return { kind: "INDICATOR", indicator: "VOLUME" };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: "VALUE", value: parseFloat(s) };
  return null;
}

/** Ekstrak entry condition dari klausa if/and yang dikenali. */
function parseCondition(line: string): LabCondition | null {
  // ta.crossover(A, B) -> CROSS_ABOVE
  let m = line.match(/ta\.crossover\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/i);
  if (m) {
    const l = operandFromText(m[1]), r = operandFromText(m[2]);
    if (l && r) return { left: l, op: "CROSS_ABOVE", right: r };
  }
  m = line.match(/ta\.crossunder\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/i);
  if (m) {
    const l = operandFromText(m[1]), r = operandFromText(m[2]);
    if (l && r) return { left: l, op: "CROSS_BELOW", right: r };
  }
  // A > B  (hindari <=, >=, ==, !=)
  m = line.match(/(ta\.[a-z]+\([^)]*\)|close|open|high|low|volume)\s*(>|<)\s*(ta\.[a-z]+\([^)]*\)|close|open|high|low|volume|-?\d+(?:\.\d+)?)/i);
  if (m) {
    const l = operandFromText(m[1]), r = operandFromText(m[3]);
    if (l && r) return { left: l, op: m[2] === ">" ? "GT" : "LT", right: r };
  }
  return null;
}

function parseExit(line: string): { sl?: LabExitSpec; tp?: LabExitSpec } {
  const out: { sl?: LabExitSpec; tp?: LabExitSpec } = {};
  // strategy.exit(..., stop = X, limit = Y) atau syarat harga eksplisit
  let m = line.match(/stop\s*=\s*([^\s,)]+)/i);
  if (m) {
    const v = /^\d+(?:\.\d+)?$/.test(m[1]) ? Number(m[1]) : NaN;
    if (Number.isFinite(v) && v > 0) out.sl = { kind: "PRICE", value: v };
  }
  m = line.match(/limit\s*=\s*([^\s,)]+)/i);
  if (m) {
    const v = /^\d+(?:\.\d+)?$/.test(m[1]) ? Number(m[1]) : NaN;
    if (Number.isFinite(v) && v > 0) out.tp = { kind: "PRICE", value: v };
  }
  // pola risk 1:x
  m = line.match(/riskReward\s*=\s*(\d+(?:\.\d+)?)/i) || line.match(/rr\s*=\s*(\d+(?:\.\d+)?)/i);
  if (m) out.tp = { kind: "R_MULT", value: parseFloat(m[1]) };
  return out;
}

/**
 * Parse sumber Pine -> spec parsial. Prinsip: hanya pola yang dikenali dipetakan;
 * SISANYA jujur masuk `unmapped` — tidak pernah mengarang logika yang tidak dibaca.
 */
export function parsePineSource(src: string, meta?: { symbol?: string; interval?: string; name?: string; tvUrl?: string }): PineParseResult {
  const mapped: string[] = [];
  const unmapped: string[] = [];
  const notes: string[] = [];
  const lines = src.split(/\r?\n/);
  const entryConditions: LabCondition[] = [];
  let sl: LabExitSpec | undefined;
  let tp: LabExitSpec | undefined;
  let direction: LabSpec["direction"] = "LONG";
  let hasShort = false, hasLong = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("//@")) continue;
    const low = line.toLowerCase();

    // timeframe
    const tfm = line.match(/timeframe\s*=\s*\"([^\"]+)\"/i) || line.match(/chart\.interval/i);
    if (tfm && TF_MAP[tfm[1]]) mapped.push(`timeframe ${tfm[1]}`);

    // entry
    if (/strategy\.entry|strategy\.order/i.test(line)) {
      if (/strategy\.long|long/i.test(line)) hasLong = true;
      if (/strategy\.short|short/i.test(line)) hasShort = true;
      mapped.push(line.slice(0, 80));
    }
    const cond = parseCondition(line);
    if (cond) { entryConditions.push(cond); mapped.push(line.slice(0, 80)); }
    else if (/\bif\b|crossover|crossunder|ta\.|strategy\./i.test(low) && !/^\s*(indicator|strategy)\(/i.test(line)) {
      // baris logika yang tidak dikenali -> unmapped (jujur)
      if (/strategy\.exit|stop|limit|riskReward/i.test(line)) {
        const ex = parseExit(line);
        if (ex.sl) { sl = ex.sl; mapped.push(line.slice(0, 80)); }
        if (ex.tp) { tp = ex.tp; mapped.push(line.slice(0, 80)); }
        if (!ex.sl && !ex.tp) unmapped.push(line.slice(0, 100));
      } else if (!/^(plot|bgcolor|fill|label|table|var|float|int|string|bool|indicator\(|strategy\(|\/\/@|input\.)/i.test(line)) {
        unmapped.push(line.slice(0, 100));
      }
    }
  }

  direction = hasShort && hasLong ? "BOTH" : hasShort ? "SHORT" : "LONG";
  if (!sl) { sl = { kind: "PCT", value: 1 }; notes.push("SL tidak dikenali dari Pine -> default 1% (ubah manual bila perlu)."); }
  if (!tp) { tp = { kind: "R_MULT", value: 1.5 }; notes.push("TP tidak dikenali dari Pine -> default 1.5R (ubah manual bila perlu)."); }
  if (entryConditions.length === 0) notes.push("Tidak ada kondisi entry yang dikenali — bangun manual di builder.");

  const spec: Partial<LabSpec> = {
    name: meta?.name ?? "Pine import",
    symbol: meta?.symbol ?? "BTCUSDT",
    interval: (meta?.interval as LabInterval) ?? "5m",
    direction,
    entryConditions,
    sl, tp,
    source: meta?.tvUrl ? "PINE_LINK" : "PINE_IMPORT",
    pineSource: src.slice(0, 20000),
    tvUrl: meta?.tvUrl,
  };
  return { ok: entryConditions.length > 0, spec, mapped, unmapped, notes };
}
