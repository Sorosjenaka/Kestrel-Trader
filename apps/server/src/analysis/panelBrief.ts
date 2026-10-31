// apps/server/src/analysis/panelBrief.ts — 26 Okt 2026 (TAHAP 6B)
// Ubah bukti mentah lima panel menjadi BRIEF TERSTRUKTUR yang ringkas.
//
// Brief per panel memuat: angka penting, sumber, waktu evidence, fakta
// pendukung, konflik antar-panel/horizon, dan data yang hilang.
// TUJUAN: prompt LLM tidak lagi menumpuk narasi mentah; input terstruktur
// supaya analisis combined tidak session-ribbon dan bisa menunjuk konflik.

import type { PanelBrief, PanelEvidence, PanelId } from "./panelEvidence.js";

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? "-" : ""}$${(abs / 1_000).toFixed(1)}K`;
  return `${n < 0 ? "-" : ""}$${abs.toFixed(0)}`;
}

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

function ageLabel(ageMs: number | null): string {
  if (ageMs == null) return "waktu sumber tidak diketahui";
  if (ageMs < 1000) return `${ageMs}ms`;
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}dtk`;
  return `${Math.round(ageMs / 60_000)}mnt`;
}

/** Brief untuk satu panel (dipakai prompt per-panel & combined). */
export function buildPanelBrief(ev: PanelEvidence, now: number = Date.now()): PanelBrief {
  const d = ev.data;
  const figures: string[] = [];
  const support: string[] = [];
  const conflict: string[] = [];
  const missing = [...ev.missingFields];
  // Sinyal numerik (dihitung dari angka asli, bukan dari teks terformat).
  let flowSign = 0;
  let flowUsd = 0;
  let magnetSign = 0;

  switch (ev.panel) {
    case "orderflow": {
      const h15 = d.h15 as Record<string, unknown> | null;
      const h1h = d.h1h as Record<string, unknown> | null;
      if (h15) {
        figures.push(`15m: CVD ${usd(Number(h15.cvdDelta ?? 0))} (perp ${usd(Number(h15.perpCvd ?? 0))}, spot ${usd(Number(h15.spotCvd ?? 0))}), harga ${pct(h15.priceChangePct as number | null)}, buyShare ${num(h15.buySharePct as number | null, 1)}%`);
        flowUsd = Number(h15.cvdDelta ?? 0);
        flowSign = Math.sign(flowUsd);
      }
      if (h1h) {
        figures.push(`1h: CVD ${usd(Number(h1h.cvdDelta ?? 0))} (perp ${usd(Number(h1h.perpCvd ?? 0))}, spot ${usd(Number(h1h.spotCvd ?? 0))}), harga ${pct(h1h.priceChangePct as number | null)}, buyShare ${num(h1h.buySharePct as number | null, 1)}%`);
      }
      figures.push(`venue streaming ${d.venuesTrading ?? "?"}/${d.venuesExpected ?? "?"}`);
      const perVenue = (d.perVenue as Array<{ venue: string; delta: number }> | undefined) ?? [];
      const sorted = [...perVenue].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
      for (const v of sorted) figures.push(`  ${v.venue}: ${usd(v.delta)}`);
      // Konflik: arah CVD tidak sesuai arah harga, atau spot vs perp berbeda.
      if (h15 && h1h) {
        const c15 = Number(h15.cvdDelta ?? 0);
        const c1h = Number(h1h.cvdDelta ?? 0);
        const p15 = Number(h15.priceChangePct ?? 0);
        if (Math.sign(c15) !== 0 && Math.sign(p15) !== 0 && Math.sign(c15) !== Math.sign(p15)) {
          conflict.push(`15m: CVD ${c15 > 0 ? "positif" : "negatif"} vs harga ${pct(p15)} (divergence flow-harga)`);
        }
        if (Math.sign(c15) !== 0 && Math.sign(c1h) !== 0 && Math.sign(c15) !== Math.sign(c1h)) {
          conflict.push(`horizon: 15m CVD ${c15 > 0 ? "+" : ""}${usd(c15)} vs 1h ${c1h > 0 ? "+" : ""}${usd(c1h)} (berlawanan)`);
        }
        const spot = Number(h15.spotCvd ?? 0);
        const perp = Number(h15.perpCvd ?? 0);
        if (Math.sign(spot) !== 0 && Math.sign(perp) !== 0 && Math.sign(spot) !== Math.sign(perp)) {
          conflict.push(`market: spot ${usd(spot)} vs perp ${usd(perp)} (berlawanan)`);
        }
      }
      if (h15 && (h15.buySharePct as number | null) != null) {
        support.push(`buy share 15m ${num(h15.buySharePct as number, 1)}%`);
      }
      break;
    }
    case "walls": {
      const s = d.summary as Record<string, unknown> | null;
      if (s) {
        figures.push(`lifecycle 30m: APPEARED ${s.appeared ?? 0}, MOVED ${s.moved ?? 0}, PULLED ${s.pulled ?? 0}, EATEN ${s.eaten ?? 0}, AKTIF ${s.active ?? 0}`);
      }
      const walls = (d.topWalls as Array<{ side: string; price: number; notionalUsd: number; state: string }> | undefined) ?? [];
      for (const w of walls.slice(0, 4)) {
        figures.push(`  ${w.side} @ ${w.price} ${usd(w.notionalUsd)} (${w.state ?? "?"})`);
      }
      if (s) {
        const pulled = Number(s.pulled ?? 0);
        const eaten = Number(s.eaten ?? 0);
        if (pulled > eaten * 2 && pulled > 0) support.push(`wall lebih banyak DITARIK (${pulled}) daripada eaten (${eaten}) — likuiditas cenderung hilang, bukan ditransformasi`);
        if (eaten > pulled * 2 && eaten > 0) support.push(`wall lebih banyak DI-EATEN (${eaten}) daripada pulled (${pulled}) — likuiditas terserap pasar`);
        if (Number(s.active ?? 0) === 0) conflict.push("tidak ada wall aktif tersisa");
      }
      if (d.mid == null) missing.push("mid");
      break;
    }
    case "liqmap": {
      figures.push(`sumber ${d.source ?? "?"}, magnet ${d.magnetDirection ?? "NONE"}, stale ${d.stale === true ? "ya" : "tidak"}`);
      magnetSign = d.magnetDirection === "UP" ? 1 : d.magnetDirection === "DOWN" ? -1 : 0;
      const below = d.topClusterBelow as { price: number; liqUsd: number; distPct: number } | null;
      const above = d.topClusterAbove as { price: number; liqUsd: number; distPct: number } | null;
      if (below) figures.push(`cluster bawah: ${usd(below.liqUsd)} @ ${below.price} (${num(below.distPct, 2)}%)`);
      if (above) figures.push(`cluster atas: ${usd(above.liqUsd)} @ ${above.price} (${num(above.distPct, 2)}%)`);
      if (d.source !== "vike") missing.push("sumber bukan vike (sampling on-chain, coverage terbatas)");
      if (d.stale === true) conflict.push("data likuidasi basi (>2 mnt sejak sumber diambil)");
      if (below && above) {
        if (Math.sign(below.liqUsd) !== 0 && Math.sign(above.liqUsd) !== 0 && below.liqUsd > above.liqUsd * 1.5) {
          support.push(`klaster likuidasi long di bawah (${usd(below.liqUsd)}) lebih besar dari short di atas (${usd(above.liqUsd)})`);
        }
        if (above.liqUsd > below.liqUsd * 1.5) {
          support.push(`klaster short di atas (${usd(above.liqUsd)}) lebih besar dari long di bawah (${usd(below.liqUsd)})`);
        }
      }
      break;
    }
    case "largetrades_vp": {
      figures.push(`POC ${num(d.pocPrice as number | null, 4)}, VA ${num(d.valPrice as number | null, 4)}-${num(d.vahPrice as number | null, 4)}, harga vs VA: ${d.priceVsValueArea ?? "?"}`);
      figures.push(`volume 1h ${usd(Number(d.totalUsd ?? 0))}, buyShare di POC ${num(d.pocBuySharePct as number | null, 1)}%`);
      const trades = (d.largeTrades as Array<{ takerSide: string; usd: number; price: number; venue: string }> | undefined) ?? [];
      const buy = trades.filter((t) => t.takerSide === "BUY").reduce((a, t) => a + t.usd, 0);
      const sell = trades.filter((t) => t.takerSide === "SELL").reduce((a, t) => a + t.usd, 0);
      if (trades.length > 0) {
        figures.push(`transaksi besar ${trades.length} (>= ${usd(Number(d.largeTradeFloorUsd ?? 0))}): BUY ${usd(buy)} vs SELL ${usd(sell)}`);
        if (buy > sell * 1.5) support.push(`transaksi besar didominasi sisi BUY (${usd(buy)} vs ${usd(sell)})`);
        if (sell > buy * 1.5) support.push(`transaksi besar didominasi sisi SELL (${usd(sell)} vs ${usd(buy)})`);
      }
      if (d.partialWindow === true) missing.push("window volume 1h belum penuh (proses baru jalan)");
      break;
    }
    case "tierflow": {
      const bias = d.whaleRetailBias as Record<string, unknown> | null;
      figures.push(`bias whale/retail: ${bias?.bias ?? "?"}`);
      const tiers = (d.tiers as Array<{ tier: string; netDeltaUsd: number; buySharePct: number; trades: number }> | undefined) ?? [];
      for (const t of tiers.slice(0, 5)) {
        figures.push(`  ${t.tier}: net ${usd(Number(t.netDeltaUsd ?? 0))}, buyShare ${num(t.buySharePct, 1)}%, trade ${t.trades ?? 0}`);
      }
      const ex = (d.perExchangeDelta as Array<{ exchange: string; delta: number }> | undefined) ?? [];
      const sortedEx = [...ex].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
      for (const e of sortedEx) figures.push(`  ${e.exchange}: ${usd(e.delta)}`);
      const big = tiers.filter((t) => t.tier === "MEGA" || t.tier === "WHALE");
      const small = tiers.filter((t) => t.tier === "SMALL");
      const bigNet = big.reduce((a, t) => a + Number(t.netDeltaUsd ?? 0), 0);
      const smallNet = small.reduce((a, t) => a + Number(t.netDeltaUsd ?? 0), 0);
      // Sinyal flow tier = net tier besar (MEGA+WHALE) — pembanding order flow.
      flowUsd = bigNet;
      flowSign = Math.sign(bigNet);
      if (big.length > 0 && small.length > 0 && Math.sign(bigNet) !== 0 && Math.sign(smallNet) !== 0 && Math.sign(bigNet) !== Math.sign(smallNet)) {
        conflict.push(`tier besar net ${usd(bigNet)} berlawanan dengan tier kecil net ${usd(smallNet)}`);
      }
      const divs = (d.divergences as unknown[] | undefined) ?? [];
      if (divs.length > 0) conflict.push(`divergensi antar-bursa terdeteksi (${divs.length})`);
      break;
    }
    default:
      figures.push(JSON.stringify(d).slice(0, 200));
  }

  if (ev.status === "unavailable") missing.push("panel tidak tersedia");
  if (ev.status === "stale") missing.push("evidence basi (waktu sumber)");

  return {
    panel: ev.panel,
    status: ev.status,
    source: ev.venue,
    sourceTsMs: ev.sourceTsMs,
    ageMs: ev.sourceTsMs != null ? Math.max(0, now - ev.sourceTsMs) : null,
    figures,
    support,
    conflict,
    missing,
    signals: { flowSign, flowUsd, magnetSign, ageMs: ev.sourceTsMs != null ? Math.max(0, now - ev.sourceTsMs) : null },
  };
}

/** Brief gabungan: lima panel + konflik lintas panel. */
export function buildCombinedBrief(evidences: PanelEvidence[], now: number = Date.now()): {
  briefs: PanelBrief[];
  crossConflict: string[];
  stalePanels: PanelId[];
  missingPanels: PanelId[];
} {
  const briefs = evidences.map((e) => buildPanelBrief(e, now));
  const crossConflict: string[] = [];
  const stalePanels: PanelId[] = [];
  const missingPanels: PanelId[] = [];

  for (const b of briefs) {
    if (b.status === "stale") stalePanels.push(b.panel);
    if (b.status === "unavailable") missingPanels.push(b.panel);
  }

  // Konflik lintas panel memakai SINYAL NUMERIK (bukan parsing teks).
  const of = briefs.find((b) => b.panel === "orderflow");
  const tf = briefs.find((b) => b.panel === "tierflow");
  const lq = briefs.find((b) => b.panel === "liqmap");

  if (of && tf && of.signals.flowSign !== 0 && tf.signals.flowSign !== 0
    && of.signals.flowSign !== tf.signals.flowSign) {
    crossConflict.push(`order flow (CVD 15m ${usd(of.signals.flowUsd)}) dan tier flow (net tier besar ${usd(tf.signals.flowUsd)}) berlawanan arah`);
  }
  if (lq && of && lq.signals.magnetSign !== 0 && of.signals.flowSign !== 0) {
    const mag = lq.signals.magnetSign > 0 ? "UP" : "DOWN";
    if (lq.signals.magnetSign !== of.signals.flowSign) {
      crossConflict.push(`magnet likuidasi ${mag} tapi order flow 15m ${of.signals.flowSign > 0 ? "positif" : "negatif"}`);
    }
  }
  const staleSet = new Set(stalePanels);
  if (staleSet.size > 0) {
    crossConflict.push(`evidence basi pada panel: ${stalePanels.join(", ")} — kesimpulan untuk panel itu TIDAK boleh dianggap current`);
  }
  if (missingPanels.length > 0) {
    crossConflict.push(`panel tidak tersedia: ${missingPanels.join(", ")} — kesimpulan parsial`);
  }

  return { briefs, crossConflict, stalePanels, missingPanels };
}

/** Render brief menjadi teks prompt ringkas (tanpa narasi panjang). */
export function renderBrief(brief: PanelBrief): string {
  const lines: string[] = [];
  lines.push(`Panel ${brief.panel} | status=${brief.status} | sumber=${brief.source} | waktu_sumber=${brief.sourceTsMs ?? "tidak diketahui"} | umur=${ageLabel(brief.ageMs)}`);
  if (brief.figures.length) lines.push(`Angka: ${brief.figures.join(" | ")}`);
  if (brief.support.length) lines.push(`Pendukung: ${brief.support.join(" | ")}`);
  if (brief.conflict.length) lines.push(`Konflik: ${brief.conflict.join(" | ")}`);
  if (brief.missing.length) lines.push(`Hilang: ${brief.missing.join(", ")}`);
  return lines.join("\n");
}
