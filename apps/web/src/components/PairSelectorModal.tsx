import React, { useEffect, useMemo, useState } from "react";
import { colors, fonts } from "../theme.js";
import { Badge, Btn } from "./ui.js";
import { CryptoIcon } from "./CryptoIcon";
import type { PairItem } from "../pages/TradingTerminalPage";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  allPairs: PairItem[];
  selectedSymbol: string;
  onSelectPair: (symbol: string) => void;
  openBinanceFuturesWeb: (symbol: string) => void;
}

const CATEGORIES = ["ALL", "FAV", "GAINERS", "LOSERS", "MAJOR", "LAYER 1", "AI", "MEME", "DEFI"];
type Sort = "vol" | "chg" | "price" | "name";

export function PairSelectorModal({ isOpen, onClose, allPairs, selectedSymbol, onSelectPair, openBinanceFuturesWeb }: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("ALL");
  const [sortBy, setSortBy] = useState<Sort>("vol");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("privatetrade_fav_pairs") || localStorage.getItem("artatrade_fav_pairs");
      return raw ? JSON.parse(raw) : ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    } catch { return ["BTCUSDT", "ETHUSDT", "SOLUSDT"]; }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && isOpen) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const toggleFavorite = (symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(symbol) ? prev.filter((x) => x !== symbol) : [...prev, symbol];
      try { localStorage.setItem("privatetrade_fav_pairs", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const rows = useMemo(() => allPairs
    .filter((p) => {
      const cat = category === "ALL" ? true : category === "FAV" ? favorites.includes(p.symbol)
        : category === "GAINERS" ? (p.chg24h ?? 0) > 0 : category === "LOSERS" ? (p.chg24h ?? 0) < 0 : p.cat === category;
      const q = search.trim().toLowerCase();
      return cat && (!q || p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    })
    .sort((a, b) => sortBy === "vol" ? (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0)
      : sortBy === "chg" ? (b.chg24h ?? 0) - (a.chg24h ?? 0)
      : sortBy === "price" ? (b.price ?? 0) - (a.price ?? 0)
      : a.symbol.localeCompare(b.symbol)), [allPairs, category, favorites, search, sortBy]);

  if (!isOpen) return null;

  return (
    <div className="pair-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="pair-modal" aria-label="Pilih pair Binance Futures">
        <header className="pair-modal-head">
          <div>
            <div className="eyebrow">INSTRUMENT SELECTOR</div>
            <div style={{ color: colors.textStrong, fontSize: 16, fontWeight: 650 }}>Binance Futures</div>
            <div className="tiny muted" style={{ marginTop: 2 }}>{allPairs.length} USDT perpetual contracts · public market data</div>
          </div>
          <button className="pair-close" onClick={onClose} aria-label="Tutup">ESC</button>
        </header>

        <div className="pair-modal-tools">
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search symbol…" aria-label="Search symbol" />
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as Sort)} aria-label="Sort pairs">
            <option value="vol">Volume</option><option value="chg">24h change</option><option value="price">Price</option><option value="name">Symbol</option>
          </select>
          <span className="tiny mono muted">{rows.length} results</span>
        </div>

        <div className="pair-categories">
          {CATEGORIES.map((c) => <button key={c} className={category === c ? "active" : ""} onClick={() => setCategory(c)}>{c}</button>)}
        </div>

        <div className="pair-table-wrap">
          <table className="pair-table">
            <thead><tr><th /><th>Pair</th><th className="num">Last</th><th className="num">24h</th><th className="num">Volume</th><th /></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.symbol} className={p.symbol === selectedSymbol ? "selected" : ""} onClick={() => { onSelectPair(p.symbol); onClose(); }}>
                <td><button className="fav" onClick={(e) => toggleFavorite(p.symbol, e)} aria-label="Favorite">{favorites.includes(p.symbol) ? "★" : "☆"}</button></td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><CryptoIcon symbol={p.symbol} size={18} /><div><span className="mono" style={{ color: colors.textStrong, fontWeight: 600 }}>{p.symbol}</span><div className="tiny muted">{p.name}</div></div></div></td>
                <td className="num mono">{p.price ? p.price.toLocaleString("en-US", { maximumFractionDigits: p.price < 1 ? 6 : 2 }) : "·"}</td>
                <td className="num mono" style={{ color: (p.chg24h ?? 0) >= 0 ? colors.up : colors.down }}>{p.chg24h != null ? `${p.chg24h >= 0 ? "+" : ""}${p.chg24h.toFixed(2)}%` : "·"}</td>
                <td className="num mono muted">{p.vol24hUsd ? `$${(p.vol24hUsd / 1e6).toFixed(1)}M` : "·"}</td>
                <td><button className="pair-external" onClick={(e) => { e.stopPropagation(); openBinanceFuturesWeb(p.symbol); }} aria-label="Buka Binance">↗</button></td>
              </tr>
            ))}</tbody>
          </table>
          {rows.length === 0 && <div className="agent-empty">Tidak ada pair yang cocok.</div>}
        </div>

        <footer className="pair-modal-foot">
          <span><Badge bg={colors.accentSoft} fg={colors.accent}>CHART</Badge> selection opens the chart; entries still require the server gate.</span>
          <Btn tone="ghost" onClick={onClose}>CLOSE</Btn>
        </footer>
      </section>
    </div>
  );
}
