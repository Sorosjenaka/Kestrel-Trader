// apps/web/src/pages/TradingTerminalPage.tsx
// Trading Terminal dengan TradingView Chart, Binance Futures Live WebSocket, dan
// Full Pair Selector Modal. UI digaya ulang ke design system "ArtaTrade Terminal"
// (TradingView dark) — logika tidak berubah.
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { binanceWs, isFreshTicker, LiveTicker } from "../lib/binanceWs";
import { shutdownTerminal } from "../lib/terminalActions";
import { enabledTradingModes, resolveTradingMode, type TradingMode } from "../lib/modePresentation";
import { CryptoIcon } from "../components/CryptoIcon";
import { TradingViewEmbed } from "../components/TradingViewEmbed";
import type { TvSignalOverlay, PositionOverlayView } from "../components/NativeQuantChart";
import { PairSelectorModal } from "../components/PairSelectorModal";
import { colors } from "../theme.js";
import { apiFetch } from "../lib/api.js";

export interface PairItem {
  symbol: string;
  name: string;
  cat: string;
  price?: number;
  chg24h?: number;
  vol24hUsd?: number;
  eligible?: boolean;
  high24h?: number;
  low24h?: number;
}

export const DEFAULT_PAIRS: PairItem[] = [
  { symbol: "BTCUSDT", name: "Bitcoin", cat: "MAJOR" },
  { symbol: "ETHUSDT", name: "Ethereum", cat: "MAJOR" },
  { symbol: "SOLUSDT", name: "Solana", cat: "LAYER 1" },
  { symbol: "BNBUSDT", name: "BNB", cat: "MAJOR" },
  { symbol: "DOGEUSDT", name: "Dogecoin", cat: "MEME" },
  { symbol: "XRPUSDT", name: "Ripple", cat: "MAJOR" },
  { symbol: "SUIUSDT", name: "Sui Network", cat: "LAYER 1" },
  { symbol: "PEPEUSDT", name: "Pepe Coin", cat: "MEME" },
  { symbol: "WIFUSDT", name: "dogwifhat", cat: "MEME" },
  { symbol: "NEARUSDT", name: "NEAR Protocol", cat: "LAYER 1" },
  { symbol: "AVAXUSDT", name: "Avalanche", cat: "LAYER 1" },
  { symbol: "LINKUSDT", name: "Chainlink", cat: "DEFI" },
  { symbol: "RENDERUSDT", name: "Render", cat: "AI" },
  { symbol: "FETUSDT", name: "Artificial Superintelligence", cat: "AI" },
  { symbol: "AAVEUSDT", name: "Aave", cat: "DEFI" },
  { symbol: "ARBUSDT", name: "Arbitrum", cat: "LAYER 1" },
  { symbol: "OPUSDT", name: "Optimism", cat: "LAYER 1" },
  { symbol: "TIAUSDT", name: "Celestia", cat: "LAYER 1" },
  { symbol: "TAOUSDT", name: "Bittensor", cat: "AI" },
  { symbol: "INJUSDT", name: "Injective", cat: "DEFI" },
  { symbol: "RUNEUSDT", name: "THORChain", cat: "DEFI" },
  { symbol: "MATICUSDT", name: "Polygon", cat: "LAYER 1" },
  { symbol: "ADAUSDT", name: "Cardano", cat: "LAYER 1" },
  { symbol: "DOTUSDT", name: "Polkadot", cat: "LAYER 1" },
  { symbol: "TRUMPUSDT", name: "MAGA", cat: "MEME" },
  { symbol: "SEIUSDT", name: "Sei", cat: "LAYER 1" },
  { symbol: "BONKUSDT", name: "Bonk", cat: "MEME" },
  { symbol: "FLOKIUSDT", name: "Floki", cat: "MEME" },
  { symbol: "1000PEPEUSDT", name: "1000 PEPE", cat: "MEME" },
  { symbol: "1000BONKUSDT", name: "1000 BONK", cat: "MEME" },
  { symbol: "1000SHIBUSDT", name: "1000 SHIB", cat: "MEME" },
];

export interface ActiveTerminalPosition {
  id: number;
  symbol: string;
  side: "LONG" | "SHORT";
  mode: "SWING" | "SCALP";
  entryPrice: number;
  markPrice: number;
  qty: number;
  leverage: number;
  marginUsd: number;
  slPrice: number;
  tp1Price: number;
  originalSlPrice?: number | null;
  originalRiskUsd?: number | null;
  originalQty?: number | null;
  beMoved: boolean;
  tp1Filled: boolean;
  realizedPnlUsd: number;
  openedAt: number;
  agentSource: string;
  confluenceScore: number | null;
  statusText: string;
  liqPrice?: number;
}

export function TradingTerminalPage() {
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const [ticker, setTicker] = useState<LiveTicker>(binanceWs.getCurrentTicker());
  const [timeframe, setTimeframe] = useState("15");
  const leverage = 25;
  const [preferredMode, setPreferredMode] = useState<string | null>(() => {
    try { return localStorage.getItem("terminalTradingMode"); } catch { return null; }
  });
  const [allowedModes, setAllowedModes] = useState<TradingMode[]>([]);
  const tradeMode = resolveTradingMode(preferredMode, allowedModes);
  const [manualSwingSl, setManualSwingSl] = useState("");
  useEffect(() => { setManualSwingSl(""); }, [selectedSymbol, tradeMode]);
  useEffect(() => {
    if (tradeMode) {
      try { localStorage.setItem("terminalTradingMode", tradeMode); } catch { /* Storage may be disabled. */ }
    }
  }, [tradeMode]);
  const [allPairs, setAllPairs] = useState<PairItem[]>(DEFAULT_PAIRS);
  const [minVolumeUsd, setMinVolumeUsd] = useState(7_000_000);
  const [autoAgentTrading, setAutoAgentTrading] = useState(false);
  const [turuAlert, setTuruAlert] = useState(false);
  const [shutdownBusy, setShutdownBusy] = useState(false);
  const [shutdownError, setShutdownError] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pair Selector Modal State
  const [isPairModalOpen, setIsPairModalOpen] = useState(false);
  const [modalSearch, setModalSearch] = useState("");
  const [modalCategory, setModalCategory] = useState<string>("ALL");
  const [modalSortBy, setModalSortBy] = useState<"vol" | "chg" | "price" | "name">("vol");

  // Multi-slot active positions (PAPER capacity 20) - Single source of truth from SQLite database
  const [MAX_SLOTS, setMaxSlots] = useState(20);
  const [positions, setPositions] = useState<ActiveTerminalPosition[]>([]);
  // Live mark price semua simbol (posisi + selected) — update tanpa klik.
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const livePricesRef = useRef<Record<string, number>>({});
  livePricesRef.current = livePrices;

  // Fetch open positions from backend database (persisted real positions)
  // PENTING: jangan timpa markPrice live dengan entryPrice saat refetch (penyebab flicker $0).
  const fetchOpenPositions = useCallback(async () => {
    try {
      const res = await fetch("/api/positions?status=OPEN");
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.positions)) {
          const live = livePricesRef.current;
          const mapped: ActiveTerminalPosition[] = data.positions.map((p: any) => ({
            id: p.id,
            symbol: p.symbol,
            side: p.side as "LONG" | "SHORT",
            mode: p.mode as "SCALP" | "SWING",
            entryPrice: p.entryPrice,
            markPrice: live[p.symbol] && live[p.symbol] > 0 ? live[p.symbol] : Number(p.markPrice) || p.entryPrice,
            qty: p.qty,
            leverage: p.leverage || 25,
            marginUsd: p.marginUsd || (p.notional ? p.notional / (p.leverage || 25) : 4.0),
            slPrice: p.slPrice,
            tp1Price: p.tp1Price,
            originalSlPrice: p.originalSlPrice ?? null,
            originalRiskUsd: Number(p.originalRiskUsd) || null,
            originalQty: Number(p.originalQty) || null,
            beMoved: Boolean(p.beMoved),
            tp1Filled: Boolean(p.tp1FilledAt),
            realizedPnlUsd: Number(p.realizedPnlUsd) || 0,
            openedAt: new Date(p.openedAt).getTime(),
            agentSource: p.outlookText || "AI Confluence Engine",
            confluenceScore: Number.isFinite(p.score) ? p.score : null,
            statusText: p.tp1FilledAt ? "TP1 TEREALISASI" : "AKTIF • MENUNGGU TP",
            // 15 Okt 2026: liq CROSS dari server (equity-aware); tanpa ini UI
            // fallback ke rumus isolated (bug #3177).
            liqPrice: p.liqPrice != null ? Number(p.liqPrice) : undefined,
          }));
          setPositions((prev) => {
            // Pertahankan markPrice live yang sudah ada agar tidak kedip ke entry.
            const prevMark = new Map(prev.map((x) => [x.symbol + "#" + x.id, x.markPrice]));
            return mapped.map((m) => {
              const k = m.symbol + "#" + m.id;
              const kept = prevMark.get(k);
              return kept && kept > 0 ? { ...m, markPrice: kept } : m;
            });
          });
        }
      }
    } catch (e) {
      console.error("Gagal sinkron posisi database:", e);
    }
  }, []);

  // Poll database open positions on mount and every 2.5 seconds
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetchOpenPositions();
    const interval = setInterval(fetchOpenPositions, 2500);
    return () => clearInterval(interval);
  }, [fetchOpenPositions]);

  // 8 Okt 2026 (permintaan operator): prediksi posisi BUY/SELL otomatis dari
  // sinyal technical rating TradingView + level entry/SL/TP (ATR, model ArtaTrade).
  const [tvPred, setTvPred] = useState<TvSignalOverlay | null>(null);
  // Part A: overlay Trade Manager — state posisi terkonfirmasi (idempoten per positionId).
  const [posOverlay, setPosOverlay] = useState<PositionOverlayView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/positions/overlay")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive || !d || !Array.isArray(d.positions)) return;
          const mine = d.positions.find((p: PositionOverlayView) => p.symbol === selectedSymbol);
          setPosOverlay(mine ?? null);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol, positions.length]);
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const tfMap: Record<string, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", "240": "4h", D: "1d" };
    // 8 Okt 2026: retry 5 dtk sampai prediksi masuk (gagal sekali tidak nyangkut
    // sampai siklus 60 dtk berikutnya), lalu refresh tiap 60 dtk.
    const load = (isRetry = false) =>
      fetch(`/api/tv/signal?symbol=${encodeURIComponent(selectedSymbol)}&interval=${tfMap[timeframe] ?? "15m"}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive) return;
          if (d && d.symbol) setTvPred(d as TvSignalOverlay);
          else if (isRetry) retryTimer = setTimeout(() => load(true), 5000);
        })
        .catch(() => {
          if (alive && isRetry) retryTimer = setTimeout(() => load(true), 5000);
        });
    load(true);
    const id = setInterval(() => load(false), 60_000);
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(id);
    };
  }, [selectedSymbol, timeframe]);

  // Close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isPairModalOpen) {
        setIsPairModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPairModalOpen]);

  // Load ALL Binance Futures pairs from backend (770+ active USDT perp contracts)
  useEffect(() => {
    fetch("/api/binance/pairs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.pairs) && d.pairs.length > 0) {
          const apiVolumeFloor = Number(d.minVolumeUsd);
          if (Number.isFinite(apiVolumeFloor) && apiVolumeFloor > 0) setMinVolumeUsd(apiVolumeFloor);
          const mapped: PairItem[] = d.pairs.map((p: any) => ({
            symbol: p.symbol,
            name: p.baseAsset,
            cat: p.category,
            price: p.price,
            chg24h: p.chg24h,
            vol24hUsd: p.vol24hUsd,
            eligible: Number(p.vol24hUsd) > (Number.isFinite(apiVolumeFloor) && apiVolumeFloor > 0 ? apiVolumeFloor : 7_000_000),
            high24h: p.high24h,
            low24h: p.low24h,
          }));
          setAllPairs(mapped);
        }
      })
      .catch(() => {});
  }, []);

  // Subscribe to real-time Binance Futures WebSocket
  useEffect(() => {
    const unsub = binanceWs.subscribe(selectedSymbol, (t) => {
      setTicker({ ...t });
    });
    return () => unsub();
  }, [selectedSymbol]);

  // Open Binance Futures external website in a new tab
  const openBinanceFuturesWeb = (sym: string = selectedSymbol) => {
    const url = `https://www.binance.com/en/futures/${sym}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Open a real, persisted position in database and exchange
  const openRealPosition = async (sym: string, side: "LONG" | "SHORT") => {
    if (isSubmitting) return;
    if (!tradeMode) {
      alert("Mode trading aktif belum tersedia dari server.");
      return;
    }
    if (executionMode !== "PAPER") {
      alert("Entry manual hanya tersedia di mode simulasi. ARM LIVE tetap terkunci.");
      return;
    }
    if (positions.length >= MAX_SLOTS) {
      alert(`Maksimal ${MAX_SLOTS} posisi aktif tercapai. Silakan tutup posisi sebelum membuka yang baru.`);
      return;
    }
    if (positions.some((p) => p.symbol === sym)) {
      alert(`Posisi ${sym} sudah terbuka di terminal.`);
      return;
    }

    setIsSubmitting(true);
    try {
      let curPrice = 0;
      // Request a fresh quote; cached display values never authorize an entry.
      {
        try {
          const r = await fetch(`/api/binance/ticker?symbol=${encodeURIComponent(sym)}`);
          if (r.ok) {
            const d = await r.json();
            if (d.live === true && Date.now() - Number(d.lastUpdated) <= 5000) {
              curPrice = Number(d.markPrice) || Number(d.lastPrice) || 0;
            }
          }
        } catch {}
      }
      if (!curPrice) {
        alert(`Harga live ${sym} tidak tersedia · entry dibatalkan agar tidak pakai harga basi.`);
        return;
      }

      const structuralSl = tradeMode === "SWING" ? Number(manualSwingSl) : undefined;
      if (tradeMode === "SWING" && (!Number.isFinite(structuralSl) || structuralSl! <= 0 ||
          (side === "LONG" ? structuralSl! >= curPrice : structuralSl! <= curPrice))) {
        alert("Isi harga SL struktural SWING yang valid: di bawah entry LONG atau di atas entry SHORT.");
        return;
      }

      // Matematika margin dihitung server-side (resolveMarginPolicy):
      // SWING: SL struktural eksplisit dan plafon margin $2; seluruh gate tetap di server.
      const res = await apiFetch("/api/positions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: sym,
          side,
          mode: tradeMode,
          ...(structuralSl === undefined ? {} : { slPrice: structuralSl }),
          entryPrice: curPrice,
          leverage,
          score: 78,
          outlookText: `Live Execution: ${side} ${sym} @ $${curPrice} [${tradeMode} 25x Perp]`,
        }),
      });

      if (res.ok) {
        await fetchOpenPositions();
      } else {
        const err = await res.json().catch(() => ({}));
        const extra =
          err.error === "EQUITY_PRESERVE_SCALP_BLOCKED"
            ? " (Equity menipis: entry diblokir; tunggu kondisi modal memadai)"
            : err.equityUsd !== undefined
            ? ` (Equity $${err.equityUsd})`
            : "";
        alert(`Gagal membuka posisi: ${err.error || "Server error"}${extra}`);
      }
    } catch (e) {
      console.error("Gagal membuka posisi:", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Sync backend autonomous bot status with UI state
  useEffect(() => {
    const fetchStatus = () => {
      fetch("/api/settings").then((r) => r.ok ? r.json() : null).then((d) => {
        if (!d) { setExecutionMode(""); setAllowedModes([]); return; }
        setExecutionMode(d.executionMode ?? "");
        setAllowedModes(enabledTradingModes(d.modes));
        if (Number.isInteger(d.thresholds?.maxOpenPositions) && d.thresholds.maxOpenPositions > 0) {
          setMaxSlots(d.thresholds.maxOpenPositions);
        }
      }).catch(() => { setExecutionMode(""); setAllowedModes([]); });
      fetch("/api/bot/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && typeof d.isRunning === "boolean") {
            setAutoAgentTrading(d.isRunning);
          }
        })
        .catch(() => {});
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  const toggleBackendBot = async () => {
    try {
      const endpoint = autoAgentTrading ? "/api/bot/stop" : "/api/bot/start";
      const res = await apiFetch(endpoint, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setAutoAgentTrading(Boolean(data.isRunning));
      }
    } catch {}
  };

  // Tombol "JALANKAN BOT (PAIR)": menyalakan ulang SISTEM bot bila mati/berhenti
  // lalu memaksa satu siklus penuh segera (supervisi + scan + entry) dengan pair
  // terpilih sebagai fokus. BUKAN open posisi manual — semua gate tetap berlaku
  // (volume > configured floor, harga futures live, sinyal SWING PAPER empat strategi, ARM ON).
  const [isRunningBot, setIsRunningBot] = useState(false);
  const runBotSystem = async (sym: string) => {
    if (isRunningBot) return;
    setIsRunningBot(true);
    try {
      const res = await apiFetch("/api/bot/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        setAutoAgentTrading(true);
        await fetchOpenPositions();
        const opened = Number(d.openedNow) || 0;
        alert(
          `BOT BERJALAN (fokus ${sym})\n` +
          `• Sistem: ${d.started ? "DINYALAKAN ULANG (tadi mati/berhenti)" : "sudah aktif, siklus dipaksa sekarang"}\n` +
          `• Posisi baru dibuka siklus ini: ${opened}\n` +
          `• Total posisi OPEN: ${d.openPositions ?? "-"}\n` +
          (opened === 0
            ? `• Tidak ada entry baru · normal bila belum ada kandidat lolos gate (volume futures 24h >$${minVolumeUsd.toLocaleString("en-US")}, harga live, strategi match) atau slot penuh/ARM OFF.\n  Cek Markets & Scanner untuk kandidat READY.`
            : `• Cek kartu posisi aktif di bawah chart.`) +
          (d.lastError ? `\n• Catatan error terakhir: ${d.lastError}` : "")
        );
      } else {
        alert(`Bot gagal dijalankan: ${d.error || "Server error"}`);
      }
    } catch (e) {
      console.error("Gagal menjalankan bot:", e);
      alert("Bot gagal dijalankan: koneksi ke server terputus.");
    } finally {
      setIsRunningBot(false);
    }
  };

  // Automatic entries belong to the backend scanner and strategy/LLM pipeline.
  // No frontend timer may guess direction from 24h change and post directly to
  // /api/positions/open, which would bypass those entry filters.

  // Multi-pair live subscription: SEMUA posisi + selected symbol update otomatis.
  const symbolsKey = useMemo(() => {
    const set = new Set<string>([selectedSymbol, ...positions.map((p) => p.symbol)]);
    return Array.from(set).filter(Boolean).sort().join(",");
  }, [selectedSymbol, positions.map((p) => p.symbol).sort().join(",")]);

  useEffect(() => {
    const syms = symbolsKey.split(",").filter(Boolean);
    if (syms.length === 0) return;
    const unsub = binanceWs.subscribeMulti(syms, (map) => {
      const next: Record<string, number> = {};
      map.forEach((t, sym) => {
        if (t.markPrice > 0) next[sym] = t.markPrice;
      });
      setLivePrices((prev) => {
        // Hindari re-render bila tidak ada perubahan signifikan (>0).
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
      setPositions((prev) =>
        prev.map((p) => {
          const mp = map.get(p.symbol)?.markPrice;
          return mp && mp > 0 && mp !== p.markPrice ? { ...p, markPrice: mp } : p;
        })
      );
    });
    return () => unsub();
  }, [symbolsKey]);

  // Selected-symbol ticker tetap mengisi live map (agar total PnL benar walau multi telat).
  useEffect(() => {
    if (!ticker.markPrice || ticker.markPrice <= 0) return;
    setLivePrices((prev) =>
      prev[ticker.symbol] === ticker.markPrice ? prev : { ...prev, [ticker.symbol]: ticker.markPrice }
    );
    setPositions((prev) =>
      prev.map((p) =>
        p.symbol === ticker.symbol && p.markPrice !== ticker.markPrice
          ? { ...p, markPrice: ticker.markPrice }
          : p
      )
    );
  }, [ticker.markPrice, ticker.symbol]);

  // Only server market-data may drive automatic position supervision.

  const handleKill = async (id: number) => {
    try {
      const res = await apiFetch(`/api/positions/${id}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "KILL" }),
      });
      if (res.ok) {
        await fetchOpenPositions();
      } else {
        alert("Penutupan posisi belum terkonfirmasi. Periksa status posisi dan server.");
      }
    } catch { alert("Koneksi terputus; penutupan posisi belum terkonfirmasi."); }
  };

  // TURU Feature: Close all positions immediately, pause auto trading, and activate sleep mode
  const handleTuru = async () => {
    if (shutdownBusy) return;
    setShutdownBusy(true);
    setTuruAlert(false);
    setShutdownError(null);
    try {
      await shutdownTerminal();
      setAutoAgentTrading(false);
      setTuruAlert(true);
    } catch (error) {
      setShutdownError(error instanceof Error ? error.message : "Penutupan belum terkonfirmasi.");
    } finally {
      await fetchOpenPositions();
      setShutdownBusy(false);
    }
  };

  const switchPair = (sym: string, scrollToChart = false) => {
    setSelectedSymbol(sym);
    const pMeta = allPairs.find((p) => p.symbol === sym);
    if (pMeta) {
      binanceWs.setSymbol(sym, {
        markPrice: pMeta.price ?? 0,
        lastPrice: pMeta.price ?? 0,
        chg24hPct: pMeta.chg24h ?? 0,
        high24h: pMeta.high24h ?? 0,
        low24h: pMeta.low24h ?? 0,
        volume24h: pMeta.vol24hUsd ?? 0,
      });
      setTicker((prev) => ({
        ...prev,
        symbol: sym,
        markPrice: pMeta.price ?? prev.markPrice,
        lastPrice: pMeta.price ?? prev.lastPrice,
        chg24hPct: pMeta.chg24h ?? prev.chg24hPct,
        high24h: pMeta.high24h ?? prev.high24h,
        low24h: pMeta.low24h ?? prev.low24h,
        volume24h: pMeta.vol24hUsd ?? prev.volume24h,
        direction: "FLAT",
        lastUpdated: 0,
        live: false,
      }));
    } else {
      binanceWs.setSymbol(sym);
    }
    if (scrollToChart) {
      setTimeout(() => {
        document.getElementById("tradingview-chart-container")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  };

  // Listen to hash param or stored pair navigation from the market console.
  useEffect(() => {
    const handlePairChange = () => {
      const saved = localStorage.getItem("privatetrade_selected_symbol");
      if (saved) {
        localStorage.removeItem("privatetrade_selected_symbol");
        switchPair(saved, true);
        return;
      }
      const hash = window.location.hash;
      const match = hash.match(/symbol=([A-Za-z0-9]+)/);
      if (match && match[1]) {
        switchPair(match[1].toUpperCase(), true);
      }
    };
    handlePairChange();
    window.addEventListener("hashchange", handlePairChange);
    return () => window.removeEventListener("hashchange", handlePairChange);
  }, [allPairs]);

  // Filtered & Sorted Pairs for Pair Selector Modal
  const modalFilteredPairs = allPairs
    .filter((p) => {
      const matchCat =
        modalCategory === "ALL"
          ? true
          : modalCategory === "GAINERS"
          ? (p.chg24h ?? 0) > 0
          : modalCategory === "LOSERS"
          ? (p.chg24h ?? 0) < 0
          : p.cat === modalCategory;
      const matchSearch =
        p.symbol.toLowerCase().includes(modalSearch.toLowerCase()) ||
        p.name.toLowerCase().includes(modalSearch.toLowerCase());
      return matchCat && matchSearch;
    })
    .sort((a, b) => {
      if (modalSortBy === "vol") return (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0);
      if (modalSortBy === "chg") return (b.chg24h ?? 0) - (a.chg24h ?? 0);
      if (modalSortBy === "price") return (b.price ?? 0) - (a.price ?? 0);
      if (modalSortBy === "name") return a.symbol.localeCompare(b.symbol);
      return 0;
    });

  const tickColor = ticker.direction === "UP" ? colors.up : ticker.direction === "DOWN" ? colors.down : colors.textMuted;

  // TradingView embed URL with Binance Futures symbol
  const tvSymbol = `BINANCE:${selectedSymbol}.P`;
  const activePos = positions.find((p) => p.symbol === selectedSymbol);

  // Overall floating PnL across all open positions — pakai live multi-price, bukan selected saja.
  const totalOpenPnl = useMemo(
    () =>
      positions.reduce((acc, p) => {
        const mark = livePrices[p.symbol] || p.markPrice || p.entryPrice;
        const isL = p.side === "LONG";
        const pnl = (isL ? mark - p.entryPrice : p.entryPrice - mark) * p.qty;
        return acc + pnl;
      }, 0),
    [positions, livePrices]
  );

  // Overall margin used across all open positions
  const totalMarginUsed = useMemo(
    () =>
      positions.reduce((acc, p) => {
        const lev = p.leverage || leverage || 25;
        const posMargin = p.marginUsd > 0 ? p.marginUsd : (p.entryPrice * p.qty) / lev;
        return acc + posMargin;
      }, 0),
    [positions, leverage]
  );

  const isFull = positions.length >= MAX_SLOTS;
  const swingOpen = positions.filter((p) => p.mode === "SWING").length;

  const priceStr = (v: number | undefined | null) => {
    if (!v) return "--";
    if (v >= 100) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return Number(v).toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
  };
  const tickerAgeMs = ticker.lastUpdated ? clock - ticker.lastUpdated : Number.POSITIVE_INFINITY;
  const feedLabel = isFreshTicker(ticker, clock) ? "LIVE" : tickerAgeMs <= 15_000 ? "REST" : "STALE";
  // Tone hanya menentukan warna chip (kelas CSS), bukan state.
  const feedTone = feedLabel === "LIVE" ? "up" : feedLabel === "REST" ? "sand" : "dn";

  return (
    <div className="page terminal-page">
      {/* Hero header · Control Room v2: breadcrumb + compressed display title + tone line. */}
      <div className="terminal-hero-header">
        <div className="terminal-hero-main">
          <div className="terminal-crumb">{executionMode || "PAPER"} / TRADING TERMINAL · BINANCE FUTURES</div>
          <h1 className="terminal-hero-title">TRADING TERMINAL</h1>
          <div className="terminal-hero-cap">
            {selectedSymbol} perpetual · live mark-price stream · manual entry + bot supervision ·{" "}
            <span className="sd">ARM LIVE terkunci</span>
          </div>
        </div>
        <div className="terminal-hero-actions">
          <span className={`term-chip ${feedTone}`}>{feedLabel}</span>
          <span className="term-chip sand">{executionMode || "PAPER"}</span>
        </div>
        <div className="terminal-tone" />
      </div>

      <div className="toolbar terminal-toolbar">
        <div className="terminal-toolbar-left">
          <button className="terminal-pair-button" onClick={() => setIsPairModalOpen(true)} title="Pilih kontrak Binance Futures" aria-label={`Pilih pair, sekarang ${selectedSymbol}`}>
            <CryptoIcon symbol={selectedSymbol} size={18} />
            <span className="terminal-symbol">{selectedSymbol}</span>
            <span className="terminal-prop">PERP</span>
            <span className="terminal-prop">{leverage}x</span>
            <span className="terminal-chevron">▼</span>
          </button>
          <div className="terminal-price-block">
            <div className="terminal-price">${ticker.lastPrice ? priceStr(ticker.lastPrice) : priceStr(ticker.markPrice)}</div>
            <div className={ticker.chg24hPct >= 0 ? "terminal-change up" : "terminal-change dn"}>
              {ticker.chg24hPct >= 0 ? "+" : ""}{ticker.chg24hPct.toFixed(2)}% <span className="terminal-period">24H</span>
            </div>
          </div>
          <div className="terminal-live-stack">
            <span className={`term-chip ${feedTone}`}>{feedLabel}</span>
            <span className="term-chip sand">{executionMode || "PAPER"}</span>
          </div>
        </div>
        <div className="terminal-toolbar-actions">
          <button className="term-btn" onClick={() => openBinanceFuturesWeb(selectedSymbol)} title="Buka kontrak di Binance Futures">BINANCE ↗</button>
          <button className="term-btn danger" onClick={handleTuru} disabled={shutdownBusy} title="Close all PAPER positions, stop bot, disarm">{shutdownBusy ? "CLOSING…" : "EMERGENCY EXIT"}</button>
        </div>
      </div>

      {/* Metric strip · prototype KV grid. */}
      <div className="terminal-kv terminal-metrics">
        <div><div className="k">Mark price</div><div className="v">${priceStr(ticker.markPrice)}</div></div>
        <div><div className="k">Index price</div><div className="v t3">${ticker.indexPrice ? ticker.indexPrice.toLocaleString("en-US", { maximumFractionDigits: 2 }) : priceStr(ticker.markPrice)}</div></div>
        <div><div className="k">Funding</div><div className="v sd">{ticker.fundingRate != null ? (ticker.fundingRate * 100).toFixed(4) : "0.0100"}%</div></div>
        <div><div className="k">24h high</div><div className="v up">${priceStr(ticker.high24h)}</div></div>
        <div><div className="k">24h low</div><div className="v dn">${priceStr(ticker.low24h)}</div></div>
        <div><div className="k">24h volume</div><div className="v">{ticker.volume24h ? `$${ticker.volume24h >= 1e9 ? (ticker.volume24h / 1e9).toFixed(2) + "B" : (ticker.volume24h / 1e6).toFixed(1) + "M"}` : "·"}</div></div>
      </div>

      <div className="terminal-layout">
        <section className="term-card">
          <div className="term-card-head">
            <span>{selectedSymbol} <span className="t3">/ {timeframe === "60" ? "1H" : timeframe === "240" ? "4H" : timeframe === "D" ? "1D" : `${timeframe}M`}</span></span>
            <div className="term-seg">{["1", "5", "15", "60", "240", "D"].map((tf) => <button key={tf} className={timeframe === tf ? "on" : ""} onClick={() => setTimeframe(tf)}>{tf === "60" ? "1h" : tf === "240" ? "4h" : tf === "D" ? "1D" : `${tf}m`}</button>)}</div>
          </div>
          <div className="term-card-body term-chart-body">
            <TradingViewEmbed
              symbol={selectedSymbol}
              timeframe={timeframe}
              entryPrice={activePos?.entryPrice}
              slPrice={activePos?.slPrice}
              tp1Price={activePos?.tp1Price}
              posQty={activePos?.qty}
              pred={tvPred}
              overlay={posOverlay}
            />
          </div>
        </section>

        <div className="terminal-side">
          <section className="term-card">
            <div className="term-card-head"><span>Order ticket</span><span className="term-chip">{tradeMode ?? "NO MODE"}</span></div>
            <div className="term-card-body">
              <div className="order-field">
                <span>Mode</span>
                <select aria-label="Mode entry" value={tradeMode ?? ""} disabled={allowedModes.length < 2 || isSubmitting} onChange={(e) => setPreferredMode(e.target.value)}>
                  {!tradeMode && <option value="">Mode belum tersedia</option>}
                  {allowedModes.map((m) => <option key={m} value={m}>{m === "SWING" ? "SWING 1h" : "SCALP 5m"}</option>)}
                </select>
              </div>
              {tradeMode === "SWING" && (
                <div className="order-field">
                  <span>SL price / invalidation</span>
                  <input aria-label="Harga SL struktural SWING" type="number" min="0" step="any" value={manualSwingSl} onChange={(e) => setManualSwingSl(e.target.value)} placeholder="contoh: 82,300" disabled={isSubmitting} />
                </div>
              )}
              <div className="order-actions">
                <button className="order-long" onClick={() => void openRealPosition(selectedSymbol, "LONG")} disabled={isSubmitting || executionMode !== "PAPER" || !tradeMode || (tradeMode === "SWING" && !(Number(manualSwingSl) > 0))}>LONG 25x</button>
                <button className="order-short" onClick={() => void openRealPosition(selectedSymbol, "SHORT")} disabled={isSubmitting || executionMode !== "PAPER" || !tradeMode || (tradeMode === "SWING" && !(Number(manualSwingSl) > 0))}>SHORT 25x</button>
              </div>
              <div className="order-bot">
                <button className={`term-btn ${autoAgentTrading ? "" : "ghost"}`} onClick={toggleBackendBot}>{autoAgentTrading ? "AUTO BOT · ON" : "AUTO BOT · OFF"}</button>
                <button className="term-btn primary" onClick={() => void runBotSystem(selectedSymbol)} disabled={isSubmitting || isRunningBot}>{isRunningBot ? "RUNNING…" : "RUN BOT"}</button>
              </div>
            </div>
          </section>

          <section className="term-card">
            <div className="term-card-head"><span>Account</span><span className="tiny mono muted">SWING {swingOpen}/{MAX_SLOTS}</span></div>
            <div className="term-card-body">
              <div className="account-row"><span className="account-key">Margin used</span><span className="account-val">${totalMarginUsed.toFixed(2)}</span></div>
              <div className="account-row"><span className="account-key">Floating P&amp;L</span><span className={totalOpenPnl >= 0 ? "account-val up" : "account-val dn"}>{totalOpenPnl >= 0 ? "+" : ""}${totalOpenPnl.toFixed(2)}</span></div>
              <div className="account-row"><span className="account-key">Execution</span><span className={executionMode === "LIVE" ? "account-val sd" : "account-val"}>{executionMode || "PAPER"}</span></div>
              <div className="account-row"><span className="account-key">Bot</span><span className="account-val">{autoAgentTrading ? "ACTIVE" : "PAUSED"}</span></div>
              <div className="account-row"><span className="account-key">Swing slots</span><span className="account-val">{swingOpen}/{MAX_SLOTS}</span></div>
            </div>
          </section>
        </div>
      </div>

      <section className="term-card">
        <div className="term-card-head"><span>Positions · {positions.length}</span><span className="tiny mono muted">{isFull ? "TERMINAL CAP" : "OPEN"}</span></div>
        {positions.length === 0 ? <div className="term-empty">Tidak ada posisi terbuka. Entry hanya lewat gate PAPER.</div> : (
          <div className="term-table-wrap">
            <table className="terminal-positions">
              <thead><tr><th>Symbol</th><th>Side</th><th>Mode</th><th className="num">Entry</th><th className="num">Mark</th><th className="num">SL</th><th className="num">TP1</th><th className="num">P&amp;L</th><th className="num">Margin</th><th className="num">Action</th></tr></thead>
              <tbody>{positions.map((p) => {
                const mark = livePrices[p.symbol] || p.markPrice || p.entryPrice;
                const pnl = (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * p.qty;
                const risk = p.originalRiskUsd || Math.abs((p.originalSlPrice ?? p.slPrice) - p.entryPrice) * (p.originalQty ?? p.qty) || 1;
                const r = pnl / risk;
                return (
                  <tr key={p.id}>
                    <td><span className="position-symbol" onClick={() => switchPair(p.symbol, true)}>{p.symbol}</span><div className="tiny muted">#{p.id}</div></td>
                    <td className={p.side === "LONG" ? "up" : "dn"}>{p.side}</td>
                    <td className="muted">{p.mode}</td>
                    <td className="num">{priceStr(p.entryPrice)}</td>
                    <td className="num">{priceStr(mark)}</td>
                    <td className="num dn">{priceStr(p.slPrice)}</td>
                    <td className="num up">{priceStr(p.tp1Price)}</td>
                    <td className={pnl >= 0 ? "num up" : "num dn"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}<div className="tiny muted">{r >= 0 ? "+" : ""}{r.toFixed(2)}R</div></td>
                    <td className="num">${p.marginUsd.toFixed(2)}</td>
                    <td className="num"><div className="position-actions"><button className="term-btn danger term-btn-sm" onClick={() => void handleKill(p.id)} title="Kill posisi PAPER">KILL</button></div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      {posOverlay && (
        <section className="term-card">
          <div className="term-card-head">
            <span>Position manager · #{posOverlay.positionId} {posOverlay.symbol}</span>
            <span className={posOverlay.protectionConfirmed ? "term-chip up" : "term-chip sand"}>{posOverlay.protectionConfirmed ? "PROTECTED" : "PROTECTION PENDING"}</span>
          </div>
          <div className="term-card-body term-overlay-strip">
            <span>Entry <b className="mono">{posOverlay.entryPrice}</b></span>
            <span>TP1 <b className="mono up">{posOverlay.tp1Price}</b></span>
            <span>TP2/final <b className="mono sd">{posOverlay.tp2Price}</b></span>
            <span>SL <b className="mono dn">{posOverlay.slPrice}</b></span>
            <span>Source <b className="mono">{posOverlay.source}</b></span>
          </div>
        </section>
      )}

      {turuAlert && (
        <section className="term-card">
          <div className="term-card-head">
            <span>Emergency exit complete</span>
            <button className="term-btn primary" onClick={() => { setTuruAlert(false); setAutoAgentTrading(false); }}>DISMISS</button>
          </div>
          <div className="term-card-body"><div className="tiny t2">Posisi aplikasi kosong · bot berhenti · ARM off. Status exchange tetap perlu dicek di Live Mirror.</div></div>
        </section>
      )}
      {shutdownError && <div role="alert" className="term-alert">{shutdownError}</div>}

      <PairSelectorModal
        isOpen={isPairModalOpen}
        onClose={() => setIsPairModalOpen(false)}
        allPairs={allPairs}
        selectedSymbol={selectedSymbol}
        onSelectPair={switchPair}
        openBinanceFuturesWeb={openBinanceFuturesWeb}
      />
    </div>
  );
}
