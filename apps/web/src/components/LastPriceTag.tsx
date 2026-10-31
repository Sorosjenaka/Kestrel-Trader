// apps/web/src/components/LastPriceTag.tsx
//
// Label harga terakhir di sumbu kanan ala TradingView/Binance:
//   "77,639.6 / 12:34"
// - menempel pada koordinat harga terakhir (bergerak tiap tick),
// - countdown sisa waktu candle berjalan (dari closeTime kline, bukan timer
//   karangan), dihitung ulang tiap detik,
// - warna naik = cyan, turun = merah (palet Tema B), pulse singkat saat berubah.
//
// 30 Okt 2026: komponen ini membaca harga dari REF (bukan prop angka) supaya
// tick kline 4-5x/detik TIDAK me-render ulang seluruh TradingChartPanel
// (layout 8 monitor). Hanya label kecil ini yang re-render.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ISeriesApi } from "lightweight-charts";
import { decimalsForTick } from "../lib/realtimePnl.js";

export function fmtCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtTagPrice(price: number, tickSize: number): string {
  const digits = decimalsForTick(tickSize);
  return price.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function LastPriceTag({
  seriesRef,
  priceRef,
  closeTimeRef,
  tickSize,
  height,
  resetKey,
}: {
  seriesRef: RefObject<ISeriesApi<"Candlestick"> | null>;
  priceRef: RefObject<number | null>;
  closeTimeRef: RefObject<number | null>;
  tickSize: number;
  height: number;
  resetKey: string;
}) {
  const prevPrice = useRef<number | null>(null);
  const [view, setView] = useState<{
    price: number;
    y: number;
    remaining: number | null;
    dir: "up" | "down";
    flashSeq: number;
  } | null>(null);

  // Harga terakhir bisa berubah sebelum chart/series siap; reset saat simbol
  // atau timeframe berganti supaya tidak ada label "hantu" dari pair lama.
  useEffect(() => {
    prevPrice.current = null;
    setView(null);
  }, [resetKey]);

  useEffect(() => {
    const tick = () => {
      const price = priceRef.current;
      const series = seriesRef.current;
      if (price == null || !Number.isFinite(price) || price <= 0 || !series) {
        setView((old) => (old === null ? old : null));
        return;
      }
      let coord: number | null = null;
      try {
        coord = series.priceToCoordinate(price);
      } catch {
        coord = null;
      }
      if (coord == null || !Number.isFinite(coord) || coord < 0 || coord > height) {
        setView((old) => (old === null ? old : null));
        return;
      }
      const before = prevPrice.current;
      const moved = before != null && price !== before;
      const dir: "up" | "down" = before == null || price >= before ? "up" : "down";
      prevPrice.current = price;
      const closeTime = closeTimeRef.current;
      const remaining = closeTime != null ? closeTime - Date.now() : null;
      setView((old) => {
        const same =
          old !== null &&
          old.price === price &&
          old.remaining != null && remaining != null &&
          Math.floor(old.remaining / 1000) === Math.floor(remaining / 1000) &&
          Math.abs(old.y - coord) < 0.6;
        if (same) return old;
        return {
          price,
          y: coord,
          remaining,
          dir: moved ? dir : (old?.dir ?? dir),
          flashSeq: moved ? (old?.flashSeq ?? 0) + 1 : (old?.flashSeq ?? 0),
        };
      });
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [seriesRef, priceRef, closeTimeRef, height, resetKey]);

  if (view == null) return null;
  return (
    <div
      className={`last-price-tag ${view.dir}${view.flashSeq > 0 ? " pulse" : ""}`}
      style={{ top: view.y }}
      key={view.flashSeq}
      title={closeTimeRef.current ? `Candle close ${new Date(closeTimeRef.current).toISOString()}` : undefined}
    >
      <span className="lpt-price">{fmtTagPrice(view.price, tickSize)}</span>
      <span className="lpt-sep">/</span>
      <span className="lpt-cd">{view.remaining == null ? "--:--" : fmtCountdown(view.remaining)}</span>
    </div>
  );
}
