// Market overview — dense monitor surface for the operator console.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type UTCTimestamp } from "lightweight-charts";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, fmtPct, pctColor } from "../theme.js";
import { Panel, Badge, Delta, StatCell, EmptyState } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { AlertFeedPanel } from "../components/AlertFeedPanel.js";
import { binanceWs, type LiveTicker } from "../lib/binanceWs.js";
import { subscribeKlineStream, type StreamCandle } from "../lib/klineStream.js";
import { LastPriceTag } from "../components/LastPriceTag.js";

const WATCH = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT"] as const;
const TIMEFRAMES = [{ label: "15m", interval: "15m" }, { label: "1h", interval: "1h" }, { label: "4h", interval: "4h" }, { label: "1D", interval: "1d" }] as const;

interface Overview {
  equity?: { currentUsd?: number; dailyPnlUsd?: number; cumulativePnlUsd?: number; drawdownUsd?: number };
  floating?: { totalPnlUsd?: number; positions?: Array<{ id: number; symbol: string; pnlUsd: number }> };
  positions?: Array<{ id: number; symbol: string; side: string; mode: string; entryPrice: number; slPrice: number; tp1Price: number; leverage?: number; qty?: number }>;
}
/** Ringkas /api/live/dashboard — satu-satunya sumber angka akun di halaman ini. */
interface LiveDash {
  executionMode?: string;
  armed?: boolean;
  guardReasons?: string[];
  exchangeBalanceUsd?: number | null;
  live?: {
    equityUsd?: number;
    netPnlUsd?: number;
    unrealizedPnlUsd?: number;
    openPositions?: number;
    positions?: Array<{
      id: number; symbol: string; side: string; mode: string; qty: number;
      entryPrice: number; slPrice: number; tp1Price: number; unrealizedPnlUsd: number | null;
    }>;
  };
}
interface Mover { symbol: string; price: number; chg24hPct: number; volume24hUsd?: number }

function MarketChart({ symbol, interval }: { symbol: string; interval: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // 28 Okt 2026: penjaga urutan waktu series — harus bertahan antar-efek
  // (ganti simbol/timeframe) karena series chart TIDAK di-reset saat ganti.
  const lastTimeRef = useRef(0);
  // 30 Okt 2026: label harga + countdown di sumbu kanan (ala Binance).
  const priceRef = useRef<number | null>(null);
  const closeTimeRef = useRef<number | null>(null);
  const [chartH, setChartH] = useState(410);
  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    // 29 Okt 2026 (tahap 3 Tema B) — warna chart dari token tema B: grid #161727,
    // teks skala #5C6890, latar #080A17 (brief bagian 4). autoSize: false +
    // ResizeObserver manual: lightweight-charts v5 dengan autoSize aktif memasang
    // ResizeObserver internal yang bisa fires SETELAH chart.remove() saat unmount
    // → "Object is disposed" (fix yang sama dengan TradingChartPanel, e408125).
    const chart = createChart(el, {
      layout: { background: { color: colors.bgPanel }, textColor: colors.textDim, fontSize: 10 },
      grid: { vertLines: { color: colors.border }, horzLines: { color: colors.border } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      autoSize: false,
      width: Math.max(1, el.clientWidth),
      height: Math.max(1, el.clientHeight),
    });
    const ro = new ResizeObserver(() => {
      try { chart.applyOptions({ width: Math.max(1, el.clientWidth), height: Math.max(1, el.clientHeight) }); } catch { /* chart sudah di-dispose */ }
      setChartH(Math.max(1, el.clientHeight));
    });
    ro.observe(el);
    setChartH(Math.max(1, el.clientHeight));
    const series = chart.addSeries(CandlestickSeries, { upColor: colors.up, downColor: colors.down, borderVisible: false, wickUpColor: colors.up, wickDownColor: colors.down });
    chartRef.current = chart; seriesRef.current = series;
    return () => {
      ro.disconnect();
      try { chart.applyOptions({ autoSize: false }); } catch { /* chart sudah hilang */ }
      try { chart.remove(); } catch { /* ignore */ }
      chartRef.current = null; seriesRef.current = null;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    // 28 Okt 2026 (bug JS "Cannot update oldest data"): kontrak StreamCandle.time
    // sudah UTC DETIK (klineWsManager -> time: Math.floor(openTime/1000)), tapi
    // handler stream membagi 1000 LAGI -> waktu ~1970 -> selalu lebih tua dari
    // data setData -> lightweight-charts melempar error tak tertangkap tiap tick.
    // Waktu stream kini dipakai apa adanya; tick basi/tak berurutan dibuang.
    const lastTime = lastTimeRef;
    const intervalStr = interval.toLowerCase();
    priceRef.current = null;
    closeTimeRef.current = null;
    const load = () => fetch(`/api/binance/klines?symbol=${symbol}&interval=${intervalStr}&limit=240`).then((r) => r.json()).then((d) => {
      if (!alive || !Array.isArray(d.klines)) return;
      const bars = d.klines.map((k: (string | number)[]) => ({
        time: Math.floor(Number(k[0]) / 1000) as UTCTimestamp,
        open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      })) as CandlestickData[];
      if (bars.length) lastTime.current = bars[bars.length - 1]!.time as number;
      const lastRaw = d.klines[d.klines.length - 1] as (string | number)[] | undefined;
      if (lastRaw && priceRef.current == null) {
        priceRef.current = Number(lastRaw[4]);
        closeTimeRef.current = Number(lastRaw[6]) || null;
      }
      seriesRef.current?.setData(bars);
    }).catch(() => {});
    load();
    const unsubscribe = subscribeKlineStream(symbol, intervalStr, (candle: StreamCandle) => {
      if (!alive || candle.symbol !== symbol || candle.interval !== intervalStr) return;
      const time = candle.time as UTCTimestamp;
      if ((time as number) < lastTime.current) return;
      lastTime.current = time as number;
      priceRef.current = candle.close;
      closeTimeRef.current = candle.closeTime > 0 ? candle.closeTime : null;
      const data: CandlestickData = {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      };
      seriesRef.current?.update(data);
    }, () => {});
    return () => { alive = false; unsubscribe(); };
  }, [symbol, interval]);
  return (
    <div className="chart-frame" style={{ position: "relative" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
      <LastPriceTag
        seriesRef={seriesRef}
        priceRef={priceRef}
        closeTimeRef={closeTimeRef}
        tickSize={0.01}
        height={chartH}
        resetKey={`${symbol}:${interval}`}
      />
    </div>
  );
}

const price = (v?: number) => Number.isFinite(Number(v)) && Number(v) > 0
  ? Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) < 1 ? 6 : 2 })
  : "·";

// Baris tabel posisi terbuka Market Overview (tahap 3 Tema B: DataTable).
interface OpenPosRow {
  id: number;
  symbol: string;
  side: string;
  mode: string;
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  floatingUsd: number;
}

export function MarketPage() {
  const [live, setLive] = useState<LiveDash | null>(null);
  const [movers, setMovers] = useState<{ gainers: Mover[]; losers: Mover[] } | null>(null);
  const [tickers, setTickers] = useState<Map<string, LiveTicker>>(new Map());
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("1h");

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      fetch("/api/live/dashboard", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/markets/top").then((r) => r.json()).catch(() => null),
    ]).then(([l, m]) => {
      if (!alive) return;
      if (l) setLive(l as LiveDash); if (m) setMovers(m);
    });
    load(); const t = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  useEffect(() => binanceWs.subscribeMulti([...WATCH], (map) => setTickers(new Map(map))), []);

  /*
     30 Okt 2026 (poin 1): semua angka akun di Market Overview berasal dari
     akun LIVE Binance (/api/live/dashboard), bukan akun simulasi $200.
  */
  const livePositions = live?.live?.positions ?? [];
  const open = livePositions;
  const equityUsd = Number(live?.exchangeBalanceUsd ?? live?.live?.equityUsd ?? 0);
  const realizedUsd = Number(live?.live?.netPnlUsd ?? 0);
  const floatingUsd = Number(live?.live?.unrealizedPnlUsd ?? 0);
  const guardCount = live?.guardReasons?.length ?? 0;
  const watch = useMemo(() => WATCH.map((s) => ({ symbol: s, ticker: tickers.get(s) })), [tickers]);
  const topMover = (movers?.gainers?.[0] ?? movers?.losers?.[0]) ?? null;
  const moverRows = useMemo(() => [...(movers?.gainers ?? []).slice(0, 3), ...(movers?.losers ?? []).slice(0, 3)], [movers]);

  const posRows = useMemo<OpenPosRow[]>(() => open.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    mode: p.mode,
    entryPrice: p.entryPrice,
    slPrice: p.slPrice,
    tp1Price: p.tp1Price,
    floatingUsd: Number(p.unrealizedPnlUsd ?? 0),
  })), [open]);

  // Kolom tabel posisi terbuka — semantik sama dengan tabel manual lama
  // (Symbol/Side/Mode/Entry/SL/TP1/Floating), kini sortable via DataTable.
  const posCols = useMemo<ColumnDef<OpenPosRow, any>[]>(() => [
    { accessorKey: "symbol", header: "Symbol", cell: (i) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{(i.getValue() as string).replace("USDT", "")}</span> },
    { accessorKey: "side", header: "Side", cell: (i) => <span style={{ color: (i.getValue() as string) === "LONG" ? colors.up : colors.down }}>{i.getValue() as string}</span> },
    { accessorKey: "mode", header: "Mode", cell: (i) => <span style={{ color: colors.textMuted }}>{i.getValue() as string}</span> },
    { accessorKey: "entryPrice", header: "Entry", meta: { align: "right" }, cell: (i) => price(i.getValue() as number) },
    { accessorKey: "slPrice", header: "SL", meta: { align: "right" }, cell: (i) => price(i.getValue() as number) },
    { accessorKey: "tp1Price", header: "TP1", meta: { align: "right" }, cell: (i) => price(i.getValue() as number) },
    {
      accessorKey: "floatingUsd", header: "Floating", meta: { align: "right" },
      cell: (i) => { const v = i.getValue() as number; return <span style={{ color: pctColor(v), fontWeight: 700 }}>{v >= 0 ? "+" : ""}{v.toFixed(2)}</span>; },
    },
  ], []);

  return (
    <div className="page">
      {/* Hero band Tema B: banner-h full-bleed + scrim gelap dari kiri (hanya Market Overview). */}
      <div className="market-hero">
        <div className="market-hero-scrim" />
        <div className="market-hero-body">
          <div className="eyebrow">MARKET / OVERVIEW</div>
          <h1 className="pagehead-title" style={{ margin: "6px 0 0", fontSize: 34, fontWeight: 700, color: colors.textStrong, letterSpacing: "-0.02em", fontFamily: fonts.disp, textTransform: "uppercase" }}>Market monitor</h1>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>akun LIVE Binance · read-only · data pasar publik</div>
        </div>
        <div className="market-hero-actions">
          <Badge bg={colors.upBg} fg={colors.up}>LIVE MARKET</Badge>
          {topMover && <span className="mono tiny muted">TOP MOVE {topMover.symbol.replace("USDT", "")} <span style={{ color: pctColor(topMover.chg24hPct) }}>{fmtPct(topMover.chg24hPct)}</span></span>}
        </div>
      </div>

      <div className="metric-strip">
        <div><StatCell label="Equity" value={`$${equityUsd.toFixed(2)}`} sub={<span>akun LIVE · <Delta value={realizedUsd} suffix=" USD" digits={2} /></span>} /></div>
        <div><StatCell label="Realized P&L" value={<Delta value={realizedUsd} suffix=" USD" digits={2} />} sub={<span>Floating <Delta value={floatingUsd} suffix=" USD" digits={2} /></span>} /></div>
        <div><StatCell label="Open positions" value={open.length} sub={`${open.filter((p) => p.mode === "SWING").length} swing · ${open.filter((p) => p.mode !== "SWING").length} scalp`} /></div>
        <div><StatCell label="Risk state" value={guardCount > 0 ? "GUARDED" : "NORMAL"} valueColor={guardCount > 0 ? colors.warn : colors.up} sub={`${live?.executionMode ?? "·"} · ARM ${live?.armed ? "ON" : "OFF"}`} /></div>
      </div>

      <div className="market-grid">
        <div className="stack">
          <Panel title="Top movers · 24h" extra={<span className="tiny mono muted">GAIN / LOSS</span>}>
            {moverRows.length === 0 ? <EmptyState>Menunggu scan pasar.</EmptyState> : moverRows.map((m) => (
              <button key={`${m.symbol}-${m.chg24hPct}`} onClick={() => setSymbol(m.symbol)} className="watch-row" style={{ width: "100%", background: "transparent", border: 0, cursor: "pointer", textAlign: "left" }}>
                <span><span className="watch-symbol">{m.symbol.replace("USDT", "")}</span><br /><span className="tiny muted">{price(m.price)}</span></span>
                <span className="mono tiny" style={{ color: pctColor(m.chg24hPct) }}>{fmtPct(m.chg24hPct)}</span>
              </button>
            ))}
          </Panel>
        </div>

        <Panel title={<span>{symbol} <span style={{ color: colors.textMuted, fontWeight: 500 }}>/ {interval}</span></span>} extra={
          <div className="chart-toolbar">
            {TIMEFRAMES.map((t) => <button key={t.label} className={interval === t.interval ? "active" : ""} onClick={() => setInterval(t.interval)}>{t.label}</button>)}
          </div>
        } bodyStyle={{ padding: 0 }}>
          <MarketChart symbol={symbol} interval={interval} />
        </Panel>

        <div className="stack">
          <Panel title="Watchlist" extra={<span className="tiny mono muted">LIVE</span>}>
            {watch.map(({ symbol: s, ticker }) => (
              <button key={s} onClick={() => setSymbol(s)} className="watch-row" style={{ width: "100%", background: "transparent", border: 0, cursor: "pointer", textAlign: "left" }}>
                <span><span className="watch-symbol">{s.replace("USDT", "")}</span><span className="tiny muted"> / USDT</span></span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}><span className="mono" style={{ fontSize: 11, color: colors.text }}>{price(Number(ticker?.lastPrice))}</span><span className="mono tiny" style={{ color: pctColor(ticker?.chg24hPct ?? 0) }}>{ticker ? fmtPct(ticker.chg24hPct) : "·"}</span></span>
              </button>
            ))}
          </Panel>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(280px, .8fr)", gap: 12 }}>
        <Panel title={`Open positions · ${open.length}`} extra={<span className="tiny mono muted">LIVE · EXCHANGE</span>}>
          <DataTable columns={posCols} data={posRows} maxHeight={380} emptyText="Tidak ada posisi terbuka." onRowClick={(r) => setSymbol(r.symbol)} />
        </Panel>
        <AlertFeedPanel />
      </div>
    </div>
  );
}
