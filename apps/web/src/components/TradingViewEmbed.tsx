// apps/web/src/components/TradingViewEmbed.tsx
// Memoized high-performance TradingView Chart with instant fallback to NativeQuantChart.
import React, { useState } from "react";
import { NativeQuantChart, type TvSignalOverlay, type PositionOverlayView } from "./NativeQuantChart";
import { colors } from "../theme.js";

interface TradingViewEmbedProps {
  symbol: string;
  timeframe: string;
  entryPrice?: number;
  slPrice?: number;
  tp1Price?: number;
  posQty?: number | null;
  pred?: TvSignalOverlay | null;
  /** Part A: Trade Manager overlay (hanya bisa digambar di engine native). */
  overlay?: PositionOverlayView | null;
}

export const TradingViewEmbed = React.memo(function TradingViewEmbed({
  symbol,
  timeframe,
  entryPrice,
  slPrice,
  tp1Price,
  posQty,
  pred,
  overlay,
}: TradingViewEmbedProps) {
  // 8 Okt 2026 (perintah operator: "balikin pakai chart trading view aja"):
  // DEFAULT = widget TradingView (chart asli + tools TradingView), TANPA
  // auto-switch. Engine NATIVE (bisa digambar tool posisi otomatis) via toggle.
  const [useNative, setUseNative] = useState(false);

  // Symbol for TradingView Binance Futures Perpetual
  const tvSymbol = `BINANCE:${symbol}.P`;
  const tfParam = timeframe === "60" ? "60" : timeframe === "240" ? "240" : timeframe === "D" ? "D" : timeframe;
  const tvSrc = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${encodeURIComponent(
    tvSymbol
  )}&interval=${tfParam}&hidesidetoolbar=0&symboledit=1&saveimage=1&toolbarbg=0A0D14&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&studies_overrides=%7B%7D&overrides=%7B%22paneProperties.backgroundType%22%3A%22solid%22%2C%22paneProperties.background%22%3A%22%230B0F14%22%2C%22paneProperties.gridLinesMode%22%3A%22none%22%2C%22paneProperties.vertGridProperties.color%22%3A%22%230B0F14%22%2C%22paneProperties.horzGridProperties.color%22%3A%22%230B0F14%22%2C%22paneProperties.vertGridProperties.visible%22%3Afalse%2C%22paneProperties.horzGridProperties.visible%22%3Afalse%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en`;

  return (
    <div
      style={{
        width: "100%",
        background: colors.bgPanel,
        backgroundColor: colors.bgPanel,
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 9px", borderBottom: "1px solid #2a2b33", fontFamily: "monospace", fontSize: 9, color: "#92939d" }}>
        <span>PRICE ACTION · {tvSymbol}</span>
        <button
          onClick={() => setUseNative(!useNative)}
          style={{ background: useNative ? "rgba(154,178,228,.16)" : "transparent", color: useNative ? "#9AB2E4" : "#92939d", border: "1px solid #3a3b45", padding: "3px 7px", fontSize: 9, fontFamily: "monospace", borderRadius: 3, cursor: "pointer" }}
        >
          {useNative ? "NATIVE" : "TRADINGVIEW"}
        </button>
      </div>

      {/* Area chart. Widget mode: iframe TradingView Live TETAP utuh · rail level
          ditaruh DI SEBELAH KIRI (kolom flex, bukan menutupi chart), bukan di
          atas iframe. Iframe cross-origin (s.tradingview.com) tidak punya API
          gambar, jadi garis presisi di atas candle hanya mungkin di engine
          NATIVE; rail memberi bacaan level tanpa menyentuh chart. */}
      <div style={{ display: "flex", width: "100%", height: 470 }}>
        {useNative ? (
          <NativeQuantChart
            symbol={symbol}
            timeframe={timeframe}
            entryPrice={entryPrice}
            slPrice={slPrice}
            tp1Price={tp1Price}
            posQty={posQty}
            pred={pred}
            overlay={overlay}
          />
        ) : (
          <iframe
            id="tradingview_widget"
            name="tradingview_widget"
            title="TradingView Real-Time Chart"
            src={tvSrc}
            allowTransparency={true}
            style={{
              flex: 1,
              height: "100%",
              border: "none",
              background: colors.bgPanel,
              backgroundColor: colors.bgPanel,
            }}
          />
        )}
      </div>
    </div>
  );
});
