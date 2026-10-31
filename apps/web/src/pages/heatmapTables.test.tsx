// apps/web/src/pages/heatmapTables.test.tsx
// 24 Okt 2026 — regression test untuk rewrite daptabilitas dashboard
// mikrostruktur (permintaan operator: "sulit dibaca, angka tidak kelihatan").
//
// Yang dikunci di sini:
//  1) FORMAT ANGKA — nilai harus mudah dibaca sekilas: ribuan jadi K/M/B
//     ($1.2M, $45.0K), tanda +/− eksplisit, angka penuh untuk kolom tabel.
//  2) TABEL DIVERGENSI — versi lama membaca field yang TIDAK ADA di API
//     (exchangeA/exchangeB/note) sehingga 3 kolom render KOSONG. Test ini
//     memastikan buyerExchange/sellerExchange/spreadUsd benar-benar tampil.
//  3) CLUSTER LIKUIDASI — topLongClustersBelow / topShortClustersAbove ada
//     di API tapi tadinya tidak pernah ditampilkan. Test memastikan tampil.
//  4) NILAI KOSONG harus jujur ("·" sejak tahap 3 Tema B, dulu "—"), bukan 0 palsu.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  fmtUsd, fmtUsdFull, fmtSigned, fmtPrice, fmtPct, hhmmss, hhmm, signColor,
  DivergenceTable, ClusterColumns, LiqCumTable, KeyRow,
} from "./heatmapTables.js";
import { colors } from "../theme.js";

describe("format angka — harus enak dibaca sekilas", () => {
  it("memakai K/M/B pada nilai besar, angka bulat pada yang kecil", () => {
    expect(fmtUsd(1_500_000)).toBe("$1.50M");
    expect(fmtUsd(45_000)).toBe("$45.0K");
    expect(fmtUsd(2_400_000_000)).toBe("$2.40B");
    expect(fmtUsd(812)).toBe("$812");
  });

  it("fmtSigned menandai arah secara eksplisit (+ / −)", () => {
    expect(fmtSigned(1_200_000)).toBe("+$1.20M");
    expect(fmtSigned(-1_200_000)).toBe("-$1.20M");
    expect(fmtSigned(0)).toBe("$0");
  });

  it("fmtUsdFull tidak membulatkan (dipakai di tooltip & kolom tabel)", () => {
    expect(fmtUsdFull(1_234_567)).toBe("$1,234,567");
  });

  it("nilai tak valid / null → '·' (bukan 0 palsu; aturan tanpa dash tahap 3)", () => {
    expect(fmtUsd(NaN)).toBe("·");
    expect(fmtPrice(null)).toBe("·");
    expect(fmtPct(null)).toBe("·");
    expect(fmtPct(undefined)).toBe("·");
  });

  it("fmtPrice & fmtPct memformat sesuai presisi yang diminta", () => {
    expect(fmtPrice(1234.5678)).toBe("1,234.57");
    expect(fmtPct(12.345)).toBe("12.3%");
    expect(fmtPct(12.345, 2)).toBe("12.35%");
  });

  it("waktu ditampilkan HH:MM:SS (UTC) & HH:MM", () => {
    const t = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(hhmmss(t)).toBe("03:04:05");
    expect(hhmm(t)).toBe("03:04");
  });

  it("warna tanda: naik hijau, turun merah, nol netral", () => {
    expect(signColor(1)).toBe(colors.up);
    expect(signColor(-1)).toBe(colors.down);
    expect(signColor(0)).toBe(colors.textMuted);
  });
});

describe("tabel divergensi antar exchange — kolom tidak boleh kosong", () => {
  const row = {
    t: Date.UTC(2026, 0, 2, 3, 4, 5),
    buyerExchange: "BINANCE",
    buyerDelta: 1_250_000,
    sellerExchange: "HYPERLIQUID",
    sellerDelta: -430_000,
    spreadUsd: 1_680_000,
  };

  it("menampilkan kedua exchange, kedua delta, dan selisihnya", () => {
    const html = renderToStaticMarkup(<DivergenceTable alerts={[row]} minSpreadUsd={500_000} />);
    expect(html).toContain("BINANCE");
    expect(html).toContain("HYPERLIQUID");
    expect(html).toContain("+$1.25M");
    expect(html).toContain("-$430.0K");
    expect(html).toContain("$1.68M");
  });

  it("menampilkan waktu UTC", () => {
    const html = renderToStaticMarkup(<DivergenceTable alerts={[row]} />);
    expect(html).toContain("03:04:05");
  });

  it("menampilkan ambang selisih pada judul", () => {
    const html = renderToStaticMarkup(<DivergenceTable alerts={[row]} minSpreadUsd={500_000} />);
    expect(html).toContain("$500.0K");
  });

  it("tidak lagi membaca field yang tidak ada (exchangeA/exchangeB/note)", () => {
    const html = renderToStaticMarkup(<DivergenceTable alerts={[row]} />);
    // Kolom kosong = sel <td> tanpa isi. Pastikan tidak ada baris data kosong.
    expect(html).not.toMatch(/<td[^>]*><\/td>/);
  });

  it("kosong → tidak merender apa pun (bukan tabel hantu)", () => {
    expect(renderToStaticMarkup(<DivergenceTable alerts={[]} />)).toBe("");
  });

  it("membatasi 8 baris terbaru agar tabel tidak membentang", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...row, t: row.t + i }));
    const html = renderToStaticMarkup(<DivergenceTable alerts={many} />);
    expect(html.match(/<tr>/g)!.length).toBe(9); // 1 header + 8 data
  });
});

describe("cluster likuidasi teratas — harus tampil (dulu disembunyikan)", () => {
  const below = [{ price: 61_200, distPct: -3.4, liqUsd: 4_200_000, positions: 0 }];
  const above = [{ price: 65_800, distPct: 4.1, liqUsd: 2_800_000, positions: 0 }];

  it("menampilkan cluster long di bawah mark beserta notionalnya", () => {
    const html = renderToStaticMarkup(<ClusterColumns below={below} above={above} />);
    expect(html).toContain("CLUSTER LONG TERBESAR");
    expect(html).toContain("61,200");
    expect(html).toContain("$4.20M");
  });

  it("menampilkan cluster short di atas mark beserta notionalnya", () => {
    const html = renderToStaticMarkup(<ClusterColumns below={below} above={above} />);
    expect(html).toContain("CLUSTER SHORT TERBESAR");
    expect(html).toContain("65,800");
    expect(html).toContain("$2.80M");
  });

  it("menampilkan jarak terhadap mark dalam persen", () => {
    const html = renderToStaticMarkup(<ClusterColumns below={below} above={above} />);
    expect(html).toContain("-3.40%");
    expect(html).toContain("4.10%");
  });

  it("satu sisi kosong → tetap tampil sisi yang ada, bukan hilang semua", () => {
    const html = renderToStaticMarkup(<ClusterColumns below={below} above={[]} />);
    expect(html).toContain("CLUSTER LONG TERBESAR");
    expect(html).toContain("Tidak ada cluster short.");
  });

  it("keduanya kosong → tidak merender", () => {
    expect(renderToStaticMarkup(<ClusterColumns below={[]} above={[]} />)).toBe("");
  });
});

describe("tabel akumulasi likuidasi per pita", () => {
  it("menampilkan pita, long, short, skew, dan sisi dominan", () => {
    const html = renderToStaticMarkup(
      <LiqCumTable cum={[{ pct: 2, longsUsd: 1_000_000, shortsUsd: 500_000, skewPct: 33.3 }]} />,
    );
    expect(html).toContain("±2%");
    expect(html).toContain("$1.00M");
    expect(html).toContain("$500.0K");
    expect(html).toContain("33.3%");
    expect(html).toContain("LONG");
  });

  it("skew negatif → dominan SHORT", () => {
    const html = renderToStaticMarkup(
      <LiqCumTable cum={[{ pct: 5, longsUsd: 100, shortsUsd: 900, skewPct: -80 }]} />,
    );
    expect(html).toContain("SHORT");
  });
});

describe("KeyRow — label kiri, nilai kanan", () => {
  it("merender label dan nilai", () => {
    const html = renderToStaticMarkup(<KeyRow label="Δ TOTAL" value="+$1.20M" />);
    expect(html).toContain("Δ TOTAL");
    expect(html).toContain("+$1.20M");
  });
});
