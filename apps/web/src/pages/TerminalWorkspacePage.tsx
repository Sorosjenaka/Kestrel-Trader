import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PANEL, TradingChartPanel, type ChartPanelConfig, type ChartPosition } from "../components/TradingChartPanel.js";
import { EquityCurve } from "../components/EquityCurve.js";
import { ChartErrorBoundary } from "../components/ChartErrorBoundary.js";
import { binanceWs, type LiveTicker } from "../lib/binanceWs.js";
import { useMarkPrices } from "../lib/useMarkPrices.js";
import { FlashValue } from "../components/FlashValue.js";
import { FeedBadge } from "../components/FeedBadge.js";
import { AnalysisPanel } from "../components/AnalysisPanel.js";
import { applySymbolToPanel, nextRouteSymbol } from "../lib/workspaceRouting.js";
import { colors } from "../theme.js";

interface Overview {
  equity?: { currentUsd?: number; startingUsd?: number; cumulativePnlUsd?: number; dailyPnlUsd?: number; drawdownUsd?: number };
  floating?: { totalPnlUsd?: number; positions?: Array<{ id: number; symbol: string; side: string; pnlUsd: number; live?: boolean }> };
}
interface PositionView extends ChartPosition { markPrice?: number; pnlUsd?: number | null; pnlPct?: number | null; pnlR?: number | null; priceTick?: number; riskBudgetUsd?: number | null; leverage?: number; notional?: number; originalQty?: number | null; lifecycle?: string; closedQty?: number | null; remainingQty?: number | null; tp1TargetQty?: number | null; tp1FillPrice?: number | null; tp1FilledAt?: string | null; realizedPnlUsd?: number | null }
interface LoopRun { runId: string; strategyId: string; state: string; trigger?: string; triggerReason?: string; lastError?: string | null; updatedAt?: string; backtestRunId?: string | null; gateDecisionId?: string | null; forwardRunId?: string | null; reviewRunId?: string | null }
interface LoopStatus { loop?: { runs?: LoopRun[] }; counts?: { active?: number; terminal?: number; total?: number } }
interface Signal { id: number; symbol: string; side: string; strategyId: string; decision: string; reason?: string | null; createdAt: string; entryPrice?: number | null; slPrice?: number | null; tp1Price?: number | null }
interface Trade { id: number; symbol: string; side: string; strategyId?: string; pnlUsd?: number; rMultiple?: number; feeUsd?: number; fundingUsd?: number; exitReason?: string; createdAt?: string; closedAt?: string }
interface Settings { thresholds?: { maxOpenPositions?: number; swingPaperMaxOpenPositions?: number } }
interface DataBundle { overview: Overview | null; positions: ChartPosition[]; pending: ChartPosition[]; signals: Signal[]; trades: Trade[]; loop: LoopStatus | null; maxPositions: number; errors: string[] }

const LAYOUT_KEY = "arta.terminal.layout.v3";
const PAPER_POSITION_CAP = 20;
const PANELS_KEY = "arta.workspace.panels.v3";
// 21 Okt 2026 (Phase 5): "S-05" TETAP ada di sini walau sudah diarsipkan —
// entry S-05 baru tidak ada, tapi trade historis S-05 harus tetap tampil
// sebagai "Polaris" (label era, bukan entry source). Jangan dihapus.
const STRATEGY_NAMES: Record<string, string> = { "S-05": "Polaris", "RSW-01": "Orion", "RSW-02": "Vega", "RSW-03": "Draco" };
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "ADAUSDT", "TONUSDT"];
const TABS = ["POSITIONS", "PENDING", "FILLS", "KEPUTUSAN", "EVENT JOURNAL", "MARKET PULSE", "ANALISIS ALIRAN"] as const;
type Tab = (typeof TABS)[number];
type Layout = 1 | 4 | 8;

function panelFor(index: number, id?: string): ChartPanelConfig {
  const symbol = SYMBOLS[index % SYMBOLS.length]!;
  const intervals = ["1h", "4h", "1D", "15m", "1h", "4h", "1D", "15m"];
  return { ...DEFAULT_PANEL, id: id ?? `p${index + 1}`, symbol, interval: intervals[index % intervals.length]!, indicators: { ...DEFAULT_PANEL.indicators } };
}
function loadPanels(): ChartPanelConfig[] {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.schemaVersion === 3 && Array.isArray(parsed.panels) && parsed.panels.length >= 1) {
      return parsed.panels.map((p: Partial<ChartPanelConfig>, i: number) => ({
        ...DEFAULT_PANEL, ...p,
        id: typeof p.id === 'string' && p.id ? p.id : `p${i + 1}`,
        symbol: typeof p.symbol === 'string' && p.symbol ? p.symbol : DEFAULT_PANEL.symbol,
        interval: typeof p.interval === 'string' && p.interval ? p.interval : DEFAULT_PANEL.interval,
        indicators: { ...DEFAULT_PANEL.indicators, ...(p.indicators ?? {}) },
      }));
    }
  } catch { /* fall back */ }
  return [panelFor(0)];
}
function savePanels(panels: ChartPanelConfig[]) {
  try { localStorage.setItem(PANELS_KEY, JSON.stringify({ schemaVersion: 3, panels })); } catch { /* storage may be disabled */ }
}
function loadLayout(): Layout {
  try { const v = Number(localStorage.getItem(LAYOUT_KEY)); return v === 4 || v === 8 || v === 1 ? v : 1; } catch { return 1; }
}
function fmt(v: number | undefined | null, digits = 2): string {
  return Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: digits }) : "·";
}
function money(v: number | undefined | null): string { return Number.isFinite(Number(v)) ? `$${Number(v).toFixed(2)}` : "·"; }
function signedMoney(v: number | undefined | null): string {
  if (!Number.isFinite(Number(v))) return "·";
  const n = Number(v);
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}
function priceDigits(p?: { priceTick?: number; entryPrice?: number }): number {
  const tick = Number(p?.priceTick);
  if (Number.isFinite(tick) && tick > 0) return Math.min(8, Math.max(0, Math.round(-Math.log10(tick))));
  const v = Number(p?.entryPrice);
  if (!Number.isFinite(v) || v <= 0) return 2;
  if (v < 0.01) return 6;
  if (v < 1) return 5;
  if (v < 1000) return 4;
  return 2;
}
function price(v: number | undefined | null, p?: { priceTick?: number; entryPrice?: number }): string {
  if (!Number.isFinite(Number(v))) return "·";
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: priceDigits(p), maximumFractionDigits: priceDigits(p) });
}
function pct(v: number | undefined | null): string {
  if (!Number.isFinite(Number(v))) return "·";
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function qty(v: number | undefined | null): string {
  if (!Number.isFinite(Number(v))) return "·";
  return Number(v).toLocaleString("en-US", { maximumFractionDigits: 6 });
}
/**
 * Volume 24h futures dalam USD — angka LENGKAP (tidak disingkat K/M/B).
 * 23 Okt 2026: operator minta angka detail, bukan ringkasan. Format ribuan
 * dengan pemisah "," supaya $1,559,648 terbaca sebagai 1.56 juta.
 */
function usdFull(v: number | undefined | null): string {
  if (!Number.isFinite(Number(v))) return "·";
  return `$${Math.round(Number(v)).toLocaleString("en-US")}`;
}
/** Volume 24h + status di bawah/di atas lantai operator. */
function volumeCell(t: LiveTicker | undefined, minUsd: number): { text: string; below: boolean } {
  const v = Number(t?.volume24h ?? 0);
  if (!Number.isFinite(v) || v <= 0) return { text: "·", below: true };
  return { text: usdFull(v), below: v <= minUsd };
}
function strategyLabel(id?: string | null): string { return id ? `${id} ${STRATEGY_NAMES[id] ?? ""}`.trim() : "·"; }
function age(ms?: string | number | null): string {
  if (!ms) return "·";
  const t = typeof ms === "number" ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return "·";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}
function statusLabel(state?: string): string {
  return (state ?? "UNKNOWN").replaceAll("_", " ");
}

export function TerminalWorkspacePage({ requestedSymbol }: { requestedSymbol?: string }) {
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [panels, setPanels] = useState<ChartPanelConfig[]>(loadPanels);
  const [activeId, setActiveId] = useState(panels[0]?.id ?? "p1");
  const [tab, setTab] = useState<Tab>("POSITIONS");
  const [bundle, setBundle] = useState<DataBundle>({ overview: null, positions: [], pending: [], signals: [], trades: [], loop: null, maxPositions: PAPER_POSITION_CAP, errors: [] });
  const [strategyScope, setStrategyScope] = useState("ALL");
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveTickers, setLiveTickers] = useState<Map<string, LiveTicker>>(() => binanceWs.getMultiTickers());
  /*
     23 Okt 2026 (Tahap 8 · "semua pair harus hidup"):
     SSE multi hanya meng-cover pair yang ter-subscribe (posisi + panel aktif
     ≈ 20-30 simbol). Market Pulse butuh PERINGKATAN SELURUH UNIVERSE
     (~496 pair Binance Futures), kalau tidak "TOP GAINERS/LOSERS/VOLUME/
     FUNDING" hanya menampilkan pair yang kebetulan sedang dibuka operator ·
     bukan market movers sungguhan.
     Feed universe penuh diambil via REST /api/prices/live (satu snapshot
     61 KB, age ~0.5 dtk) tiap 5 dtk; chart tetap pakai SSE 1 dtk.
  */
  const [wideTickers, setWideTickers] = useState<Map<string, LiveTicker>>(new Map());
  // 23 Okt 2026: ambang volume operator (VOLUME_MIN_USD) dari server — sumber
  // tunggal kebenaran yang sama dengan gate entry. Dipakai untuk menandai pair
  // yang volumenya di bawah lantai, jadi operator langsung melihat mismatch.
  const [volumeMinUsd, setVolumeMinUsd] = useState(0);

  const activePanel = panels.find((p) => p.id === activeId) ?? panels[0] ?? DEFAULT_PANEL;
  const visiblePanels = useMemo(() => {
    const out = panels.slice(0, layout);
    while (out.length < layout) out.push(panelFor(out.length));
    return out;
  }, [panels, layout]);
  const positionSymbols = useMemo(() => [...new Set(bundle.positions.map((p) => p.symbol))].sort(), [bundle.positions]);
  // Mark price realtime (WS publik -> fallback hub) khusus posisi terbuka.
  const { marks: feedMarks, status: feedStatus } = useMarkPrices(positionSymbols);
  const floatingById = useMemo(() => new Map((bundle.overview?.floating?.positions ?? []).map((p) => [p.id, p])), [bundle.overview]);
  const positionView = useMemo<PositionView[]>(() => bundle.positions.map((p) => {
    const t = liveTickers.get(p.symbol);
    const mark = Number(feedMarks.get(p.symbol)?.mark ?? t?.markPrice ?? t?.lastPrice ?? p.markPrice);
    const qty = Number(p.qty);
    const isLong = p.side === "LONG";
    const overviewPnl = floatingById.get(p.id)?.pnlUsd;
    const computedPnl = Number.isFinite(Number(mark)) && mark > 0 && Number.isFinite(qty)
      ? (isLong ? mark - p.entryPrice : p.entryPrice - mark) * qty : null;
    const pnlUsd = computedPnl !== null && Number.isFinite(computedPnl) ? computedPnl : (Number.isFinite(Number(overviewPnl)) ? Number(overviewPnl) : null);
    const risk = Number(p.riskBudgetUsd ?? p.originalRiskUsd);
    const margin = Number(p.marginUsd);
    return {
      ...p,
      markPrice: Number.isFinite(Number(mark)) && mark > 0 ? mark : undefined,
      pnlUsd,
      pnlPct: pnlUsd !== null && Number.isFinite(margin) && margin > 0 ? (pnlUsd / margin) * 100 : null,
      pnlR: pnlUsd !== null && Number.isFinite(risk) && risk > 0 ? pnlUsd / risk : null,
    };
  }), [bundle.positions, liveTickers, feedMarks, floatingById]);
  const activePosition = positionView.find((p) => p.symbol === activePanel.symbol);
  const activeTicker = liveTickers.get(activePanel.symbol);
  const activeVolume = volumeCell(activeTicker, volumeMinUsd);
  const activeSignal = bundle.signals.find((s) => s.symbol === activePanel.symbol && (strategyScope === "ALL" || s.strategyId === strategyScope));
  const activeLoop = [...(bundle.loop?.loop?.runs ?? [])].reverse().find((r) => strategyScope === "ALL" || r.strategyId === strategyScope);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        fetch("/api/overview", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`overview ${r.status}`))),
        fetch("/api/positions?status=OPEN", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`positions ${r.status}`))),
        fetch("/api/positions?status=PENDING", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`pending ${r.status}`))),
        fetch("/api/swing/signals?limit=40", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`signals ${r.status}`))),
        fetch("/api/trades?mode=SWING", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`trades ${r.status}`))),
        fetch("/api/swing-eval-loop/status", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`loop ${r.status}`))),
        fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`settings ${r.status}`))),
      ]);
      const errors: string[] = [];
      const value = <T,>(i: number, fallback: T): T => {
        const r = results[i];
        if (r?.status === "fulfilled") return r.value as T;
        errors.push(r?.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : "request failed");
        return fallback;
      };
      setBundle({
        overview: value(0, null), positions: value(1, { positions: [] }).positions ?? [],
        pending: value(2, { positions: [] }).positions ?? [], signals: value(3, { signals: [] }).signals ?? [],
        trades: value(4, { trades: [] }).trades ?? [], loop: value(5, null),
        maxPositions: Math.max(1, Number((value(6, { thresholds: {} }) as Settings).thresholds?.maxOpenPositions) || PAPER_POSITION_CAP),
        errors,
      });
      setLastRefresh(Date.now());
    } finally { setLoading(false); }
  }, []);

  // Ambang volume operator: diambil sekali, refreshed saat reload dashboard.
  useEffect(() => {
    let alive = true;
    const grab = () => {
      fetch("/api/markets/volume-floor", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d && Number.isFinite(Number(d.volumeMinUsd))) setVolumeMinUsd(Number(d.volumeMinUsd)); })
        .catch(() => {});
    };
    grab();
    const id = window.setInterval(grab, 60_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  useEffect(() => { void load(); const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 20_000); return () => window.clearInterval(id); }, [load]);

  /*
     23 Okt 2026: feed universe penuh untuk Market Pulse.
     Satu request /api/prices/live (tanpa filter = semua simbol yang di-feed
     backend) tiap 5 dtk. Payload ~61 KB, age ~0.5 dtk · cukup untuk
     peringkat top movers/funding, dan JAUH lebih murah daripada SSE
     1 dtk untuk 496 simbol (~61 KB/dtk).
     Error tidak mematikan: data lama tetap tampil, dengan status stale.
  */
  useEffect(() => {
    let alive = true;
    const grab = async () => {
      try {
        const res = await fetch("/api/prices/live", { cache: "no-store" });
        if (!res.ok) return;
        const d = await res.json();
        if (!alive || !d?.prices) return;
        const next = new Map<string, LiveTicker>();
        for (const [sym, raw] of Object.entries(d.prices as Record<string, Record<string, number>>)) {
          const m = Number(raw.m) || Number(raw.p) || 0;
          if (!(m > 0)) continue;
          next.set(sym, {
            symbol: sym,
            markPrice: m,
            lastPrice: Number(raw.p) || m,
            chg24hPct: Number(raw.c) || 0,
            high24h: Number(raw.h) || 0,
            low24h: Number(raw.l) || 0,
            volume24h: Number(raw.v) || 0,
            fundingRate: raw.r === null || raw.r === undefined ? null : Number(raw.r),
            direction: "FLAT",
            lastUpdated: Number(raw.t) || Date.now(),
            live: true,
            src: "FUTURES",
          });
        }
        if (next.size > 0) setWideTickers(next);
      } catch { /* biarkan data lama */ }
    };
    void grab();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void grab(); }, 5_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  const liveSymbols = useMemo(() => [...new Set([...positionSymbols, ...visiblePanels.map((p) => p.symbol), activePanel.symbol])].sort(), [positionSymbols, visiblePanels, activePanel.symbol]);
  useEffect(() => {
    // Backend price hub: real Binance Futures mark-price WebSocket -> SSE 1s.
    // No private endpoint and no browser WebSocket (network-block safe).
    return binanceWs.subscribeMulti(liveSymbols, (next) => setLiveTickers(new Map(next)));
  }, [liveSymbols.join(",")]);
  useEffect(() => { savePanels(panels); }, [panels]);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, String(layout)); } catch { /* storage may be disabled */ } }, [layout]);
  useEffect(() => { if (!panels.some((p) => p.id === activeId)) setActiveId(panels[0]?.id ?? "p1"); }, [panels, activeId]);
  /*
     23 Okt 2026 (BUG "symbol ter-revert"):
     Effect lama memakai dependency [requestedSymbol, activeId]. Consequences:
       (a) setiap kali activeId berubah (klik panel lain / pilih pair lain),
           effect ini MENIMPA symbol panel aktif dengan symbol dari route,
           membatalkan pilihan operator;
       (b) requestedSymbol hanya berubah saat hash route berubah, jadi nilainya
           "basi" · effect ini memaksa symbol lama tiap kali panel aktif diganti.
     Perbaikan: apply requestedSymbol SATU KALI per nilai route (tidak ikut
     activeId), dan hanya bila symbol panel aktif memang belum sama.
     Perubahan panel oleh operator TIDAK boleh ditimpa effect ini.
  */
  const lastAppliedRouteSymbolRef = useRef<string | null>(null);
  useEffect(() => {
    const decision = nextRouteSymbol(lastAppliedRouteSymbolRef.current, requestedSymbol);
    lastAppliedRouteSymbolRef.current = decision.nextApplied;
    if (!decision.symbol) return;
    setPanels((prev) => applySymbolToPanel(prev, activeId, decision.symbol as string));
    // activeId sengaja TIDAK jadi dependency: lihat komentar di atas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSymbol]);

  const changeLayout = (next: Layout) => {
    setLayout(next);
    setPanels((prev) => {
      const out = [...prev];
      while (out.length < next) out.push(panelFor(out.length));
      return out;
    });
  };
  const updatePanel = (id: string, patch: Partial<ChartPanelConfig>) => {
    setPanels((prev) => prev.map((p) => p.id === id ? { ...p, ...patch } : p));
  };
  const resetWorkspace = () => {
    if (!window.confirm("Reset layout, pilihan symbol/TF, dan anotasi panel? Tidak mengubah trade, saldo, posisi, worker, atau ARM.")) return;
    const fresh = [panelFor(0)];
    setPanels(fresh); setLayout(1); setActiveId(fresh[0]!.id);
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("arta.workspace.panels.v3") || k.startsWith("arta.terminal.layout.v3")).forEach((k) => {
        if (k !== PANELS_KEY && k !== LAYOUT_KEY) localStorage.removeItem(k);
      });
    } catch { /* storage may be disabled */ }
  };
  const selectSymbol = (symbol: string) => {
    const panel = panels.find((p) => p.id === activeId);
    if (panel) updatePanel(panel.id, { symbol });
  };
  const selectStrategy = (sid: string) => setStrategyScope(sid);
  const positionRows = positionView.filter((p) => strategyScope === "ALL" || p.strategyId === strategyScope);
  const tradeRows = bundle.trades.filter((t) => strategyScope === "ALL" || t.strategyId === strategyScope);
  // 23 Okt 2026: filter signal "PORTFOLIO" (itu status engine, bukan entry signal) dari tab KEPUTUSAN.
  const signalRows = bundle.signals.filter((s) => s.symbol !== "PORTFOLIO" && (strategyScope === "ALL" || s.strategyId === strategyScope));
  /*
     Ref mark price terakhir per simbol. Dipakai untuk (a) menghitung arah
     tick UP/DOWN dan (b) memicu flash hijau/merah. Dideklarasikan DI ATAS
     useMemo movers karena dipakai di dalamnya.
  */
  const prevMarksRef = useRef<Map<string, number>>(new Map());

  /*
     23 Okt 2026: TOP MOVERS dihitung dari GABUNGAN dua feed:
       - wideTickers: seluruh universe (~496 pair), update tiap 5 dtk
       - liveTickers: pair yang ter-subscribe, update tiap 1 dtk (lebih segar)
     Pair yang ada di keduanya memakai angka liveTickers (lebih baru).
     Arah tick (UP/DOWN) dihitung di sini dari delta mark price, supaya
     pair non-subscribe juga punya arah benar (feed wide tidak punya
     "direction" · kalau tidak dihitung, semua jadi FLAT).
  */
  const movers = useMemo(() => {
    const merged = new Map<string, LiveTicker>();
    wideTickers.forEach((t, sym) => merged.set(sym, t));
    liveTickers.forEach((t, sym) => merged.set(sym, t));
    const arr: Array<{ symbol: string; chg: number; mark: number; vol: number; dir: string; live: boolean; updated: number; funding: number | null }> = [];
    merged.forEach((t, sym) => {
      if (!t || t.markPrice <= 0) return;
      const mark = t.markPrice;
      const prev = prevMarksRef.current.get(sym);
      const dir = prev === undefined ? "FLAT" : mark > prev ? "UP" : mark < prev ? "DOWN" : (t.direction ?? "FLAT");
      arr.push({
        symbol: sym,
        chg: Number(t.chg24hPct ?? 0),
        mark,
        vol: Number(t.volume24h ?? 0),
        dir,
        live: t.live === true,
        updated: t.lastUpdated,
        // null = feed belum punya funding untuk simbol ini (bukan 0%).
        funding: t.fundingRate === null || t.fundingRate === undefined ? null : Number(t.fundingRate),
      });
    });
    arr.sort((a, b) => b.chg - a.chg);
    return arr;
  }, [liveTickers, wideTickers]);
  const topGainers = movers.slice(0, 10);
  const topLosers = movers.slice().reverse().slice(0, 10);
  const topVol = useMemo(() => [...movers].sort((a, b) => b.vol - a.vol).slice(0, 10), [movers]);
  /*
     23 Okt 2026 (BUG): topFunding sebelumnya menyortir berdasarkan chg24h
     (duplikat TOP GAINERS) dan tidak pernah dipakai. Sekarang benar-benar
     menyortir FUNDING RATE, dan hanya(pair) yang punya funding nyata
     (funding !== null) · pair tanpa data tidak dihitung sebagai 0%.
  */
  const topFunding = useMemo(() =>
    [...movers]
      .filter((m) => m.funding !== null)
      .sort((a, b) => Number(b.funding) - Number(a.funding))
      .slice(0, 10)
  , [movers]);
  const topFundingShort = useMemo(() =>
    [...movers]
      .filter((m) => m.funding !== null)
      .sort((a, b) => Number(a.funding) - Number(b.funding))
      .slice(0, 10)
  , [movers]);

  /*
     23 Okt 2026: flash arah per baris.
     BUG LAMA: CSS memberi animasi "tickIn" (hijau) ke SEMUA baris live ·
     baris yang turun pun berkedip hijau. Sekarang flash ditentukan arah
     mark price: naik = hijau, turun = merah, tanpa perubahan = tanpa flash.
     Sumber delta = GABUNGAN feed (wide 5 dtk + live 1 dtk), supaya pair
     non-subscribe ikut berkedip.
  */
  const [rowFlash, setRowFlash] = useState<Record<string, "flash-up" | "flash-down">>({});
  useEffect(() => {
    const prev = prevMarksRef.current;
    const next = new Map<string, number>();
    const changed: Record<string, "flash-up" | "flash-down"> = {};
    const merged = new Map<string, LiveTicker>();
    wideTickers.forEach((t, sym) => merged.set(sym, t));
    liveTickers.forEach((t, sym) => merged.set(sym, t));
    merged.forEach((t, sym) => {
      const mark = Number(t?.markPrice ?? 0);
      if (!(mark > 0)) return;
      next.set(sym, mark);
      const before = prev.get(sym);
      if (before !== undefined && before !== mark) changed[sym] = mark > before ? "flash-up" : "flash-down";
    });
    prevMarksRef.current = next;
    if (Object.keys(changed).length === 0) return;
    setRowFlash((old) => ({ ...old, ...changed }));
    const timer = window.setTimeout(() => {
      setRowFlash((old) => {
        const out = { ...old };
        for (const k of Object.keys(changed)) delete out[k];
        return out;
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [liveTickers, wideTickers]);

  /*
     23 Okt 2026: satu renderer baris untuk semua blok Market Pulse.
     Flash ditentukan ARAH mark price (naik=hijau, turun=merah) · bukan
     "semua baris live berkedip" seperti versi lama.
  */
  const pulseRow = (m: { symbol: string; mark: number; chg: number; vol: number; dir: string; live: boolean }) => (
    <tr key={m.symbol} onClick={() => selectSymbol(m.symbol)} className={`${m.live ? "live" : "stale"}${rowFlash[m.symbol] ? ` ${rowFlash[m.symbol]}` : ""}`}>
      <td><b>{m.symbol}</b></td>
      <td className="num">{m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
      <td className={`num ${m.chg >= 0 ? "positive" : "negative"}`}>{m.chg >= 0 ? "+" : ""}{m.chg.toFixed(2)}%</td>
      <td className="num">{usdFull(m.vol)}</td>
      <td><span className={`dir-pill ${m.dir.toLowerCase()}`}>{m.dir}</span></td>
    </tr>
  );

  const inspector = activePosition ? (
    <>
      <div className="inspector-kicker">POSISI TERPILIH</div>
      {/* 21 Okt 2026 (P-4.17): fallback bukan lagi "S-05" (Polaris sudah arsip 21 Okt 2026);
          pakai mode lane sebagai label. Mode asli juga ditampilkan di badge di bawah. */}
      <div className="inspector-title">{activePanel.symbol} <span>{strategyLabel(activePosition.strategyId ?? activePosition.mode)}</span></div>
      <div className="inspector-badges"><span className={`side-badge ${activePosition.side.toLowerCase()}`}>{activePosition.side}</span><span>{activePosition.mode}</span><span>#{activePosition.id}</span><FeedBadge status={feedStatus} /></div>
      <div className="inspector-levels">
        <div><span>MARK / LAST · PUBLIC</span><b>{price(activePosition.markPrice ?? activeTicker?.markPrice ?? activeTicker?.lastPrice, activePosition)}</b></div>
        <div><span>ENTRY</span><b>{price(activePosition.entryPrice, activePosition)}</b></div>
        <div><span>SL AKTIF</span><b className="negative">{price(activePosition.slPrice, activePosition)}</b></div>
        <div><span>TP1 · 2R</span><b className="positive">{price(activePosition.tp1Price, activePosition)}</b></div>
        <div><span>TP2 · 3R</span><b>{price(activePosition.tp2Price, activePosition)}</b></div>
        <div><span>QTY / MARGIN</span><b>{qty(activePosition.qty)} · {money(activePosition.marginUsd)}</b></div>
        <div><span>NOTIONAL / LEV</span><b>{money(activePosition.notional)} · {fmt(activePosition.leverage, 0)}x</b></div>
        <div><span>FLOATING PnL</span><b className={Number(activePosition.pnlUsd) >= 0 ? "positive" : "negative"} title="uPnL = (mark - entry) x qty · ROI = uPnL / margin"><FlashValue value={activePosition.pnlUsd ?? null}>{signedMoney(activePosition.pnlUsd)} · {pct(activePosition.pnlPct)} · {fmt(activePosition.pnlR, 2)}R</FlashValue></b></div>
        <div><span>VOLUME 24H · FUTURES</span><b className={activeVolume.below ? "negative" : ""}>{activeVolume.text}</b></div>
      </div>
      <div className="lifecycle">
        {["PLAN", "ADMITTED", "PENDING", "FILLED", "TP1 FILLED", "BE CONFIRMED", "TP2 / SL", "CLOSED"].map((step) => {
          const done = step === "PLAN" || step === "FILLED" || (step === "TP1 FILLED" && Boolean(activePosition.tp1FilledAt)) || (step === "BE CONFIRMED" && Boolean(activePosition.beMoved));
          return <div key={step} className={done ? "done" : "pending"}><i />{step}<em>{done ? "observed" : "not observed"}</em></div>;
        })}
      </div>
      <div className="lifecycle-note">Derived from the current position row; event-level pending/admission is not exposed by the read model.</div>
      <div className="paper-note"><b>PROTECTION</b><span>{activePosition.tp1FilledAt ? "TP1 tercatat di ledger; BE mengikuti konfirmasi engine." : "TP1 belum terkonfirmasi. Jangan menandai BE hanya karena wick menyentuh level."}</span></div>
    </>
  ) : (
    <>
      <div className="inspector-kicker">INSPECTOR · NO POSITION</div>
      <div className="inspector-title">{activePanel.symbol} <span>{activePanel.interval.toUpperCase()}</span></div>
      <p className="inspector-empty">Belum ada posisi pada instrumen panel aktif. Pilih panel lain, atau pilih sinyal/keputusan di tabel untuk membaca evidence.</p>
      {activeSignal ? <div className="inspector-signal"><div className="inspector-kicker">SIGNAL TERAKHIR</div><b>{activeSignal.side} · {strategyLabel(activeSignal.strategyId)}</b><p>{activeSignal.reason ?? "Tidak ada alasan tercatat."}</p><small>{new Date(activeSignal.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB · {activeSignal.decision}</small></div> : <div className="inspector-empty small">Tidak ada sinyal pada instrumen ini dalam tape saat ini.</div>}
    </>
  );

  return (
    <div className="workspace-page">
      <div className="workspace-context">
        <div className="workspace-context-left">
          <div><div className="workspace-title">OPERATOR TERMINAL</div><div className="workspace-sub">CANDLESTICK WORKSPACE · READ-ONLY</div></div>
          <span className="context-pill market">BINANCE FUTURES · MARK SSE 1s <i /></span>
          <span className="context-pill locked">LIVE: TERKUNCI</span>
        </div>
        <div className="workspace-context-right">
          <span className="mono tiny muted">{lastRefresh ? `SYNC ${age(lastRefresh)} AGO` : "MENGHUBUNGKAN…"}</span>
          <button className="workspace-ghost" onClick={() => void load()} disabled={loading}>{loading ? "SYNC…" : "REFRESH"}</button>
          <button className="workspace-ghost" onClick={resetWorkspace}>RESET WORKSPACE</button>
        </div>
      </div>

      <div className="workspace-toolbar">
        <div className="workspace-toolbar-left">
          <label className="inline-select">SYMBOL <select value={activePanel.symbol} onChange={(e) => selectSymbol(e.target.value)}>{SYMBOLS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="inline-select">TF <select value={activePanel.interval} onChange={(e) => updatePanel(activePanel.id, { interval: e.target.value })}>{["1m", "3m", "5m", "15m", "1h", "4h", "1D"].map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="inline-select">STRATEGI <select value={strategyScope} onChange={(e) => selectStrategy(e.target.value)}><option value="ALL">SEMUA · 4</option>{Object.keys(STRATEGY_NAMES).map((s) => <option key={s} value={s}>{strategyLabel(s)}</option>)}</select></label>
          <span className="workspace-muted">{panels.length} PANEL · {bundle.positions.length}/{bundle.maxPositions} POSISI</span>
        </div>
        <div className="layout-switch" role="group" aria-label="Layout chart">
          {([1, 4, 8] as const).map((n) => <button key={n} className={layout === n ? "active" : ""} onClick={() => changeLayout(n)} aria-pressed={layout === n}>{n} CHART</button>)}
        </div>
      </div>

      <div className={`workspace-main${layout === 1 ? " one" : layout === 4 ? " four" : " eight"}`}>
        <div className="workspace-chart-stack">
        <div className="chart-grid">
          {visiblePanels.map((panel, i) => (
            <div key={panel.id} className={`chart-panel-wrap${layout === 1 ? " single" : ""}`}>
              <ChartErrorBoundary>
                <TradingChartPanel
                  panel={panel}
                  active={panel.id === activePanel.id}
                  positions={bundle.positions}
                  liveTicker={liveTickers.get(panel.symbol)}
                  compact={layout > 1}
                  onSelect={() => setActiveId(panel.id)}
                  onChange={(patch) => updatePanel(panel.id, patch)}
                  onExpand={() => { changeLayout(1); setActiveId(panel.id); }}
                />
              </ChartErrorBoundary>
              {layout === 8 && <span className="grid-index">0{i + 1}</span>}
            </div>
          ))}
        </div>

        {bundle.overview?.equity && (
          <section className="chart-position-strip" aria-label="Kurva equity portfolio">
            <EquityCurve
              startEquity={Number(bundle.overview.equity.startingUsd ?? 0)}
              trades={tradeRows.filter((t) => t.createdAt).map((t) => ({ createdAt: t.createdAt as string, pnlUsd: Number(t.pnlUsd ?? 0) }))}
              currentEquity={bundle.overview.equity.currentUsd ?? null}
              height={140}
            />
          </section>
        )}
        <section className="chart-position-strip" aria-label="Open positions under chart">
          <div className="position-strip-head">
            <b>OPEN POSITIONS · {positionRows.length}/{bundle.maxPositions}{positionRows.length > bundle.maxPositions ? ` · +${positionRows.length - bundle.maxPositions} MORE` : ""}</b>
            <span>MARK 1s · klik baris untuk chart{strategyScope !== "ALL" ? ` · SCOPE ${strategyScope}` : ""}</span>
          </div>
          {positionRows.length ? (
            <div className="position-strip-body">
            <table className="position-strip-table">
              <thead><tr><th>Symbol</th><th>Side</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">PnL</th><th className="num">R</th><th className="num">Volume 24H</th></tr></thead>
              <tbody>{positionRows.slice(0, bundle.maxPositions).map((p) => {
                const vol = volumeCell(liveTickers.get(p.symbol), volumeMinUsd);
                return (
                <tr key={p.id} onClick={() => selectSymbol(p.symbol)}>
                  <td data-label="Symbol"><b>{p.symbol}</b><small>#{p.id}</small></td>
                  <td data-label="Side" className={p.side === "LONG" ? "positive" : "negative"}>{p.side}</td>
                  <td data-label="Entry" className="num">{price(p.entryPrice, p)}</td>
                  <td data-label="Mark" className="num">{price(p.markPrice, p)}</td>
                  <td data-label="PnL" className={`num ${Number(p.pnlUsd) >= 0 ? "positive" : "negative"}`}><FlashValue value={p.pnlUsd ?? null}>{signedMoney(p.pnlUsd)} · {pct(p.pnlPct)}</FlashValue></td>
                  <td data-label="R" className="num">{fmt(p.pnlR, 2)}</td>
                  <td data-label="Volume 24H" className={`num ${vol.below ? "negative" : "muted"}`} title={vol.below ? `Di bawah lantai volume operator ${usdFull(volumeMinUsd)}` : undefined}>{vol.text}</td>
                </tr>
                );
              })}</tbody>
            </table>
            </div>
          ) : <div className="position-strip-empty">Tidak ada posisi pada scope ini.</div>}
        </section>
        </div>

        <aside className="workspace-inspector">
          <div className="inspector-paper">
            <div className="paper-top"><span>SELECTED CONTEXT</span><span>{activePanel.id.toUpperCase()} · {activePanel.symbol}</span></div>
            {inspector}
          </div>
          <div className="inspector-lavender">
            <div className="inspector-kicker">EVIDENCE / AGENT</div>
            {activeLoop ? <><b>{strategyLabel(activeLoop.strategyId)} · {statusLabel(activeLoop.state)}</b><p>{activeLoop.lastError ?? "Tidak ada error aktif pada run terakhir."}</p><small>{activeLoop.runId} · {age(activeLoop.updatedAt)} ago</small></> : <p>Pilih strategi untuk membaca status evaluasi terakhir. Tidak ada teks agen tanpa roleRun/evidence.</p>}
          </div>
          <div className="inspector-green">
            <div className="inspector-kicker">CONTROL CONTEXT</div>
            <div><span>Posisi global</span><b>{bundle.positions.length} / {bundle.maxPositions}</b></div>
            <div><span>Data feed</span><b>{bundle.errors.length ? "PARTIAL" : "PUBLIC BINANCE"}</b></div>
            <div><span>Loop active</span><b>{bundle.loop?.counts?.active ?? 0}</b></div>
            <small>{activePosition ? `Level posisi berasal dari record #${activePosition.id}; garis gambar manual tidak mengubah SL/TP.` : "Tidak ada order/level yang dibuat oleh UI ini."}</small>
          </div>
        </aside>
      </div>

      <section className="workspace-ledger">
        <div className="ledger-tabs" role="tablist" aria-label="Workspace records">
          {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <div className="ledger-body">
          {tab === "POSITIONS" && (positionRows.length ? <table className="workspace-table"><thead><tr><th>Record</th><th>Symbol</th><th>Side</th><th>Mode</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">SL</th><th className="num">TP1</th><th className="num">Qty</th><th className="num">Margin</th><th className="num">PnL $</th><th className="num">PnL %</th><th className="num">R</th></tr></thead><tbody>{positionRows.map((p) => <tr key={p.id} onClick={() => selectSymbol(p.symbol)}><td>#{p.id}{p.lifecycle === "PARTIALLY_CLOSED" && <span title={`TP1 terisi ${qty(p.closedQty)} dari target ${qty(p.tp1TargetQty)}; sisa ${qty(p.remainingQty)} masih OPEN. Realisasi TP1: ${signedMoney(p.realizedPnlUsd)}.`}> <span className="mono" style={{ fontSize: 9, color: colors.warn, border: `1px solid ${colors.warn}`, borderRadius: 3, padding: "1px 4px" }}>PARTIAL TP1</span></span>}</td><td>{p.symbol}</td><td className={p.side === "LONG" ? "positive" : "negative"}>{p.side}</td><td>{p.mode}</td><td className="num">{price(p.entryPrice, p)}</td><td className="num">{price(p.markPrice, p)}</td><td className="num">{price(p.slPrice, p)}</td><td className="num">{price(p.tp1Price, p)}</td><td className="num">{p.lifecycle === "PARTIALLY_CLOSED" ? <span title={`initialQty ${qty(p.originalQty)} · tertutup ${qty(p.closedQty)} · sisa ${qty(p.remainingQty)}`}>{qty(p.qty)}<span style={{ color: colors.textMuted }}> / {qty(p.originalQty)}</span></span> : qty(p.qty)}</td><td className="num">{money(p.marginUsd)}</td><td className={`num ${Number(p.pnlUsd) >= 0 ? "positive" : "negative"}`}><FlashValue value={p.pnlUsd ?? null}>{signedMoney(p.pnlUsd)}</FlashValue>{p.lifecycle === "PARTIALLY_CLOSED" && <span style={{ color: colors.textMuted }} title="Realisasi TP1 (tercatat saat fill) · dipisahkan dari PnL mengambang">{` ⌁${signedMoney(p.realizedPnlUsd)}`}</span>}</td><td className={`num ${Number(p.pnlPct) >= 0 ? "positive" : "negative"}`}><FlashValue value={p.pnlPct ?? null}>{pct(p.pnlPct)}</FlashValue></td><td className="num">{fmt(p.pnlR, 2)}</td></tr>)}</tbody></table> : <div className="ledger-empty">Tidak ada posisi terbuka. Data ini berasal dari /api/positions?status=OPEN.</div>)}
          {tab === "PENDING" && (bundle.pending.length ? <table className="workspace-table"><thead><tr><th>Record</th><th>Symbol</th><th>Side</th><th>Status</th></tr></thead><tbody>{bundle.pending.map((p) => <tr key={p.id}><td>#{p.id}</td><td>{p.symbol}</td><td>{p.side}</td><td>{p.status ?? "PENDING"}</td></tr>)}</tbody></table> : <div className="ledger-empty">Tidak ada pending/reservation pada endpoint read-only saat ini. Slot yang dipakai tetap dihitung oleh engine.</div>)}
          {tab === "FILLS" && (tradeRows.length ? <table className="workspace-table"><thead><tr><th>Trade</th><th>Symbol</th><th>Strategy</th><th>Side</th><th className="num">PnL $</th><th className="num">R</th><th className="num">Fee</th><th className="num">Funding</th><th>Exit</th><th>Closed</th></tr></thead><tbody>{tradeRows.slice(0, 40).map((t) => <tr key={t.id}><td>#{t.id}</td><td>{t.symbol}</td><td>{strategyLabel(t.strategyId)}</td><td>{t.side}</td><td className={`num ${Number(t.pnlUsd) >= 0 ? "positive" : "negative"}`}>{signedMoney(t.pnlUsd)}</td><td className="num">{fmt(t.rMultiple, 2)}</td><td className="num">{money(t.feeUsd)}</td><td className="num">{signedMoney(t.fundingUsd)}</td><td>{t.exitReason ?? "·"}</td><td>{new Date(t.closedAt ?? t.createdAt ?? "").toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</td></tr>)}</tbody></table> : <div className="ledger-empty">Belum ada fill/trade SWING pada ledger yang dapat ditampilkan.</div>)}
          {tab === "KEPUTUSAN" && (signalRows.length ? <table className="workspace-table"><thead><tr><th>Time</th><th>Symbol</th><th>Strategy</th><th>Side</th><th>Decision</th><th>Reason</th></tr></thead><tbody>{signalRows.slice(0, 40).map((s) => <tr key={s.id}><td>{new Date(s.createdAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })}</td><td>{s.symbol}</td><td>{strategyLabel(s.strategyId)}</td><td>{s.side}</td><td>{s.decision}</td><td className="reason-cell">{s.reason ?? "·"}</td></tr>)}</tbody></table> : <div className="ledger-empty">Tidak ada keputusan sinyal SWING pada tape saat ini. Empty state valid; bukan status entry.</div>)}
          {tab === "EVENT JOURNAL" && (bundle.loop?.loop?.runs?.length ? <table className="workspace-table"><thead><tr><th>Run</th><th>Strategy</th><th>State</th><th>Trigger</th><th>Updated</th><th>Error</th></tr></thead><tbody>{bundle.loop.loop.runs.slice(0, 20).map((r) => <tr key={r.runId}><td className="mono tiny">{r.runId.slice(0, 14)}…</td><td>{strategyLabel(r.strategyId)}</td><td>{statusLabel(r.state)}</td><td>{r.triggerReason ?? r.trigger ?? "·"}</td><td>{age(r.updatedAt)} ago</td><td className="reason-cell">{r.lastError ?? "·"}</td></tr>)}</tbody></table> : <div className="ledger-empty">Belum ada run evaluasi pada journal.</div>)}
          {tab === "MARKET PULSE" && (
            <div className="pulse-grid">
              <section className="pulse-block"><header><b>TOP GAINERS · 24H</b><span>{(topGainers.filter((m)=>m.live).length)}/{topGainers.length} LIVE</span></header>
                <table className="workspace-table"><thead><tr><th>Symbol</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">Vol 24H</th><th>Dir</th></tr></thead>
                <tbody>{topGainers.map((m) => pulseRow(m))}</tbody></table>
              </section>
              <section className="pulse-block"><header><b>TOP LOSERS · 24H</b><span>{(topLosers.filter((m)=>m.live).length)}/{topLosers.length} LIVE</span></header>
                <table className="workspace-table"><thead><tr><th>Symbol</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">Vol 24H</th><th>Dir</th></tr></thead>
                <tbody>{topLosers.map((m) => pulseRow(m))}</tbody></table>
              </section>
              <section className="pulse-block"><header><b>TOP VOLUME · 24H</b><span>USD</span></header>
                <table className="workspace-table"><thead><tr><th>Symbol</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">Vol 24H</th><th>Dir</th></tr></thead>
                <tbody>{topVol.map((m) => pulseRow(m))}</tbody></table>
              </section>
              <section className="pulse-block"><header><b>TOP FUNDING · LONG BIAS</b><span>{topFunding.length} dgn data</span></header>
                {topFunding.length ? (
                <table className="workspace-table"><thead><tr><th>Symbol</th><th className="num">Funding 8H</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">Vol 24H</th></tr></thead>
                <tbody>{topFunding.map((m) => (
                  <tr key={m.symbol} onClick={() => selectSymbol(m.symbol)} className={`${m.live ? "live" : "stale"}${rowFlash[m.symbol] ? ` ${rowFlash[m.symbol]}` : ""}`}>
                    <td><b>{m.symbol}</b></td>
                    <td className={`num ${Number(m.funding) >= 0 ? "positive" : "negative"}`}>{(Number(m.funding) * 100).toFixed(4)}%</td>
                    <td className="num">{m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className={`num ${m.chg >= 0 ? "positive" : "negative"}`}>{m.chg >= 0 ? "+" : ""}{m.chg.toFixed(2)}%</td>
                    <td className="num">{usdFull(m.vol)}</td>
                  </tr>
                ))}</tbody></table>
                ) : <div className="ledger-empty">Belum ada funding rate live untuk simbol yang disubscribe.</div>}
              </section>
              <section className="pulse-block"><header><b>TOP FUNDING · SHORT BIAS</b><span>{topFundingShort.length} dgn data</span></header>
                {topFundingShort.length ? (
                <table className="workspace-table"><thead><tr><th>Symbol</th><th className="num">Funding 8H</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">Vol 24H</th></tr></thead>
                <tbody>{topFundingShort.map((m) => (
                  <tr key={m.symbol} onClick={() => selectSymbol(m.symbol)} className={`${m.live ? "live" : "stale"}${rowFlash[m.symbol] ? ` ${rowFlash[m.symbol]}` : ""}`}>
                    <td><b>{m.symbol}</b></td>
                    <td className={`num ${Number(m.funding) >= 0 ? "positive" : "negative"}`}>{(Number(m.funding) * 100).toFixed(4)}%</td>
                    <td className="num">{m.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td className={`num ${m.chg >= 0 ? "positive" : "negative"}`}>{m.chg >= 0 ? "+" : ""}{m.chg.toFixed(2)}%</td>
                    <td className="num">{usdFull(m.vol)}</td>
                  </tr>
                ))}</tbody></table>
                ) : <div className="ledger-empty">Belum ada funding rate live untuk simbol yang disubscribe.</div>}
              </section>
              <section className="pulse-block"><header><b>OPEN POSISI · AKTIF</b><span>mark WS 1s · fallback hub</span></header>
                <table className="workspace-table"><thead><tr><th>Symbol</th><th>Side</th><th className="num">Mark</th><th className="num">24H %</th><th className="num">PnL</th></tr></thead>
                <tbody>{positionRows.slice(0, 10).map((p) => { const t = liveTickers.get(p.symbol); const chg = Number(t?.chg24hPct ?? 0); return (
                  <tr key={p.id} onClick={() => selectSymbol(p.symbol)} className={`${t?.live ? "live" : "stale"}${rowFlash[p.symbol] ? ` ${rowFlash[p.symbol]}` : ""}`}>
                    <td><b>{p.symbol}</b><small>#{p.id}</small></td>
                    <td className={p.side === "LONG" ? "positive" : "negative"}>{p.side}</td>
                    <td className="num">{price(p.markPrice, p)}</td>
                    <td className={`num ${chg >= 0 ? "positive" : "negative"}`}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</td>
                    <td className={`num ${Number(p.pnlUsd) >= 0 ? "positive" : "negative"}`}><FlashValue value={p.pnlUsd ?? null}>{signedMoney(p.pnlUsd)}</FlashValue></td>
                  </tr>
                );})}</tbody></table>
              </section>
            </div>
          )}
          {tab === "ANALISIS ALIRAN" && <AnalysisPanel />}
        </div>
        <div className="ledger-foot"><span>SUMBER: overview, positions, swing signals, trades, swing-eval-loop · READ ONLY</span><span>{bundle.errors.length ? `PARTIAL: ${bundle.errors.join(" · ")}` : "SEMUA SUMBER MERESPONS"}</span></div>
      </section>

      <div className="workspace-statusbar"><span><b>READ-ONLY</b> · public Binance klines · visual indicators only</span><span>LIVE: akses dinonaktifkan pada workspace ini</span><span>Chart positions are engine levels, not order controls</span></div>
    </div>
  );
}
