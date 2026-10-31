// apps/web/src/components/ScannerCandidatesTable.test.tsx
// 24 Okt 2026 (BUG FIX kolom kosong: KNN / ER / OI% / BETA).
//
// Test level UI: membuktikan tabel benar-benar merender angka metrik dan
// menampilkan status JUJUR ("n/a") + alasan (title) saat metrik tak
// tersedia — bukan "—" yang ambigu.
//
// Bug yang ditutup di sini:
//  1) Kolom KNN memakai falsy check (`c.knnProb ? ... : "—"`), sehingga
//     knnProb = 0 yang SAH (0% win rate dari 5 analog) tampil "—".
//  2) Saat metrik null, UI tidak pernah memberi tahu APAKAN yang hilang.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScannerCandidatesTable, type CandidateItem } from "./ScannerCandidatesTable.js";

const base: CandidateItem = {
  symbol: "AAAUSDT",
  score: 70,
  mode: "SCALP",
  regime: "TRENDING",
  zoneScore: 80,
  triggerScore: 70,
  trendScore: 65,
  knnProb: 0.6,
  knnN: 60,
  knnLabel: "KNN_POOL_READY",
  er: 0.42,
  erStatus: "OK",
  oiChangePct: 1.25,
  oiStatus: "OK",
  oiReason: "OI_HIST_OK",
  betaBtc: 1.15,
  betaStatus: "OK",
  betaReason: "BETA_OK",
  status: "READY",
};

const render = (c: Partial<CandidateItem>) =>
  renderToStaticMarkup(
    <ScannerCandidatesTable candidates={[{ ...base, ...c }]} onTrade={() => {}} />
  );

describe("ScannerCandidatesTable — kolom metrik KNN/ER/OI/BETA", () => {
  it("merender nilai lengkap untuk keempat metrik", () => {
    const html = render({});
    expect(html).toContain("60%");   // KNN 0.6 -> 60%
    expect(html).toContain("0.42");  // ER
    expect(html).toContain("+1.25%");// OI%
    expect(html).toContain("1.15");  // BETA
  });

  it("knnProb = 0 yang SAH ditampilkan sebagai 0% (bukan '—')", () => {
    const html = render({ knnProb: 0 });
    expect(html).toContain("0%");
    // dan TIDAK lagi menampilkan "—" pada sel KNN
    expect(html).not.toContain(">—</td><td");
  });

  it("metrik null -> tampil 'n/a' + title berisi alasan (status jujur)", () => {
    const html = render({
      oiChangePct: null,
      oiStatus: "FETCH_FAILED",
      oiReason: "OI_FETCH_HTTP_404",
      betaBtc: null,
      betaStatus: "INSUFFICIENT_SAMPLES",
      betaReason: "BETA_SYM_BARS_40_LT_51",
    });
    expect(html).toContain("n/a");
    expect(html).toContain("OI_FETCH_HTTP_404");
    expect(html).toContain("BETA_SYM_BARS_40_LT_51");
    expect(html).toContain("Data tidak dapat diambil");
    expect(html).toContain("Data kurang untuk perhitungan");
  });

  it("KNN tanpa bukti menampilkan alasan pool kurang (bukan angka tebakan)", () => {
    const html = render({ knnProb: null, knnN: 12, knnLabel: "KNN_POOL_12_LT_50" });
    expect(html).toContain("n/a");
    expect(html).toContain("KNN_POOL_12_LT_50");
  });

  it("ER tak terdata menampilkan 'n/a' + status, bukan angka 0.00", () => {
    const html = render({ er: null, erStatus: "INSUFFICIENT_SAMPLES" });
    expect(html).toContain("n/a");
    expect(html).toContain("Data kurang untuk perhitungan");
  });
});
