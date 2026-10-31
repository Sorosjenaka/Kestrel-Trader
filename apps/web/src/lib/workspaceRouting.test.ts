// apps/web/src/lib/workspaceRouting.test.ts
// Regresi untuk BUG "symbol ter-revert" (23 Okt 2026).
//
// Gejala: di Terminal Workspace, ketika operator memilih pair lain (klik baris
// di tabel POSITIONS / MARKET PULSE, atau ganti dropdown SYMBOL), symbol
// panel aktif KEMBALI ke symbol yang ada di route (#/terminal/BTCUSDT).
//
// Root cause: effect pengSYMBOL dari route punya `activeId` sebagai
// dependency, sehingga setiap kali panel aktif berubah, effect itu
// menimpa symbol yang baru saja dipilih operator dengan symbol basi dari
// route.
//
// Fix: aturan "terapkan satu kali per nilai route" + helper murni di
// workspaceRouting.ts.

import { describe, expect, it } from "vitest";
import { applySymbolToPanel, nextRouteSymbol } from "./workspaceRouting.js";

describe("nextRouteSymbol — route symbol hanya berlaku SATU KALI per nilai", () => {
  it("penerapan pertama: symbol baru dari route diterapkan", () => {
    const d = nextRouteSymbol(null, "BTCUSDT");
    expect(d.symbol).toBe("BTCUSDT");
    expect(d.nextApplied).toBe("BTCUSDT");
  });

  it("penerapan kedua dengan symbol yang sama: TIDAK menimpa lagi (fix ter-revert)", () => {
    // Simulasikan: route symbol sudah ter-apply, lalu operator ganti panel aktif.
    // Effect lama akan menimpa lagi di sini -> bug.
    const d = nextRouteSymbol("BTCUSDT", "BTCUSDT");
    expect(d.symbol).toBeNull();
    expect(d.nextApplied).toBe("BTCUSDT");
  });

  it("route tanpa symbol: izinkan apply lagi di navigasi berikutnya", () => {
    const d = nextRouteSymbol("BTCUSDT", undefined);
    expect(d.symbol).toBeNull();
    // Penanda dikosongkan supaya symbol berikutnya tidak dianggap "sudah apply".
    expect(d.nextApplied).toBeNull();

    const next = nextRouteSymbol(d.nextApplied, "ETHUSDT");
    expect(next.symbol).toBe("ETHUSDT");
  });

  it("symbol route berubah -> terapkan lagi (navigasi ke pair lain)", () => {
    const d = nextRouteSymbol("BTCUSDT", "ETHUSDT");
    expect(d.symbol).toBe("ETHUSDT");
    expect(d.nextApplied).toBe("ETHUSDT");
  });

  it("symbol route dinormalisasi ke uppercase", () => {
    const d = nextRouteSymbol(null, "ethusdt");
    expect(d.symbol).toBe("ETHUSDT");
  });
});

describe("applySymbolToPanel — hanya panel aktif yang tersentuh", () => {
  const panels = [
    { id: "p1", symbol: "BTCUSDT" },
    { id: "p2", symbol: "ETHUSDT" },
    { id: "p3", symbol: "SOLUSDT" },
  ];

  it("mengubah symbol panel aktif", () => {
    const out = applySymbolToPanel(panels, "p2", "XRPUSDT");
    expect(out[1]!.symbol).toBe("XRPUSDT");
  });

  it("panel lain tetap utuh", () => {
    const out = applySymbolToPanel(panels, "p2", "XRPUSDT");
    expect(out[0]!.symbol).toBe("BTCUSDT");
    expect(out[2]!.symbol).toBe("SOLUSDT");
  });

  it("tidak mengubah array asal (immutabel)", () => {
    applySymbolToPanel(panels, "p1", "ADAUSDT");
    expect(panels[0]!.symbol).toBe("BTCUSDT");
  });

  it("activeId yang tidak ada -> tidak ada panel yang berubah", () => {
    const out = applySymbolToPanel(panels, "p9", "XRPUSDT");
    expect(out.map((p) => p.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  });
});

describe("skenario penuh: pilih pair -> panel aktif berubah -> symbol TIDAK balik", () => {
  it("klik pair di tabel tidak ditimpa route symbol lama", () => {
    // 1. Route #/terminal/BTCUSDT -> symbol BTCUSDT ter-apply ke p1.
    let applied = nextRouteSymbol(null, "BTCUSDT");
    expect(applied.symbol).toBe("BTCUSDT");
    let panels = applySymbolToPanel(
      [{ id: "p1", symbol: "SOLUSDT" }],
      "p1",
      applied.symbol as string,
    );
    expect(panels[0]!.symbol).toBe("BTCUSDT");

    // 2. Operator klik baris ETHUSDT di tabel POSITIONS.
    panels = applySymbolToPanel(panels, "p1", "ETHUSDT");
    expect(panels[0]!.symbol).toBe("ETHUSDT");

    // 3. Operator klik panel lain (p2 jadi aktif) lalu kembali ke p1.
    //    Effect lama (dependency activeId) akan menimpa ETHUSDT -> BTCUSDT.
    //    Effect baru: route symbol sudah pernah ter-apply -> tidak menimpa.
    applied = nextRouteSymbol(applied.nextApplied, "BTCUSDT");
    expect(applied.symbol).toBeNull();
    // Karena tidak ada symbol baru, panel tetap ETHUSDT.
    expect(panels[0]!.symbol).toBe("ETHUSDT");
  });
});
