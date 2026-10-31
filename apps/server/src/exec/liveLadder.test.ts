// apps/server/src/exec/liveLadder.test.ts — 26 Okt 2026 (TAHAP 1A/8)
// Regresi: ladder plan per policy + bukti fill algo (TRIGGERED bukan fill).
import { describe, expect, it } from "vitest";
import { isAlgoFilled, parseAlgoFillEvidence, planLiveLadder } from "./liveLadder.js";

describe("planLiveLadder RR23", () => {
  it("TP1 50% floor step, TP2 seluruh sisa, tanpa runner", () => {
    const plan = planLiveLadder({ qty: 41.2, stepSize: 0.1, entryPrice: 1, tp1Price: 1.2, side: "LONG", swingExitPolicy: "RR23" });
    expect(plan).not.toBeNull();
    expect(plan!.tp1Qty).toBeCloseTo(20.6, 9);
    expect(plan!.tp2Qty).toBeCloseTo(20.6, 9);
    expect(plan!.runnerQty).toBe(0);
    expect(plan!.tpMaxPrice).toBeNull();
  });
  it("SHORT RR23: TP1 di bawah entry valid", () => {
    const plan = planLiveLadder({ qty: 10, stepSize: 1, entryPrice: 2, tp1Price: 1.6, side: "SHORT", swingExitPolicy: "RR23" });
    expect(plan).not.toBeNull();
    expect(plan!.tp1Qty).toBe(5);
    expect(plan!.tp2Qty).toBe(5);
  });
  it("legacy 40/30/runner + TPMAX informatif", () => {
    const plan = planLiveLadder({ qty: 100, stepSize: 1, entryPrice: 1, tp1Price: 1.1, side: "LONG", swingExitPolicy: "LEGACY_40_30" });
    expect(plan).not.toBeNull();
    expect(plan!.tp1Qty).toBe(40);
    expect(plan!.tp2Qty).toBe(30);
    expect(plan!.runnerQty).toBe(30);
    expect(plan!.tpMaxPrice).toBeCloseTo(1.3, 9);
  });
  it("fase TP1 < 1 step -> null (caller degradasi single-target)", () => {
    const plan = planLiveLadder({ qty: 1, stepSize: 1, entryPrice: 1, tp1Price: 1.2, side: "LONG", swingExitPolicy: "RR23" });
    expect(plan).toBeNull();
  });
  it("TP1 tidak melewati entry -> null", () => {
    const plan = planLiveLadder({ qty: 10, stepSize: 1, entryPrice: 1, tp1Price: 0.9, side: "LONG", swingExitPolicy: "RR23" });
    expect(plan).toBeNull();
  });
});

describe("parseAlgoFillEvidence (TAHAP 1A)", () => {
  it("NEW -> tidak ada bukti trigger/fill", () => {
    const ev = parseAlgoFillEvidence({ algoStatus: "NEW" });
    expect(ev.triggered).toBe(false);
    expect(ev.confirmedFilled).toBe(false);
    expect(ev.childOrderId).toBeNull();
  });
  it("TRIGGERED tanpa bukti harga/qty BUKAN fill (child LIMIT bisa resting)", () => {
    const ev = parseAlgoFillEvidence({ algoStatus: "TRIGGERED", actualOrderId: "123", actualPrice: "0" });
    expect(ev.triggered).toBe(true);
    expect(ev.childOrderId).toBe("123");
    expect(ev.fillPrice).toBeNull();
    expect(ev.fillQty).toBeNull();
    expect(ev.confirmedFilled).toBe(false);
  });
  it("TRIGGERED + actualPrice + actualQty = bukti fill", () => {
    const ev = parseAlgoFillEvidence({ algoStatus: "TRIGGERED", actualOrderId: "123", actualPrice: "1.20", actualQty: "20.6" });
    expect(ev.confirmedFilled).toBe(true);
    expect(ev.fillPrice).toBeCloseTo(1.2, 9);
    expect(ev.fillQty).toBeCloseTo(20.6, 9);
  });
  it("FINISHED + actualPrice = fill terkonfirmasi walau actualQty absen", () => {
    const ev = parseAlgoFillEvidence({ algoStatus: "FINISHED", actualPrice: "1.20" });
    expect(ev.finished).toBe(true);
    expect(ev.confirmedFilled).toBe(true);
  });
  it("CANCELED/EXPIRED -> tidak ada fill", () => {
    expect(parseAlgoFillEvidence({ algoStatus: "CANCELED" }).confirmedFilled).toBe(false);
    expect(parseAlgoFillEvidence({ algoStatus: "EXPIRED" }).confirmedFilled).toBe(false);
  });
  it("null/undefined aman", () => {
    expect(parseAlgoFillEvidence(null).confirmedFilled).toBe(false);
    expect(parseAlgoFillEvidence(undefined).triggered).toBe(false);
  });
});

describe("isAlgoFilled (semantik 26 Okt 2026)", () => {
  it("TRIGGERED tidak lagi dihitung filled", () => {
    expect(isAlgoFilled("TRIGGERED")).toBe(false);
  });
  it("status terminal fill tetap dihitung", () => {
    expect(isAlgoFilled("FILLED")).toBe(true);
    expect(isAlgoFilled("FINISHED")).toBe(true);
    expect(isAlgoFilled("EXECUTED")).toBe(true);
    expect(isAlgoFilled("COMPLETED")).toBe(true);
  });
  it("status lain tidak", () => {
    expect(isAlgoFilled("NEW")).toBe(false);
    expect(isAlgoFilled("WORKING")).toBe(false);
    expect(isAlgoFilled("CANCELED")).toBe(false);
    expect(isAlgoFilled(null)).toBe(false);
    expect(isAlgoFilled(undefined)).toBe(false);
  });
});