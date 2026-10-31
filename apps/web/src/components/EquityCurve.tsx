// apps/web/src/components/EquityCurve.tsx — kurva equity lane (LIVE / PAPER).
// Murni presentasi: titik dihitung dari trade tertutup (pnlUsd sudah NET).
// Tidak ada data karangan — jika trade kosong, kurva hanya menampilkan modal awal.
import { useMemo } from "react";
import { colors, fonts } from "../theme.js";
import { smoothLinePath, smoothAreaPath } from "../lib/smoothPath.js";

export interface EquityTradePoint {
  createdAt: string;
  pnlUsd: number;
}

const W = 720;
const PAD_X = 8;
const PAD_Y = 14;
const GRID_LINES = 4;

export function EquityCurve({
  startEquity,
  trades,
  currentEquity,
  color = colors.up,
  height = 180,
}: {
  startEquity: number;
  trades: EquityTradePoint[];
  currentEquity: number | null;
  color?: string;
  height?: number;
}) {
  const series = useMemo(() => {
    const ordered = [...trades].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const values: number[] = [startEquity];
    let run = startEquity;
    for (const t of ordered) {
      run = Number((run + t.pnlUsd).toFixed(4));
      values.push(run);
    }
    if (currentEquity != null && Number.isFinite(currentEquity)) values.push(currentEquity);
    return values;
  }, [trades, startEquity, currentEquity]);

  const H = height;
  const min = Math.min(...series, startEquity);
  const max = Math.max(...series, startEquity);
  const span = max - min || Math.max(1, Math.abs(max) * 0.01);
  const lo = min - span * 0.08;
  const hi = max + span * 0.08;
  const yOf = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (H - PAD_Y * 2);
  const xStep = series.length > 1 ? (W - PAD_X * 2) / (series.length - 1) : 0;
  const pts: Array<[number, number]> = series.map((v, i) => [PAD_X + i * xStep, yOf(v)]);
  const baseY = H - PAD_Y;
  const linePath = smoothLinePath(pts);
  const areaPath = smoothAreaPath(pts, baseY);
  const last = series[series.length - 1];
  const delta = last - startEquity;
  const deltaColor = delta > 0 ? colors.up : delta < 0 ? colors.down : colors.textMuted;
  const gradientId = useMemo(() => `eq-${Math.random().toString(36).slice(2, 8)}`, []);

  const gridValues = Array.from({ length: GRID_LINES + 1 }, (_, i) => hi - ((hi - lo) * i) / GRID_LINES);
  const lastPt = pts[pts.length - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "baseline", fontFamily: fonts.mono, fontSize: 13 }}>
        <span style={{ color: colors.textMuted, letterSpacing: "0.08em" }}>EQUITY</span>
        <span style={{ color: colors.text, fontWeight: 700, fontSize: 16 }}>${last.toFixed(2)}</span>
        <span style={{ color: deltaColor, fontWeight: 600 }}>
          {delta >= 0 ? "+" : ""}{delta.toFixed(2)} vs modal awal ${startEquity.toFixed(2)}
        </span>
        <span style={{ color: colors.textMuted, marginLeft: "auto" }}>{trades.length} trade tertutup</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px", gap: 6, alignItems: "stretch" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Kurva equity: ${last.toFixed(2)} USD dari modal awal ${startEquity.toFixed(2)} USD`}
          style={{ display: "block", background: colors.bg, borderRadius: 2, border: `1px solid ${colors.border}` }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridValues.map((v, i) => (
            <line key={i} x1={0} x2={W} y1={yOf(v)} y2={yOf(v)} stroke={colors.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`v${i}`} x1={(W * i) / 8} x2={(W * i) / 8} y1={0} y2={H} stroke={colors.border} strokeWidth={1} strokeDasharray="2 6" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={0} x2={W} y1={yOf(startEquity)} y2={yOf(startEquity)} stroke={colors.textMuted} strokeWidth={1} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          <path d={areaPath} fill={`url(#${gradientId})`} />
          <path d={linePath} fill="none" stroke={color} strokeWidth={2.25} vectorEffect="non-scaling-stroke" />
          <circle cx={lastPt[0]} cy={lastPt[1]} r={4} fill={color} stroke={colors.bg} strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, textAlign: "right", padding: "2px 0" }}>
          {gridValues.map((v, i) => <span key={i}>{v.toFixed(2)}</span>)}
        </div>
      </div>
    </div>
  );
}
