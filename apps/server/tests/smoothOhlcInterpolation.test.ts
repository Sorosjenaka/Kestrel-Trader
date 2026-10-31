import { describe, it, expect } from "vitest";
import { beginTransition, sampleTransition, lerpOhlc, type Ohlc } from "../../web/src/lib/smoothOhlc.js";

/*
  23 Okt 2026 — test untuk interpolasi candle (gerak "natural").
  Permintaan operator: pergerakan candle harus smooth seperti demo
  TradingAgents, bukan melompat tiap tick.

  These tests pin the CONTRACT that the chart relies on:
  1. Perpindahan harga terjadi secara kontinu (tidak ada lompatan).
  2. Interpolasi monoton menuju target dan berakhir tepat di target.
  3. Invarian candle terjaga: high >= max(open,close), low <= min(open,close).
  4. Bar tertutup tidak dianimasikan (target identik -> tidak ada transisi).
*/

describe("smoothOhlc — interpolasi candle", () => {
  it("menggerakkan harga secara kontinu dari A ke B (bukan snap)", () => {
    const from: Ohlc = { open: 100, high: 100, low: 100, close: 100 };
    const to: Ohlc = { open: 100, high: 110, low: 100, close: 108 };
    const state = beginTransition(from, to, 0);
    expect(state).not.toBeNull();

    // Sample di tengah animasi: HARUS di antara from dan to, bukan sama sekali.
    const mid = sampleTransition(state!, 60).ohlc; // 60ms dari 120ms
    expect(mid.close).toBeGreaterThan(from.close);
    expect(mid.close).toBeLessThan(to.close);
    // Tidak boleh melompat langsung ke target.
    expect(mid.close).not.toBe(to.close);
  });

  it("berakhir tepat di target setelah durasi", () => {
    const from: Ohlc = { open: 10, high: 12, low: 9, close: 11 };
    const to: Ohlc = { open: 11, high: 15, low: 10, close: 14 };
    const state = beginTransition(from, to, 0)!;
    const end = sampleTransition(state, 120);
    expect(end.completed).toBe(true);
    expect(end.ohlc.close).toBe(to.close);
    expect(end.ohlc.high).toBe(to.high);
    expect(end.ohlc.low).toBe(to.low);
  });

  it("mempertahankan invarian candle saat interpolasi (high>=o/c, low<=o/c)", () => {
    const from: Ohlc = { open: 100, high: 100, low: 100, close: 100 };
    const to: Ohlc = { open: 100, high: 120, low: 80, close: 118 };
    const state = beginTransition(from, to, 0)!;
    for (let t = 0; t <= 120; t += 10) {
      const { ohlc } = sampleTransition(state, t);
      expect(ohlc.high).toBeGreaterThanOrEqual(Math.max(ohlc.open, ohlc.close));
      expect(ohlc.low).toBeLessThanOrEqual(Math.min(ohlc.open, ohlc.close));
    }
  });

  it("tidak membuat transisi bila target identik (bar tertutup / harga tak berubah)", () => {
    const same: Ohlc = { open: 5, high: 6, low: 4, close: 5.5 };
    expect(beginTransition(same, { ...same }, 0)).toBeNull();
  });

  it("easing: gerak paling cepat di awal lalu melambat (easeOutCubic)", () => {
    const from: Ohlc = { open: 0, high: 0, low: 0, close: 0 };
    const to: Ohlc = { open: 100, high: 100, low: 0, close: 100 };
    const state = beginTransition(from, to, 0)!;
    const early = sampleTransition(state, 24).ohlc.close;   // 20% durasi
    const late = sampleTransition(state, 96).ohlc.close;    // 80% durasi
    // Kenaikan per 20% durasi harus menurun (mulai cepat, melambat).
    const firstStep = early - 0;
    const lastStep = 100 - late;
    expect(firstStep).toBeGreaterThan(lastStep);
  });

  it("lerpOhlc menginterpolasi keempat field", () => {
    const a: Ohlc = { open: 1, high: 2, low: 0, close: 1.5 };
    const b: Ohlc = { open: 3, high: 6, low: 1, close: 4.5 };
    const mid = lerpOhlc(a, b, 0.5);
    expect(mid.open).toBe(2);
    expect(mid.high).toBe(4);
    expect(mid.low).toBe(0.5);
    expect(mid.close).toBe(3);
  });
});
