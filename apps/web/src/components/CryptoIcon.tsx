// apps/web/src/components/CryptoIcon.tsx
import React from "react";

export interface CryptoCoinMeta {
  symbol: string;
  name: string;
  ticker: string;
  color: string;
  glyph: string;
}

export const TOP_CRYPTO_COINS: CryptoCoinMeta[] = [
  { symbol: "BTCUSDT", name: "Bitcoin", ticker: "BTC", color: "#F7931A", glyph: "₿" },
  { symbol: "ETHUSDT", name: "Ethereum", ticker: "ETH", color: "#627EEA", glyph: "Ξ" },
  { symbol: "SOLUSDT", name: "Solana", ticker: "SOL", color: "#14F195", glyph: "◎" },
  { symbol: "BNBUSDT", name: "Binance", ticker: "BNB", color: "#F3BA2F", glyph: "❖" },
  { symbol: "DOGEUSDT", name: "Dogecoin", ticker: "DOGE", color: "#EAB308", glyph: "Ð" },
  { symbol: "XRPUSDT", name: "Ripple", ticker: "XRP", color: "#00AAE4", glyph: "X" },
  { symbol: "SUIUSDT", name: "Sui", ticker: "SUI", color: "#22D3EE", glyph: "S" },
  { symbol: "PEPEUSDT", name: "Pepe", ticker: "PEPE", color: "#9AB2E4", glyph: "P" },
  { symbol: "WIFUSDT", name: "dogwifhat", ticker: "WIF", color: "#FFA35C", glyph: "W" },
  { symbol: "NEARUSDT", name: "Near", ticker: "NEAR", color: "#34D399", glyph: "N" },
  { symbol: "AVAXUSDT", name: "Avalanche", ticker: "AVAX", color: "#EF4444", glyph: "▲" },
  { symbol: "LINKUSDT", name: "Chainlink", ticker: "LINK", color: "#3B82F6", glyph: "⬡" },
  { symbol: "RENDERUSDT", name: "Render", ticker: "RNDR", color: "#E11D48", glyph: "R" },
  { symbol: "FETUSDT", name: "Fetch/ASI", ticker: "FET", color: "#FF9433", glyph: "F" },
  { symbol: "AAVEUSDT", name: "Aave", ticker: "AAVE", color: "#FF8C42", glyph: "A" },
  { symbol: "ARBUSDT", name: "Arbitrum", ticker: "ARB", color: "#FFA028", glyph: "A" },
  { symbol: "OPUSDT", name: "Optimism", ticker: "OP", color: "#F43F5E", glyph: "O" },
  { symbol: "TIAUSDT", name: "Celestia", ticker: "TIA", color: "#FF7A00", glyph: "T" },
];

export function CryptoIcon({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const sym = symbol.toUpperCase();
  const coin = TOP_CRYPTO_COINS.find((c) => c.symbol === sym);
  const color = coin?.color || "#FFA028";
  const glyph = coin?.glyph || sym.slice(0, 1);

  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: 3,
        background: `${color}25`,
        border: `1px solid ${color}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: color,
        fontWeight: "bold",
        fontSize: Math.max(9, Math.floor(size * 0.65)),
        fontFamily: "monospace",
        boxShadow: `0 0 6px ${color}30`,
      }}
    >
      {glyph}
    </div>
  );
}
