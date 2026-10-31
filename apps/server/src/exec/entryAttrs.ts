// T-01 (4 Okt 2026) — pencatatan atribut trigger & kondisi market saat entry.
// Murni observabilitas (rekomendasi FAS C, disetujui operator): TIDAK ada keputusan
// trading yang membaca kolom ini. Dipakai oleh tools/analyze-entry-attrs.ts untuk
// analisis bucket (WR / avgR per atribut). Output analisis selalu R & %, bukan nominal.

/** Bar minimal yang cukup untuk menghitung rasio volume dan rezim ATR. */
export const ATTRS_MIN_BARS = 65;

export interface AttrBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface EntryAttrs {
  /** Versi format snapshot. */
  v: number;
  strategyId: string | null;
  side: string | null;
  quality: number | null;
  sweepDepthAtr: number | null;
  displacementAtr: number | null;
  /** Label sesi saat sweep (metadata historis) — TIDAK dipakai sebagai filter jam. */
  killzone: string | null;
  biasAligned: boolean | null;
  /** vol bar entry / rata-rata vol 20 bar sebelumnya. */
  volumeRatio: number | null;
  /** ATR(14) bar entry / rata-rata ATR(14) 50 bar sebelumnya. */
  atrRegime: number | null;
  /** Tag alasan plan saat entry (audit). */
  reasons: string[];
  recordedAt: string;
}

export interface BuildAttrsInput {
  strategyId?: string | null;
  side?: string | null;
  quality?: number | null;
  biasAligned?: boolean | null;
  reasons?: readonly string[] | null;
  bars?: readonly AttrBar[] | null;
  now?: Date;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Nilai atribut trigger sudah ter-encode di tag alasan plan (format deterministik). */
export function extractReasonAttrs(reasons: readonly string[]): {
  sweepDepthAtr: number | null;
  displacementAtr: number | null;
  killzone: string | null;
} {
  let sweepDepthAtr: number | null = null;
  let displacementAtr: number | null = null;
  let killzone: string | null = null;
  for (const tag of reasons) {
    const depth = /^SWEEP_DEPTH_ATR_([0-9.]+)$/.exec(tag);
    if (depth) sweepDepthAtr = Number(depth[1]);
    const disp = /^RECLAIM_DISPLACEMENT_ATR_([0-9.]+)$/.exec(tag);
    if (disp) displacementAtr = Number(disp[1]);
    const kz = /^KILLZONE_(.+)$/.exec(tag);
    if (kz && kz[1] !== "ABSENT") killzone = kz[1]!;
  }
  return { sweepDepthAtr, displacementAtr, killzone };
}

/** vol bar terakhir dibagi rata-rata vol 20 bar sebelumnya. */
export function computeVolumeRatio(bars: readonly AttrBar[]): number | null {
  if (bars.length < 21) return null;
  const prev = bars.slice(-21, -1).map((b) => b.volume);
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const last = bars[bars.length - 1]!.volume;
  return avg > 0 && Number.isFinite(last) ? Number((last / avg).toFixed(4)) : null;
}

/** ATR(14) sederhana bar terakhir dibagi baseline ATR 50 bar sebelumnya. */
export function computeAtrRegime(bars: readonly AttrBar[]): number | null {
  if (bars.length < ATTRS_MIN_BARS) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const recent = avg(trs.slice(-14));
  const base = avg(trs.slice(-64, -14));
  return base > 0 && Number.isFinite(recent) ? Number((recent / base).toFixed(4)) : null;
}

/** Susun JSON snapshot; tidak pernah melempar (kegagalan hitung = null). */
export function buildEntryAttrs(input: BuildAttrsInput): string {
  const reasons = (input.reasons ?? []).map((r) => String(r)).slice(0, 40);
  const fromReasons = extractReasonAttrs(reasons);
  const bars = input.bars ?? [];
  const attrs: EntryAttrs = {
    v: 1,
    strategyId: input.strategyId ?? null,
    side: input.side ?? null,
    quality: num(input.quality),
    sweepDepthAtr: fromReasons.sweepDepthAtr,
    displacementAtr: fromReasons.displacementAtr,
    killzone: fromReasons.killzone,
    biasAligned: typeof input.biasAligned === "boolean" ? input.biasAligned : null,
    volumeRatio: bars.length >= 21 ? safeRatio(() => computeVolumeRatio(bars)) : null,
    atrRegime: bars.length >= ATTRS_MIN_BARS ? safeRatio(() => computeAtrRegime(bars)) : null,
    reasons,
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
  return JSON.stringify(attrs);
}

function safeRatio(fn: () => number | null): number | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Baca kembali snapshot; null untuk data lama / JSON rusak (defensif, tanpa lempar). */
export function parseEntryAttrs(raw: unknown): EntryAttrs | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const obj = JSON.parse(raw) as Partial<EntryAttrs>;
    if (!obj || typeof obj !== "object" || obj.v !== 1) return null;
    return {
      v: 1,
      strategyId: typeof obj.strategyId === "string" ? obj.strategyId : null,
      side: typeof obj.side === "string" ? obj.side : null,
      quality: num(obj.quality),
      sweepDepthAtr: num(obj.sweepDepthAtr),
      displacementAtr: num(obj.displacementAtr),
      killzone: typeof obj.killzone === "string" ? obj.killzone : null,
      biasAligned: typeof obj.biasAligned === "boolean" ? obj.biasAligned : null,
      volumeRatio: num(obj.volumeRatio),
      atrRegime: num(obj.atrRegime),
      reasons: Array.isArray(obj.reasons) ? obj.reasons.map((r) => String(r)).slice(0, 40) : [],
      recordedAt: typeof obj.recordedAt === "string" ? obj.recordedAt : "",
    };
  } catch {
    return null;
  }
}
