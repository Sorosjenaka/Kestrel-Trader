// apps/web/src/components/NativeQuantChart.tsx
import React, { useEffect, useRef, useState } from "react";
import { binanceWs, LiveTicker } from "../lib/binanceWs";
import { applyCandleTick } from "../lib/candleTicks";
import { subscribeKlineStream, type StreamCandle, type StreamState } from "../lib/klineStream";
import { colors } from "../theme.js";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 8 Okt 2026: overlay prediksi BUY/SELL dari sinyal TradingView (display-only). */
export interface TvSignalOverlay {
  signal: "BUY" | "SELL" | "NEUTRAL";
  rating: number | null;
  ratingLabel: string;
  buy: { entry: number; sl: number; tp: number; rr: number } | null;
  sell: { entry: number; sl: number; tp: number; rr: number } | null;
}

/** 14 Okt 2026 (Part A): overlay Trade Manager dari /api/positions/overlay —
 * state posisi TERKONFIRMASI (bukan tebakan harga menyentuh level). */
export interface PositionOverlayView {
  symbol: string;
  positionId: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  originalQty: number;
  tp1Qty: number; tp2Qty: number; tpMaxQty: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  tpMaxPrice: number;
  tp1FilledAt: string | null;
  tp1FillPrice: number | null;
  bepConfirmed: boolean;
  bepPrice: number | null;
  trailActive: boolean;
  trailPrice: number | null;
  protectionConfirmed: boolean;
  /** 14 Okt 2026: sumber posisi (MANUAL = fixture/demo) + catatan ladder TP. */
  source?: string;
  ladderNote?: string;
}

interface NativeQuantChartProps {
  symbol: string;
  timeframe: string;
  entryPrice?: number;
  slPrice?: number;
  tp1Price?: number;
  /** Qty posisi OPEN (untuk kolom nominal ala tool TradingView). */
  posQty?: number | null;
  pred?: TvSignalOverlay | null;
  /** Trade Manager overlay (Part A) — menggambar TP1/TP2/TPMax/BEP/Trailing. */
  overlay?: PositionOverlayView | null;
}

export function NativeQuantChart({
  symbol,
  timeframe,
  entryPrice,
  slPrice,
  tp1Price,
  posQty,
  pred,
  overlay,
}: NativeQuantChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<LiveTicker>(binanceWs.getCurrentTicker());
  const streamActiveRef = useRef(false);
  // 27 Okt 2026 (fix "chart burem"): canvas mengikuti ukuran CSS box x
  // devicePixelRatio, BUKAN 960x500 yang di-stretch CSS (pembesaran bikin
  // teks/garis blur). ResizeObserver menjaga ketajaman saat lebar panel berubah.
  const [box, setBox] = useState({ w: 960, h: 500 });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const w = Math.max(320, Math.round(wrap.clientWidth || 960));
      const h = Math.max(240, Math.round(wrap.clientHeight || 500));
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    // Fallback untuk environment tanpa ResizeObserver (jsdom test / browser lama).
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // 27 Okt 2026 (bug "chart loading selamanya"): pemanggil baru (mis.
    // LivePositionChart) sudah membawa timeframe ber-suffix ("15m","1h","4h").
    // Concatenation polos `${timeframe}m` menghasilkan "15mm" -> Binance balas
    // kosong -> retry selamanya. Terima bentuk jadi apa adanya; legacy numerik
    // ("60","240","D", "5") tetap dikonversi.
    const intervalStr =
      timeframe === "60" ? "1h"
      : timeframe === "240" ? "4h"
      : timeframe === "D" ? "1d"
      : /^\d+[mhd]$/.test(timeframe) ? timeframe
      : `${timeframe}m`;
    // 8 Okt 2026 (bug "chart loading doang"): fetch klines dulu tanpa retry —
    // satu kali gagal/timeout = chart nyangkut LOADING selamanya. Kini retry
    // terus tiap 4 detik sampai data masuk; chart dikosongkan saat ganti simbol.
    setCandles([]);
    const applyStreamCandle = (sc: StreamCandle) => {
      if (!active || sc.symbol !== symbol || sc.interval !== intervalStr) return;
      const next: Candle = {
        time: sc.time,
        open: sc.open,
        high: sc.high,
        low: sc.low,
        close: sc.close,
        volume: sc.volume,
      };
      setCandles((prev) => {
        if (!prev.length) return [next];
        const last = prev[prev.length - 1]!;
        if (next.time < last.time) return prev;
        if (next.time === last.time) return [...prev.slice(0, -1), next];
        return [...prev, next].slice(-70);
      });
    };
    const load = () => {
      fetch(`/api/binance/klines?symbol=${symbol}&interval=${intervalStr}&limit=70`)
        .then((r) => r.json())
        .then((d) => {
          if (!active) return;
          if (!Array.isArray(d.klines) || d.klines.length === 0) {
            retryTimer = setTimeout(load, 4000);
            return;
          }
          const parsed: Candle[] = d.klines.map((k: any) => ({
            // 28 Okt 2026 (bug chart beku): k[0] REST = openTime MILIDETIK tapi
            // sc.time stream = UTC DETIK (kontrak klineWsManager). Unit campur
            // membuat semua tick stream dibuang 'next.time < last.time' -> chart
            // tidak pernah update live. Seragamkan ke detik.
            time: Math.floor(Number(k[0]) / 1000),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
          }));
          setCandles(parsed);
        })
        .catch(() => {
          if (active) retryTimer = setTimeout(load, 4000);
        });
    };
    load();
    const unsubscribe = subscribeKlineStream(symbol, intervalStr, applyStreamCandle, (status: { state: StreamState }) => {
      streamActiveRef.current = status.state === "WS_ACTIVE";
    });

    return () => {
      active = false;
      streamActiveRef.current = false;
      unsubscribe();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    const unsub = binanceWs.subscribe(symbol, (t) => {
      if (t.symbol !== symbol || t.live === false || Date.now() - t.lastUpdated > 5000) return;
      setTicker({ ...t });
      if (!streamActiveRef.current) {
        setCandles((prev) => applyCandleTick(prev, t.markPrice, t.lastUpdated, timeframe));
      }
    });
    return () => unsub();
  }, [symbol, timeframe]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Gambar lewat requestAnimationFrame: beberapa tick WS dalam satu frame
    // hanya menggambar SEKALI (fix "chart lemot" — redraw per tick mematahkan UI).
    const draw = () => {

    // Ukuran backing store = CSS box x DPR (dibatasi 2x: tajam tapi tetap
    // ringan), lalu semua koordinat gambar dalam piksel CSS via setTransform.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = box.w;
    const height = box.h;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padR = 80;
    const padB = 26;
    const pW = width - padR;
    const pH = height - padB;

    // 14 Okt 2026: solid dark background #0B0F14 (permintaan operator).
    ctx.fillStyle = colors.bgPanel;
    ctx.fillRect(0, 0, width, height);

    if (candles.length < 2) {
      ctx.fillStyle = colors.warn;
      ctx.font = "bold 12px monospace";
      ctx.fillText(`LOADING LIVE BINANCE CANDLES // ${symbol}...`, 24, 30);
      return;
    }

    let minP = Infinity;
    let maxP = -Infinity;
    candles.forEach((c) => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });
    // Rentang harga ikut memuat level posisi/prediksi supaya kotak selalu terlihat.
    const extraLevels: number[] = [];
    for (const v of [entryPrice, slPrice, tp1Price]) if (v) extraLevels.push(v);
    // Part A: level Trade Manager ikut masuk rentang agar selalu terlihat.
    if (overlay) {
      for (const v of [overlay.tp2Price, overlay.tpMaxPrice, overlay.bepPrice, overlay.trailPrice]) {
        if (v && v > 0) extraLevels.push(v);
      }
    }
    if (pred?.buy) extraLevels.push(pred.buy.sl, pred.buy.tp);
    if (pred?.sell) extraLevels.push(pred.sell.sl, pred.sell.tp);
    extraLevels.forEach((p) => {
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    });

    const range = maxP - minP || 1;
    const getY = (p: number) => pH - ((p - minP) / range) * (pH - 24) - 12;
    const cW = Math.max(3, (pW / candles.length) * 0.7);
    const gap = pW / candles.length;

    // 14 Okt 2026 (permintaan operator): TANPA garis grid (bersih) — hanya
    // label harga di axis. Candle, volume, overlay posisi tetap digambar.
    for (let i = 1; i <= 5; i++) {
      const gy = (pH / 6) * i;
      void gy;
      const gp = maxP - (range / 6) * i;
      ctx.fillStyle = colors.textDim;
      ctx.font = "9px monospace";
      ctx.fillText(`$${gp.toFixed(gp >= 100 ? 1 : 4)}`, pW + 6, gy + 3);
    }

    // Japanese Candlesticks
    candles.forEach((c, idx) => {
      const cx = idx * gap + gap / 2;
      const isUp = c.close >= c.open;
      const col = isUp ? colors.up : colors.down;

      // Wick
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx, getY(c.high));
      ctx.lineTo(cx, getY(c.low));
      ctx.stroke();

      // Body
      const topY = getY(Math.max(c.open, c.close));
      const botY = getY(Math.min(c.open, c.close));
      const bH = Math.max(2, botY - topY);

      ctx.fillStyle = col;
      ctx.fillRect(cx - cW / 2, topY, cW, bH);
    });

    // ── Position tool ala TradingView (Long/Short Position) — 8 Okt 2026 ──
    // Gaya mengikuti screenshot referensi operator ("1 vps.png"): zona loss merah
    // (#F23645) / profit hijau (#089981), garis entry putih, label jarak
    // "poin (persen%)" + nominal (bila qty diketahui) + kelipatan R di sisi kiri
    // tiap zona, dan badge R:R besar di garis entry.
    const drawPosTool = (
      e: number,
      sl: number,
      tp: number,
      opts: {
        alpha: number;
        dashed: boolean;
        bright: boolean;
        qty?: number | null;
        tag: string;
        /** Offset vertikal tag (mencegah tag antar tool saling menimpa). */
        tagDy?: number;
      }
    ) => {
      const ye = getY(e);
      const ys = getY(sl);
      const yt = getY(tp);
      if (![ye, ys, yt].every((y) => y >= -60 && y <= pH + 60)) return;
      // Zona SL (merah) & TP (hijau)
      ctx.fillStyle = `rgba(242,65,74,${opts.alpha})`;
      ctx.fillRect(0, Math.min(ye, ys), pW, Math.abs(ys - ye));
      ctx.fillStyle = `rgba(58,168,242,${opts.alpha})`;
      ctx.fillRect(0, Math.min(ye, yt), pW, Math.abs(yt - ye));
      // Garis entry putih
      ctx.strokeStyle = opts.bright ? "#FFFFFF" : "rgba(255,255,255,0.55)";
      ctx.lineWidth = opts.bright ? 1.6 : 1;
      if (opts.dashed) ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(0, ye);
      ctx.lineTo(pW, ye);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label zona ala TradingView: jarak (poin & %), nominal bila ada qty, ±R
      const rDist = Math.abs(e - sl) || 1;
      const infoLabel = (yRaw: number, dist: number, col: string, isTp: boolean) => {
        const y = Math.min(Math.max(yRaw, 16), pH - 2);
        const pct = dist / e;
        const r = dist / rDist;
        const amount = opts.qty && opts.qty > 0 ? dist * opts.qty : null;
        const dec = dist >= 100 ? 2 : dist >= 1 ? 4 : 8;
        const txt =
          `${dist.toFixed(dec)} (${(pct * 100).toFixed(3)}%)` +
          (amount != null ? `  ${amount.toFixed(2)}` : "") +
          `  ${isTp ? "+" : "-"}${r.toFixed(2)}R`;
        ctx.font = "10px monospace";
        const w = ctx.measureText(txt).width + 8;
        ctx.fillStyle = "rgba(10,13,20,0.82)";
        ctx.fillRect(6, y - 13, w, 15);
        ctx.fillStyle = col;
        ctx.fillText(txt, 10, y - 2);
      };
      infoLabel(ys + Math.sign(ye - ys) * 9, Math.abs(e - sl), colors.down, false);
      infoLabel(yt + Math.sign(ye - yt) * 9, Math.abs(tp - e), colors.up, true);
      // Badge R:R besar DI TENGAH kiri-tengah garis entry — menjauh dari tag
      // ENTRY/SL/TP di tepi kanan (fix 9 Okt: badge menimpa tag ENTRY).
      const rrTxt = `R:R 1:${(Math.abs(tp - e) / rDist).toFixed(2)}`;
      ctx.font = `${opts.bright ? "bold " : ""}11px monospace`;
      const rw = ctx.measureText(rrTxt).width + 12;
      const rx = Math.round(pW * 0.34);
      ctx.fillStyle = opts.bright ? "rgba(10,13,20,0.9)" : "rgba(10,13,20,0.7)";
      ctx.fillRect(rx, ye - 10, rw, 20);
      ctx.strokeStyle = opts.bright ? "#FFFFFF" : "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(rx, ye - 10, rw, 20);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(rrTxt, rx + 6, ye + 4);
      // Tag identitas (PRED BUY/SELL / POSISI OPEN) di sisi kiri dekat garis entry
      // (menjauh dari legend HTML di kiri-atas supaya tidak tertutup).
      ctx.font = `${opts.bright ? "bold " : ""}10px monospace`;
      ctx.fillStyle = opts.bright ? "#FFFFFF" : "rgba(255,255,255,0.8)";
      ctx.fillText(opts.tag, 8, ye + (opts.tagDy ?? 14));
    };

    // 8 Okt 2026 (koreksi permintaan operator: "posisi pembelian dan posisi
    // penjualan harus ada di chart" saat klik trade terbuka): PRED BUY + PRED SELL
    // SELALU digambar (samar), posisi OPEN digambar terang di atasnya.
    const hasOpenPos = !!(entryPrice && slPrice && tp1Price);
    if (pred?.buy) {
      drawPosTool(pred.buy.entry, pred.buy.sl, pred.buy.tp, {
        alpha: 0.16,
        dashed: true,
        bright: false,
        tag: `PRED BUY ▲${pred.signal === "BUY" ? "  [TV: BUY]" : ""}`,
        tagDy: -6,
      });
    }
    if (pred?.sell) {
      drawPosTool(pred.sell.entry, pred.sell.sl, pred.sell.tp, {
        alpha: 0.16,
        dashed: true,
        bright: false,
        tag: `PRED SELL ▼${pred.signal === "SELL" ? "  [TV: SELL]" : ""}`,
        tagDy: 16,
      });
    }
    if (hasOpenPos) {
      drawPosTool(entryPrice!, slPrice!, tp1Price!, {
        alpha: 0.2,
        dashed: false,
        bright: true,
        qty: posQty,
        tag: `POSISI OPEN ${slPrice! < entryPrice! ? "LONG ▲" : "SHORT ▼"}`,
        tagDy: 30,
      });
    }

    // ── Part A: Trade Manager overlay (14 Okt 2026) ──
    // Marker eksekusi BUY/SELL + ladder qty dari overlay + BEP (hanya bila
    // terkonfirmasi) + trailing stop (hanya bila aktif di state engine).
    // Semua digambar ulang tiap frame — idempoten, tak mungkin duplikat.
    if (overlay && overlay.entryPrice > 0) {
      const isLong = overlay.side === "LONG";
      // Marker eksekusi di harga entry terkonfirmasi.
      const ym = getY(overlay.entryPrice);
      if (ym >= -20 && ym <= pH + 20) {
        const mx = Math.max(24, Math.min(pW - 24, pW - 60));
        ctx.beginPath();
        ctx.arc(mx, ym, 9, 0, Math.PI * 2);
        ctx.fillStyle = isLong ? colors.up : colors.down;
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.fillText(isLong ? "BUY" : "SELL", mx, ym + 3);
        ctx.textAlign = "left";
      }
      // Ladder TP memakai alokasi qty dari overlay (RR23 50/50 atau legacy 40/30/30).
      const tpLine = (p: number, qty: number, col: string, lbl: string) => {
        if (!(p > 0) || !(qty > 0)) return;
        const ly = getY(p);
        if (ly < -10 || ly > pH + 10) return;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(pW, ly); ctx.stroke();
        ctx.setLineDash([]);
        const txt = `${lbl} ${((qty / overlay.originalQty) * 100).toFixed(0)}% (${qty.toPrecision(4)})`;
        ctx.font = "9px monospace";
        const w = ctx.measureText(txt).width + 10;
        const bx = Math.round(pW * 0.62);
        ctx.fillStyle = "rgba(10,13,20,0.85)";
        ctx.fillRect(bx, ly - 8, w, 14);
        ctx.fillStyle = col;
        ctx.fillText(txt, bx + 5, ly + 3);
      };
      tpLine(overlay.tp1Price, overlay.tp1Qty, colors.up, "TP1");
      tpLine(overlay.tp2Price, overlay.tp2Qty, colors.sand, "TP2");
      tpLine(overlay.tpMaxPrice, overlay.tpMaxQty, colors.up, "TP MAX");
      // BEP — HANYA bila stop adjustment terkonfirmasi (bukan harga sentuh BE).
      if (overlay.bepConfirmed && overlay.bepPrice && overlay.bepPrice > 0) {
        const ly = getY(overlay.bepPrice);
        if (ly > -10 && ly < pH + 10) {
          ctx.strokeStyle = colors.warn;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([8, 3]);
          ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(pW, ly); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = colors.warn;
          ctx.font = "bold 9px monospace";
          ctx.fillText("BEP (CONFIRMED)", 8, ly - 5);
        }
      }
      // Trailing stop dinamis — terpisah dari TP Max & SL awal.
      if (overlay.trailActive && overlay.trailPrice && overlay.trailPrice > 0) {
        const ly = getY(overlay.trailPrice);
        if (ly > -10 && ly < pH + 10) {
          ctx.strokeStyle = colors.up;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(pW, ly); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = colors.up;
          ctx.font = "bold 9px monospace";
          ctx.fillText("TRAILING STOP", 8, ly - 5);
        }
      }
    }

    // Level Lines
    const drawL = (p: number | undefined, col: string, lbl: string) => {
      if (!p) return;
      const ly = getY(p);
      if (ly < 0 || ly > pH) return;
      ctx.strokeStyle = col;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(pW, ly);
      ctx.stroke();
      ctx.setLineDash([]);

      // 8 Okt 2026 (bug badge "nembus keluar kanan"): lebar badge mengikuti
      // lebar teks; desimal dipangkas bila melebihi kolom harga (padR).
      // 9 Okt: tag di-CLAMP ke dalam canvas (SL dekat tepi atas tidak lagi terpotong).
      let txt = `${lbl} $${p}`;
      ctx.font = "bold 8px monospace";
      if (ctx.measureText(txt).width > padR - 6) {
        const dec = p >= 100 ? 2 : p >= 1 ? 4 : 6;
        txt = `${lbl} $${p.toFixed(dec)}`;
        if (ctx.measureText(txt).width > padR - 6) ctx.font = "bold 7px monospace";
      }
      const w = Math.min(padR, Math.max(28, ctx.measureText(txt).width + 6));

      const ty = Math.min(Math.max(ly, 8), pH - 8);
      ctx.fillStyle = col;
      ctx.fillRect(pW, ty - 7, w, 14);
      ctx.fillStyle = "#000";
      ctx.fillText(txt, pW + 3, ty + 3);
    };

    drawL(entryPrice, colors.warn, "ENTRY");
    drawL(slPrice, colors.down, "SL");
    drawL(tp1Price, colors.up, "TP");

    // Current Mark Price Line
    const curP = ticker.markPrice || candles[candles.length - 1].close;
    const curY = getY(curP);
    ctx.strokeStyle = ticker.direction === "UP" ? colors.up : colors.down;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(0, curY);
    ctx.lineTo(pW, curY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = ticker.direction === "UP" ? colors.up : colors.down;
    ctx.fillRect(pW, curY - 8, padR, 16);
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 9px monospace";
    ctx.fillText(`$${curP.toFixed(curP >= 100 ? 2 : 4)}`, pW + 4, curY + 4);

    // Judul canvas hanya saat tanpa legend (legend HTML sudah menampilkan identitas;
    // sebelumnya judul ketimpa legend jadi artefak teks terpotong).
    if (!hasOpenPos && !pred) {
      ctx.fillStyle = colors.text;
      ctx.font = "bold 11px monospace";
      ctx.fillText(`${symbol} REAL-TIME CANDLES`, 14, 20);
    }
    };
    // rAF bila tersedia (browser); fallback sinkron untuk environment tanpa rAF.
    const raf: number =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(draw) : (draw(), -1);
    return () => {
      if (raf >= 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    };
  }, [candles, ticker, symbol, entryPrice, slPrice, tp1Price, posQty, pred, overlay, box]);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: 500, background: colors.bgPanel, borderRadius: 2, overflow: "hidden" }}
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
      {candles.length < 2 && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center",
            justifyContent: "center", color: colors.warn, fontFamily: "monospace",
            fontSize: 12, letterSpacing: "0.06em", pointerEvents: "none",
          }}
        >
          LOADING LIVE BINANCE CANDLES // {symbol}...
        </div>
      )}
    </div>
  );
}
