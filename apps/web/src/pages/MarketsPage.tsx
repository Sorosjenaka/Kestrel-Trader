// apps/web/src/pages/MarketsPage.tsx
// Real-Time Binance Futures Top 20 Gainers & Top 20 Losers + Live Market Scanner Dashboard.
// Tahap 3 redesign Tema B "X / ink": toolbar judul mono uppercase + pill status
// cyan, ribbon metrik mono, segmented switch gaya prototype `.seg`.
//
// TIDAK DIUBAH (semantik & wiring): polling SSE/fetch, interval, endpoint,
// handler bot start/stop/trigger-step, logika ApplyLive, symbol list.
import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { binanceWs } from "../lib/binanceWs";
import { colors, fonts, card } from "../theme.js";
import { Btn } from "../components/ui.js";
import { TopMoversTable, TopMoverItem } from "../components/TopMoversTable";
import { ScannerCandidatesTable, type CandidateItem } from "../components/ScannerCandidatesTable";
import { apiFetch } from "../lib/api.js";

export type TopMover = TopMoverItem;
export type { CandidateItem };

export interface ScanView {
  candidates: CandidateItem[];
  scan: {
    cycleMs: number;
    pairs: number;
    concurrency: number;
    refreshedAt: string | number | null;
    p95CycleMs?: number;
    p95PerSymbolMs?: number;
    mode: "SCALP" | "SWING";
    nfr01Compliant: boolean;
  };
}

export interface BotStatusInfo {
  isRunning: boolean;
  cycleCount: number;
  openPositionsCount: number;
  slotFill?: { target: number; empty: number; filterReadyCandidates: number; scanFresh: boolean; state: string };
  stats: {
    tradesOpened: number;
    tradesClosed: number;
    tp1Hits: number;
    tp2Hits: number;
    slHits: number;
    learningsCompleted: number;
    totalScans: number;
  };
}

const slotStateLabel: Record<string, string> = {
  FULL: "Penuh", BOT_STOPPED: "Bot berhenti", DISARMED: "ARM mati",
  WAIT_FRESH_SCAN: "Menunggu scan segar", WAIT_VALID_SETUP: "Menunggu setup valid",
  EVALUATING_FILTERED_CANDIDATES: "Menilai kandidat",
};

const VIEW_MODES = [
  { key: "dual", label: "DUAL 20/20" },
  { key: "gainers", label: "TOP GAINERS" },
  { key: "losers", label: "TOP LOSERS" },
] as const;

export function MarketsPage() {
  const [viewMode, setViewMode] = useState<"dual" | "gainers" | "losers">("dual");
  const [filterAll, setFilterAll] = useState<boolean>(false);
  const [gainers, setGainers] = useState<TopMoverItem[]>([]);
  const [losers, setLosers] = useState<TopMoverItem[]>([]);
  const [scanView, setScanView] = useState<ScanView | null>(null);
  const [botStatus, setBotStatus] = useState<BotStatusInfo | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());
  const [totalUniverse, setTotalUniverse] = useState<number>(770);
  const [filteredUniverse, setFilteredUniverse] = useState<number>(0);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isTriggeringScan, setIsTriggeringScan] = useState<boolean>(false);

  const prevPricesRef = useRef<Map<string, number>>(new Map());
  const [priceFlash, setPriceFlash] = useState<Record<string, "flash-up" | "flash-down">>({});
  // Live mark price per-detik via Binance combined WS (1 koneksi untuk semua simbol tampil).
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [liveWsCount, setLiveWsCount] = useState<number>(0);

  const triggerFlash = useCallback((sym: string, currentPrice: number) => {
    const prev = prevPricesRef.current.get(sym);
    if (prev !== undefined && prev !== currentPrice) {
      const cls = currentPrice > prev ? "flash-up" : "flash-down";
      setPriceFlash((old) => ({ ...old, [sym]: cls }));
      setTimeout(() => {
        setPriceFlash((old) => {
          const next = { ...old };
          delete next[sym];
          return next;
        });
      }, 700);
    }
    prevPricesRef.current.set(sym, currentPrice);
  }, []);

  const updateTickers = useCallback((gList: TopMoverItem[], lList: TopMoverItem[]) => {
    gList.forEach((m) => triggerFlash(m.symbol, m.price));
    lList.forEach((m) => triggerFlash(m.symbol, m.price));
    setGainers(gList);
    setLosers(lList);
  }, [triggerFlash]);

  const fetchBotStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/bot/status");
      if (res.ok) setBotStatus(await res.json());
    } catch {}
  }, []);

  const handleToggleBot = async () => {
    try {
      const endpoint = botStatus?.isRunning ? "/api/bot/stop" : "/api/bot/start";
      const res = await apiFetch(endpoint, { method: "POST" });
      if (res.ok) fetchBotStatus();
    } catch {}
  };

  const handleTriggerStep = async () => {
    setIsTriggeringScan(true);
    try {
      await apiFetch("/api/bot/trigger-step", { method: "POST" });
      await fetchMarketsDirect();
      await fetchBotStatus();
    } catch {} finally {
      setIsTriggeringScan(false);
    }
  };

  const fetchMarketsDirect = useCallback(async () => {
    try {
      const [topRes, scanRes] = await Promise.allSettled([
        fetch(`/api/markets/top?limit=100&all=${filterAll ? "true" : "false"}`),
        fetch("/api/markets/scan"),
      ]);
      if (topRes.status === "fulfilled" && topRes.value.ok) {
        const data = await topRes.value.json();
        if (Array.isArray(data.gainers) && Array.isArray(data.losers)) {
          updateTickers(data.gainers, data.losers);
          setRefreshedAt(data.refreshedAt || Date.now());
          if (data.totalUniverse) setTotalUniverse(data.totalUniverse);
          if (data.filteredUniverse) setFilteredUniverse(data.filteredUniverse);
        }
      }
      if (scanRes.status === "fulfilled" && scanRes.value.ok) {
        setScanView(await scanRes.value.json());
      }
    } catch {}
  }, [filterAll, updateTickers]);

  useEffect(() => {
    let sse: EventSource | null = null;
    let fallbackTimer: NodeJS.Timeout | null = null;
    try {
      sse = new EventSource(`/api/markets/stream?all=${filterAll ? "true" : "false"}`);
      sse.onopen = () => setIsStreaming(true);
      sse.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.gainers && payload.losers) {
            updateTickers(payload.gainers, payload.losers);
            setRefreshedAt(payload.refreshedAt || Date.now());
            if (payload.totalUniverse) setTotalUniverse(payload.totalUniverse);
            if (payload.filteredUniverse) setFilteredUniverse(payload.filteredUniverse);
          }
          if (payload.scan) setScanView(payload.scan);
        } catch {}
      };
      sse.onerror = () => {
        setIsStreaming(false);
        if (!fallbackTimer) fallbackTimer = setInterval(fetchMarketsDirect, 1500);
      };
    } catch {
      setIsStreaming(false);
      fallbackTimer = setInterval(fetchMarketsDirect, 1500);
    }
    fetchMarketsDirect();
    fetchBotStatus();
    const botTimer = setInterval(fetchBotStatus, 3000);
    return () => {
      if (sse) sse.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
      clearInterval(botTimer);
    };
  }, [filterAll, fetchMarketsDirect, fetchBotStatus, updateTickers]);

  // Live overlay: subscribe SEMUA pair universe ke hub harga backend (1 SSE).
  // 23 Okt 2026: sebelumnya hanya 60 symbol pertama yang di-subscribe, jadi
  // pair yang tidak masuk top-40 TIDAK pernah updating real-time. Backend hub
  // sudah memegang WS mark-price untuk ~500 simbol, jadi subscribe penuh itu
  // murah, 1 koneksi bukan N.
  const liveSymbolsKey = useMemo(() => {
    const set = new Set<string>();
    gainers.forEach((m) => set.add(m.symbol));
    losers.forEach((m) => set.add(m.symbol));
    // Pair kandidat scanner juga ikut updating: biasanya tidak di top-40 tapi
    // operator tetap butuh geraknya saat memilih pair.
    (scanView?.candidates ?? []).forEach((c) => { if (c.symbol) set.add(c.symbol); });
    return Array.from(set).filter(Boolean).sort().join(",");
  }, [gainers, losers, scanView]);

  useEffect(() => {
    const syms = liveSymbolsKey.split(",").filter(Boolean);
    if (syms.length === 0) return;
    const unsub = binanceWs.subscribeMulti(syms, (map) => {
      const next: Record<string, number> = {};
      map.forEach((t, sym) => {
        if (t.markPrice > 0) {
          next[sym] = t.markPrice;
          triggerFlash(sym, t.markPrice);
        }
      });
      setLiveWsCount(map.size);
      setLivePrices((prev) => {
        let same = Object.keys(next).length === Object.keys(prev).length;
        if (same) {
          for (const k of Object.keys(next)) {
            if (prev[k] !== next[k]) {
              same = false;
              break;
            }
          }
        }
        return same ? prev : next;
      });
    });
    return () => unsub();
  }, [liveSymbolsKey, triggerFlash]);

  // Terapkan harga live ke baris tabel (urutan ranking tidak diubah per tick).
  const applyLive = useCallback(
    (list: TopMoverItem[]): TopMoverItem[] =>
      list.map((m) => {
        const live = livePrices[m.symbol];
        if (!live || live <= 0 || live === m.price) return m;
        const open = m.price > 0 ? m.price / (1 + m.chg24hPct / 100) : live;
        const liveChg = open > 0 ? ((live - open) / open) * 100 : m.chg24hPct;
        return { ...m, price: live, chg24hPct: Number(liveChg.toFixed(2)) };
      }),
    [livePrices]
  );

  const liveGainers = useMemo(() => applyLive(gainers), [applyLive, gainers]);
  const liveLosers = useMemo(() => applyLive(losers), [applyLive, losers]);

  const handleTrade = (sym: string) => {
    localStorage.setItem("privatetrade_selected_symbol", sym);
    window.location.hash = `#/terminal?symbol=${sym}`;
  };

  // Tema B: cyan = state aktif/informasi (bukan hijau).
  const streamColor = isStreaming ? colors.up : colors.warn;
  const statusDot = (
    <span
      style={{
        width: 6, height: 6, borderRadius: "50%", display: "inline-block",
        background: streamColor,
        boxShadow: isStreaming ? `0 0 6px ${colors.up}` : undefined,
      }}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 1. Header Toolbar: judul mono uppercase + pill status cyan */}
      <div style={{ ...card, padding: "11px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: fonts.mono, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.16em",
                textTransform: "uppercase", color: colors.textStrong, whiteSpace: "nowrap",
              }}
            >
              BINANCE FUTURES MARKET &amp; SCANNER DASHBOARD
            </span>
            <span
              style={{
                fontSize: 10, fontFamily: fonts.mono, fontWeight: 500, letterSpacing: "0.12em",
                padding: "3px 8px", borderRadius: 2, textTransform: "uppercase",
                background: "transparent", border: `1px solid ${isStreaming ? colors.up : colors.borderLight}`,
                color: isStreaming ? colors.up : colors.textMuted,
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
              }}
            >
              {statusDot}
              {isStreaming ? "REAL-TIME STREAMING (0ms)" : "FAST REST (1.5s)"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, marginTop: 5, letterSpacing: "0.04em" }}>
            Universe: {totalUniverse} Pasangan Binance USDT Perp · Volume Lolos: {filteredUniverse} Pair · Diperbarui:{" "}
            {new Date(refreshedAt).toLocaleTimeString()}
            {liveWsCount > 0 && (
              <span style={{ marginLeft: 8, color: colors.up, fontWeight: 700 }}>
                ● LIVE 1s ({liveWsCount} sym)
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Segmented view-mode switch, gaya prototype `.seg`:
              aktif = border + teks cyan, non-aktif netral, pemisah hairline. */}
          <div style={{ display: "inline-flex", border: `1px solid ${colors.borderLight}`, borderRadius: 2 }}>
            {VIEW_MODES.map((m, i) => {
              const active = viewMode === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => setViewMode(m.key)}
                  style={{
                    fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
                    padding: "5px 10px", cursor: "pointer",
                    background: active ? colors.upBg : "transparent",
                    color: active ? colors.up : colors.textMuted,
                    border: `1px solid ${active ? colors.up : "transparent"}`,
                    borderRadius: 0,
                    borderRight: i === VIEW_MODES.length - 1 ? "none" : `1px solid ${colors.borderLight}`,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: colors.text, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={filterAll}
              onChange={(e) => setFilterAll(e.target.checked)}
              style={{ accentColor: colors.up }}
            />
            <span>Semua Volume (&lt;$7M)</span>
          </label>

          <Btn onClick={handleTriggerStep} disabled={isTriggeringScan} tone="primary">
            {isTriggeringScan ? "SCANNING..." : "SCAN SEKARANG"}
          </Btn>

          <Btn onClick={handleToggleBot} tone={botStatus?.isRunning ? "default" : "danger"}>
            {botStatus?.isRunning ? "AUTO BOT: ACTIVE" : "AUTO BOT: PAUSED"}
          </Btn>
        </div>
      </div>

      {/* 2. Metrics Ribbon: label mono uppercase + nilai token */}
      <div
        style={{
          ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))",
          gap: 1, background: colors.border, overflow: "hidden",
        }}
      >
        <Metric label="WORKER POOL" value={`${scanView?.scan.concurrency || 50} CONCURRENT`} color={colors.text} />
        <Metric label="DURASI SCAN" value={`${scanView?.scan.cycleMs || 0}ms`} color={colors.up} />
        <Metric label="P95 LATENCY" value={`${scanView?.scan.p95PerSymbolMs || 0}ms/pair`} color={colors.warn} />
        <Metric label="SLA NFR-01" value={scanView ? (scanView.scan.nfr01Compliant ? "LULUS ≤90s" : "BELUM LULUS") : "BELUM TERUKUR"} color={scanView?.scan.nfr01Compliant ? colors.up : colors.warn} />
        {botStatus && (
          <>
            <Metric label="SLOT" value={`${botStatus.openPositionsCount}/${botStatus.slotFill?.target ?? 20}`} color={colors.text} />
            <Metric
              label="ISI SLOT"
              value={`${slotStateLabel[botStatus.slotFill?.state ?? ""] ?? "Memuat"} (${botStatus.slotFill?.filterReadyCandidates ?? 0} kandidat)`}
              color={colors.warn}
            />
            <Metric label="TRADES DIBUKA" value={`${botStatus.stats.tradesOpened}`} color={colors.accent} />
            <Metric label="TP HITS (single target)" value={`${botStatus.stats.tp1Hits + botStatus.stats.tp2Hits}`} color={colors.up} />
            <Metric label="JURNAL EVALUASI" value={`${botStatus.stats.learningsCompleted} TERCATAT`} color={colors.purple} />
          </>
        )}
      </div>

      {/* 3. Top 20 Gainers & Losers Tables */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        {(viewMode === "dual" || viewMode === "gainers") && (
          <TopMoversTable title="TOP 20 GAINERS (24H)" type="gainers" list={liveGainers} priceFlash={priceFlash} onTrade={handleTrade} />
        )}
        {(viewMode === "dual" || viewMode === "losers") && (
          <TopMoversTable title="TOP 20 LOSERS (24H)" type="losers" list={liveLosers} priceFlash={priceFlash} onTrade={handleTrade} />
        )}
      </div>
      <ScannerCandidatesTable candidates={scanView?.candidates ?? []} onTrade={handleTrade} />
    </div>
  );
}

/** Satu metrik di ribbon: label mono uppercase + nilai mono berwarna (token). */
function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: colors.card, padding: "9px 12px", minWidth: 0 }}>
      <div
        style={{
          fontFamily: fonts.mono, fontSize: 9, fontWeight: 500, letterSpacing: "0.14em",
          textTransform: "uppercase", color: colors.textDim,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: fonts.mono, fontSize: 14, fontWeight: 700, color, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {value}
      </div>
    </div>
  );
}