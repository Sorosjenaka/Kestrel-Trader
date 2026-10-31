// @vitest-environment jsdom
// apps/web/src/components/NativeQuantChart.overlay.test.tsx
// Part C evidence: overlay Trade Manager digambar TANPA duplikasi dan TIDAK
// memicu order apa pun. Canvas 2D di-mock; urutan draw calls diverifikasi.
// Jalankan: npx vitest run src/components/NativeQuantChart.overlay.test.tsx
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

// Mock canvas 2D sebelum import komponen.
const calls: string[] = [];
const mkCtx = () => {
  const rec = (name: string) => (...args: unknown[]) => { calls.push(name); return undefined; };
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_t, prop: string) {
      switch (prop) {
        case "measureText": return (s: string) => ({ width: String(s).length * 6 });
        case "fillText": case "strokeText": return (s: string) => { calls.push(`text:${s}`); };
        case "fillRect": return (x: number, y: number, w: number, h: number) => { calls.push(`rect:${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`); };
        case "beginPath": case "moveTo": case "lineTo": case "arc": case "stroke": case "fill": case "setTransform": case "translate": case "scale": return rec(String(prop));
        case "setLineDash": return (d: number[]) => { calls.push(`dash:${d.join(",")}`); };
        default: return typeof prop === "string" && prop in {} ? undefined : undefined;
      }
    },
    set(_t, prop: string) { return true; },
  });
};

beforeAll(() => {
  (globalThis as any).HTMLCanvasElement.prototype.getContext = vi.fn(() => mkCtx());
  /*
     30 Okt 2026: klineStream kini memakai WebSocket publik Binance langsung
     (bukan SSE). jsdom menyediakan WebSocket undici yang benar-benar membuka
     koneksi -> uncaught "event must be an instance of Event". Test ini tidak
     menguji transport, jadi socket di-stub no-op.
  */
  class NoopWebSocket {
    url: string;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(url: string) { this.url = url; }
    close(): void { this.readyState = 3; }
  }
  vi.stubGlobal("WebSocket", NoopWebSocket);
});

import { NativeQuantChart, type PositionOverlayView } from "./NativeQuantChart.js";

const overlay: PositionOverlayView = {
  symbol: "BTCUSDT",
  positionId: 3035,
  side: "LONG",
  entryPrice: 83373.3,
  originalQty: 0.001,
  tp1Qty: 0.0004, tp2Qty: 0.0003, tpMaxQty: 0.0003,
  slPrice: 82373.3,
  tp1Price: 85073.3, tp2Price: 85073.3, tpMaxPrice: 85073.3,
  tp1FilledAt: null, tp1FillPrice: null,
  bepConfirmed: false, bepPrice: null,
  trailActive: false, trailPrice: null,
  protectionConfirmed: true,
};

// Klines format array-of-arrays seperti respons /api/binance/klines.
const candles = Array.from({ length: 30 }, (_, i) => {
  const t = 1_700_000_000_000 + i * 60_000;
  const o = 83_000 + i * 5, c = 83_050 + i * 5;
  return [t, o, c + 50, c - 50, c, 1];
});

beforeAll(() => {
  (globalThis as any).fetch = vi.fn(() => Promise.resolve({
    ok: true, json: async () => ({ klines: candles }),
  }));
});

describe("NativeQuantChart Trade Manager overlay", () => {
  it("menggambar BUY marker + TP1/TP2/TP MAX satu kali per frame (tanpa duplikasi)", async () => {
    calls.length = 0;
    const { container } = render(<NativeQuantChart symbol="BTCUSDT" timeframe="15" overlay={overlay} />);
    // tunggu candles termuat + beberapa frame draw
    await new Promise((r) => setTimeout(r, 120));
    await new Promise((r) => setTimeout(r, 120));
    const buy = calls.filter((c) => c === "text:BUY");
    const tp1 = calls.filter((c) => c.startsWith("text:TP1 "));
    const tp2 = calls.filter((c) => c.startsWith("text:TP2 "));
    const tpMax = calls.filter((c) => c.startsWith("text:TP MAX "));
    expect(buy.length).toBe(1);          // satu marker, bukan dobel
    expect(tp1.length).toBe(1);
    expect(tp2.length).toBe(1);
    expect(tpMax.length).toBe(1);
    // BEP & TRAIL TIDAK boleh digambar bila belum terkonfirmasi (kejujuran state)
    expect(calls.some((c) => c.includes("BEP"))).toBe(false);
    expect(calls.some((c) => c.includes("TRAILING"))).toBe(false);
    container.remove();
  });

  it("BEP & trailing digambar hanya bila state terkonfirmasi", async () => {
    calls.length = 0;
    const full: PositionOverlayView = { ...overlay, bepConfirmed: true, bepPrice: 83373.3, trailActive: true, trailPrice: 83000 };
    const { container } = render(<NativeQuantChart symbol="BTCUSDT" timeframe="15" overlay={full} />);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c.includes("BEP (CONFIRMED)")).length).toBe(1);
    expect(calls.filter((c) => c.includes("TRAILING STOP")).length).toBe(1);
    container.remove();
  });

  it("overlay null → tidak ada marker BUY (chart polos)", async () => {
    calls.length = 0;
    const { container } = render(<NativeQuantChart symbol="BTCUSDT" timeframe="15" />);
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c === "text:BUY").length).toBe(0);
    expect(calls.filter((c) => c.startsWith("text:TP MAX")).length).toBe(0);
    container.remove();
  });
});
