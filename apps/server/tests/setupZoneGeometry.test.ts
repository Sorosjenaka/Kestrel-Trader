import { describe, it, expect } from "vitest";
import { buildZone, SETUP_ZONE_STYLE } from "../../web/src/lib/setupZones.js";

/*
  23 Okt 2026 — test untuk geometri zona setup Entry/SL/TP.

  CATATAN PERUBAHAN (23 Okt 2026, malam): operator memutuskan TIDAK memakai
  shaded zone di chart — Entry/SL/TP digambar sebagai price line tipis ala
  TradingView (lihat TradingChartPanel.tsx, effect createPriceLine).
  Modul setupZones.ts + test ini DIPERTAHANKAN sebagai utilitas geometri
  (masih dipakai test, belum dipakai chart), supaya kalau zone Needed lagi
  tidak ditulis ulang. Caller chart sudah tidak mengimpornya.

  Test ini menguji kode produksi (web/src/lib/setupZones.ts) — bukan salinan.
*/

const H = 480; // tinggi area chart

describe("buildZone — geometri zona setup", () => {
  it("membuat pita RISK dari SL ke entry dengan tinggi = jarak keduanya", () => {
    const z = buildZone(100, 200, H, SETUP_ZONE_STYLE.risk.fill, SETUP_ZONE_STYLE.risk.stroke, SETUP_ZONE_STYLE.risk.label, SETUP_ZONE_STYLE.risk.dash);
    expect(z).not.toBeNull();
    expect(z!.top).toBe(100);
    expect(z!.h).toBe(100);
    expect(z!.dash).toBe("4 3");
    expect(z!.label).toBe("RISK → SL");
  });

  it("membuat pita TP dari entry ke TP (posisi terbalik tetap benar)", () => {
    const z = buildZone(300, 200, H, SETUP_ZONE_STYLE.tp1.fill, SETUP_ZONE_STYLE.tp1.stroke, SETUP_ZONE_STYLE.tp1.label);
    expect(z!.top).toBe(200);
    expect(z!.h).toBe(100);
  });

  it("CLIP pita yang keluar dari area chart (atas)", () => {
    // top = -221, bottom = 110 -> clip atas jadi 0, h = 110
    const z = buildZone(-221, 110, H, "f", "s", "RISK");
    expect(z!.top).toBe(0);
    expect(z!.h).toBe(110);
    expect(z!.clipped).toBe(true);
  });

  it("CLIP pita yang melewati batas bawah", () => {
    const z = buildZone(300, 774, H, "f", "s", "TP2");
    expect(z!.top).toBe(300);
    expect(z!.h).toBe(H - 300);
    expect(z!.clipped).toBe(true);
  });

  it("TIDAK menandai clipped kalau pita sepenuhnya di dalam area", () => {
    const z = buildZone(100, 200, H, "f", "s", "TP1");
    expect(z!.clipped).toBe(false);
  });

  it("tidak membuat pita yang lebih tipis dari 0.5px (hilang di layar)", () => {
    expect(buildZone(200, 200.2, H, "f", "s", "ENTRY")).toBeNull();
  });

  it("tidak membuat pita untuk koordinat tidak valid", () => {
    expect(buildZone(null, 200, H, "f", "s", "TP2")).toBeNull();
    expect(buildZone(Number.NaN, 200, H, "f", "s", "TP2")).toBeNull();
  });

  it("ENTRY adalah pita tipis (±3px) di sekitar harga entry", () => {
    const entryY = 250;
    const z = buildZone(entryY - 3, entryY + 3, H, SETUP_ZONE_STYLE.entry.fill, SETUP_ZONE_STYLE.entry.stroke, SETUP_ZONE_STYLE.entry.label);
    expect(z!.h).toBe(6);
    expect(z!.top).toBe(247);
  });

  it("style zona punya label yang konsisten (RISK/TP1/TP2/ENTRY)", () => {
    expect(SETUP_ZONE_STYLE.risk.label).toContain("RISK");
    expect(SETUP_ZONE_STYLE.tp1.label).toBe("TP1");
    expect(SETUP_ZONE_STYLE.tp2.label).toBe("TP2");
    expect(SETUP_ZONE_STYLE.entry.label).toBe("ENTRY");
  });
});
