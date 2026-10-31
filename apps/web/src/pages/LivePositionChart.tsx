// apps/web/src/pages/LivePositionChart.tsx — chart untuk melihat posisi trade
// live (27 Okt 2026, permintaan operator: "buat ada chart nya juga untuk
// melihat posisi trade nya").
//
// Memakai NativeQuantChart yang sudah ada (klines Binance live + overlay
// entry/SL/TP). READ-ONLY: chart hanya membaca, tidak pernah mengirim order.
//
// Posisi yang ditampilkan = posisi LANE LIVE (source LIVE_*): baris DB plus
// posisi exchange-only (ada di exchange tapi belum ada baris DB, level SL/TP
// dari algo order).
import { useEffect, useRef, useState } from "react";
import { colors, fonts } from "../theme.js";
import { Panel, Badge } from "../components/ui.js";
import { TradingChartPanel, type ChartPanelConfig, type ChartPosition } from "../components/TradingChartPanel.js";
import { num, usd, pnlColor, age } from "./liveShared.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h"] as const;

/**
 * Posisi yang bisa di-chart. Dua sumber:
 * - baris DB (lane LIVE) — semua field terisi;
 * - exchange-only (ada di exchange, belum ada baris DB) — openedAt/margin/
 *   strategy tidak diketahui, level SL/TP dari algo order di exchange.
 */
export interface ChartPos {
  key: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  slPrice: number | null;
  tp1Price: number | null;
  tp2Price: number | null;
  marginUsd: number | null;
  leverage: number | null;
  unrealizedPnlUsd: number | null;
  strategyId: string | null;
  source: string;
  openedAt: string | null;
}

export function LivePositionChart({ positions, focusSymbol }: { positions: ChartPos[]; focusSymbol?: string | null }) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<string>("15m");
  // Spec tahap 6: panel awal = simbol posisi pertama (bukan BTCUSDT).
  const [panel, setPanel] = useState<ChartPanelConfig>(() => ({
    id: "live-position",
    symbol: positions[0]?.symbol ?? "BTCUSDT",
    interval: "15m",
    indicators: { volume: true, volumeSma20: true, rvol20: false, ema20: true, ema50: false, rsi14: false, atr14: false, emaFast: 20, emaSlow: 50, rsiPeriod: 14, atrPeriod: 14, volumeSmaPeriod: 20 },
  }));
  const selectedRef = useRef<ChartPos | null>(null);

  // Symbol default = posisi live pertama yang ada.
  useEffect(() => {
    if (positions.length === 0) {
      setSymbol(null);
      selectedRef.current = null;
      return;
    }
    const retained = symbol ? positions.find((p) => p.symbol === symbol) : undefined;
    const next = retained ?? positions[0]!;
    selectedRef.current = next;
    if (symbol !== next.symbol) setSymbol(next.symbol);
  }, [positions, symbol]);

  // Klik baris tabel posisi → pilih simbol di chart (read-only, tanpa request).
  useEffect(() => {
    if (!focusSymbol) return;
    if (positions.some((p) => p.symbol === focusSymbol)) setSymbol(focusSymbol);
  }, [focusSymbol, positions]);

  useEffect(() => {
    if (!selectedRef.current) return;
    setPanel((prev) => ({ ...prev, symbol: selectedRef.current!.symbol, interval: timeframe }));
  }, [timeframe]);

  useEffect(() => {
    if (!symbol) return;
    setPanel((prev) => ({ ...prev, symbol, interval: timeframe }));
  }, [symbol, timeframe]);

  const selected = positions.find((p) => p.symbol === symbol) ?? null;

  if (positions.length === 0) {
    return (
      <Panel title="CHART POSISI LIVE · klines Binance + level entry/SL/TP">
        <div style={{ padding: "18px 2px", color: colors.textMuted, fontSize: 12 }}>
          Tidak ada posisi live terbuka untuk di-chart. Chart muncul otomatis
          saat bot membuka posisi di exchange.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="CHART POSISI LIVE · klines Binance + level entry/SL/TP"
      extra={
        selected ? (
          <Badge bg={colors.accentSoft} fg={colors.accent}>
            {selected.symbol} {selected.side} • {selected.openedAt ? `${age(selected.openedAt)} lalu` : "tanpa jejak DB"}
          </Badge>
        ) : undefined
      }
      bodyStyle={{ padding: 0 }}
    >
      {/* Kontrol: pilih posisi + timeframe */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "10px 12px", borderBottom: `1px solid ${colors.border}` }}>
        <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono, letterSpacing: "0.08em" }}>POSISI</span>
        {positions.map((p) => (
          <button
            key={p.key}
            onClick={() => setSymbol(p.symbol)}
            title={`${p.side} ${p.symbol} · entry ${p.entryPrice}`}
            style={{
              appearance: "none", cursor: "pointer",
              background: symbol === p.symbol ? colors.accent : "transparent",
              color: symbol === p.symbol ? "#07110d" : colors.textMuted,
              border: `1px solid ${symbol === p.symbol ? colors.accent : colors.border}`,
              borderRadius: 3, fontSize: 10, fontWeight: 700, padding: "4px 7px",
              fontFamily: fonts.mono,
            }}
          >
            {p.symbol}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono, letterSpacing: "0.08em" }}>TF</span>
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            style={{
              appearance: "none", cursor: "pointer",
              background: timeframe === tf ? colors.accent : "transparent",
              color: timeframe === tf ? "#07110d" : colors.textMuted,
              border: `1px solid ${timeframe === tf ? colors.accent : colors.border}`,
              borderRadius: 3, fontSize: 10, fontWeight: 700, padding: "4px 7px",
              fontFamily: fonts.mono,
            }}
          >
            {tf}
          </button>
        ))}
      </div>

      {/* Chart */}
      {selected && (
        <div style={{ padding: 12 }}>
          <TradingChartPanel
            panel={panel}
            active
            positions={[{
              id: Number(selected.key.replace(/\D/g, "")) || 0,
              symbol: selected.symbol,
              side: selected.side === "SHORT" ? "SHORT" : "LONG",
              mode: "LIVE",
              entryPrice: selected.entryPrice,
              slPrice: selected.slPrice,
              tp1Price: selected.tp1Price,
              tp2Price: selected.tp2Price,
              qty: selected.qty,
              marginUsd: selected.marginUsd ?? undefined,
              leverage: selected.leverage ?? undefined,
              source: selected.source,
              strategyId: selected.strategyId ?? undefined,
              openedAt: selected.openedAt ?? undefined,
              pnlUsd: selected.unrealizedPnlUsd,
            } satisfies ChartPosition]}
            onSelect={() => {}}
            onChange={(patch) => {
              setPanel((prev) => ({ ...prev, ...patch }));
              if (patch.symbol) setSymbol(patch.symbol);
              if (patch.interval) setTimeframe(patch.interval);
            }}
          />
        </div>
      )}

      {/* Level posisi terpilih */}
      {selected && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "10px 12px", borderTop: `1px solid ${colors.border}`, fontSize: 11 }}>
          <Level label="ENTRY" value={num(selected.entryPrice, 6)} />
          <Level label="SL" value={num(selected.slPrice, 6)} color={colors.down} />
          <Level label="TP1" value={num(selected.tp1Price, 6)} color={colors.up} />
          {selected.tp2Price != null && (
            <Level label="TP2" value={num(selected.tp2Price, 6)} color={colors.up} />
          )}
          <Level label="QTY" value={num(selected.qty, 4)} />
          <Level label="MARGIN" value={usd(selected.marginUsd)} />
          <Level label="LEVERAGE" value={selected.leverage != null ? `${selected.leverage}x` : "·"} />
          <Level
            label="UNREALIZED"
            value={selected.unrealizedPnlUsd == null ? "·" : usd(selected.unrealizedPnlUsd)}
            color={pnlColor(selected.unrealizedPnlUsd)}
          />
          <Level label="STRATEGI" value={selected.strategyId ?? "·"} />
          <Level label="SOURCE" value={selected.source} />
        </div>
      )}
    </Panel>
  );
}

function Level({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{ display: "flex", gap: 5, alignItems: "baseline" }}>
      <span style={{ fontSize: 9.5, color: colors.textMuted, fontWeight: 700, letterSpacing: "0.1em" }}>{label}</span>
      <span style={{ fontSize: 11.5, color: color ?? colors.text, fontFamily: fonts.mono, fontWeight: 600 }}>{value}</span>
    </span>
  );
}
