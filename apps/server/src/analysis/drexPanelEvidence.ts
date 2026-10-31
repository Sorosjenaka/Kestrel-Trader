// apps/server/src/analysis/drexPanelEvidence.ts — 26 Okt 2026 (TAHAP 6B + DREX v2)
//
// SNAPSHOT EVIDENCE LIMA PANEL untuk Drex SWING v2 (SHADOW, non-mengikat).
//
// Aturan (dari perintah operator):
//  - Satu snapshot TERSTRUKTUR & IMMUTABLE, diambil SESUDAH kandidat lolos gate
//    deterministik tapi SEBELUM runSwingDrexJudge.
//  - Semua angka dihitung kode deterministik. LLM (Drex) hanya menafsirkan.
//  - Simbol kandidat: evidence HARUS milik instrumen kandidat. BTC macro terpisah.
//    Pair yang tidak didukung panel -> UNAVAILABLE + alasan, BUKAN nol/netral.
//  - Empat jenis waktu dibedakan: sourceEventTs, receivedTs, snapshotAt, generatedAt.
//    Waktu sumber yang tidak diketahui = UNKNOWN (null), bukan waktu sekarang.
//  - Snapshot diserialisasi (deep copy) sebelum kerja async — tidak menyimpan
//    referensi objek hub yang bisa berubah.

import { createHash } from "node:crypto";
import {
  gatherPanelEvidence, PANEL_AI_SCHEMA_VERSION, PANEL_EVIDENCE_MAX_AGE_MS,
  type PanelEvidence, type PanelId,
} from "./panelEvidence.js";
import { buildCombinedBrief, buildPanelBrief } from "./panelBrief.js";
import type { PanelBrief } from "./panelEvidence.js";

export const DREX_PANEL_EVIDENCE_SCHEMA_VERSION = "artatrade-drex-panel-evidence-v1";

/** Kualitas evidence per panel — dibedakan tegas, tidak ada "netral". */
export type EvidenceQuality = "fresh" | "stale" | "partial" | "unavailable" | "unknown";

export interface PanelEvidenceSnapshot {
  panel: PanelId;
  evidenceId: string;
  status: EvidenceQuality;
  /** Waktu event di sumber (null = UNKNOWN). */
  sourceEventTsMs: number | null;
  /** Waktu data diterima proses (null = UNKNOWN). */
  receivedTsMs: number | null;
  /** Umur evidence sumber saat snapshot (ms); null bila waktu sumber UNKNOWN. */
  ageMs: number | null;
  source: string;
  window: string;
  /** Angka relevan (deterministik, sudah diformat). */
  figures: string[];
  support: string[];
  conflict: string[];
  missing: string[];
  /** Evidence wajib untuk evaluasi v2? Panel inti = wajib, tierflow = opsional. */
  required: boolean;
}

export interface DrexPanelSnapshot {
  schemaVersion: string;
  featureVersion: string;
  /** Identitas untuk dipasangkan dengan verdict v1 (kolom yang sama). */
  correlationId: string;
  candidateId: string;
  planId: string;
  strategyId: string;
  symbol: string;
  /** Simbol kanonik yang evidence-nya benar-benar diambil. */
  evidenceSymbol: string;
  side: string;
  venue: string;
  marketType: string;
  horizon: string;
  /** Waktu snapshot dirakit (kode). */
  capturedAtMs: number;
  /** Panel inti (wajib) + panel opsional. */
  panels: PanelEvidenceSnapshot[];
  /** Ringkasan lintas panel. */
  crossConflict: string[];
  stalePanels: PanelId[];
  unavailablePanels: PanelId[];
  /** Ringkasan coverage — untuk event perbandingan. */
  coverage: {
    total: number;
    fresh: number;
    stale: number;
    partial: number;
    unavailable: number;
    unknown: number;
  };
  /** Hash input untuk penelusuran alasan keputusan. */
  inputHash: string;
}

/** Panel yang WAJIB ada untuk evaluasi v2 (inti struktur likuiditas). */
const REQUIRED_PANELS: PanelId[] = ["orderflow", "walls", "liqmap", "largetrades_vp"];
/** Panel opsional: boleh hilang tanpa membatalkan evaluasi, tapi harus disebut. */
const OPTIONAL_PANELS: PanelId[] = ["tierflow"];

/**
 * Winsorized base coin. Menghapus suffix quote SENDIRI bisa salah (mis. "USDC"
 * vs koin bernama "...USDC"), jadi hanya suffix yang dipakai venue futures
 * Binance yang dipangkas, dan hasilnya divalidasi.
 */
export function canonicalEvidenceSymbol(symbol: string): { base: string; ok: boolean; reason?: string } {
  const s = symbol.trim().toUpperCase();
  if (!s) return { base: "", ok: false, reason: "SYMBOL_EMPTY" };
  for (const suffix of ["USDT", "USDC"]) {
    if (s.length > suffix.length && s.endsWith(suffix)) {
      const base = s.slice(0, -suffix.length);
      // Base coin harus huruf/angka saja — kalau tidak, ini simbol venue lain.
      if (!/^[A-Z0-9]{1,15}$/.test(base)) {
        return { base, ok: false, reason: "BASE_COIN_INVALID" };
      }
      return { base, ok: true };
    }
  }
  // Sudah base coin (mis. BTC untuk panel).
  if (!/^[A-Z0-9]{1,15}$/.test(s)) return { base: s, ok: false, reason: "SYMBOL_INVALID" };
  return { base: s, ok: true };
}

function qualityOf(ev: PanelEvidence): EvidenceQuality {
  if (ev.status === "unavailable") return "unavailable";
  // Umur evidence sumber DIUTAMBAHKAN dengan status mentah hub: kalau hub
  // melapor "fresh" tapi datanya sudah lebih tua dari batas, tetap basi.
  if (ev.sourceTsMs != null && ev.ageMs != null && ev.ageMs > PANEL_EVIDENCE_MAX_AGE_MS) return "stale";
  if (ev.status === "stale") return "stale";
  if (ev.status === "partial") return "partial";
  // "fresh" hanya kalau waktu sumber diketahui dan belum basi.
  if (ev.sourceTsMs == null) return "unknown";
  return "fresh";
}

function toSnapshot(ev: PanelEvidence, brief: PanelBrief, required: boolean): PanelEvidenceSnapshot {
  const q = qualityOf(ev);
  // evidenceId stabil untuk penelusuran: hash isi brief + waktu sumber.
  const evidenceId = createHash("sha256")
    .update(`${ev.panel}|${ev.sourceTsMs ?? "UNKNOWN"}|${JSON.stringify(brief.figures)}`)
    .digest("hex").slice(0, 16);
  return {
    panel: ev.panel,
    evidenceId,
    // Status memakai penilaian berbasis umur (bukan status mentah hub).
    status: q,
    sourceEventTsMs: ev.sourceTsMs,
    receivedTsMs: ev.receivedAtMs,
    ageMs: ev.ageMs,
    source: ev.venue,
    window: ev.window,
    figures: brief.figures,
    support: brief.support,
    conflict: brief.conflict,
    missing: q === "stale"
      ? [...brief.missing, "evidence basi (umur sumber melebihi batas)"]
      : q === "unknown"
        ? [...brief.missing, "waktu sumber tidak diketahui (UNKNOWN)"]
        : brief.missing,
    required,
  };
}

/**
 * Ambil snapshot evidence kandidat. Memanggil gatherPanelEvidence untuk simbol
 * kandidat HANYA — data BTC tidak pernah masuk ke sini sebagai data pair.
 */
export async function captureDrexPanelSnapshot(input: {
  symbol: string;
  side: string;
  strategyId: string;
  planId: string;
  candidateId: string;
  correlationId: string;
  marketType?: string;
  venue?: string;
  horizon?: string;
}): Promise<DrexPanelSnapshot> {
  const canon = canonicalEvidenceSymbol(input.symbol);
  const evidenceSymbol = canon.base;
  // Simbol tidak valid -> snapshot kosong dengan alasan (bukan data BTC).
  const evidences: PanelEvidence[] = canon.ok
    ? await gatherPanelEvidence(evidenceSymbol)
    : [];

  const now = Date.now();
  const briefs = evidences.map((e) => buildPanelBrief(e, now));
  const combined = buildCombinedBrief(evidences, now);

  const panels: PanelEvidenceSnapshot[] = [];
  for (const ev of evidences) {
    const brief = briefs.find((b) => b.panel === ev.panel)!;
    const required = REQUIRED_PANELS.includes(ev.panel);
    panels.push(toSnapshot(ev, brief, required));
  }
  // Panel yang tidak kembali dari hub = UNAVAILABLE + alasan (bukan nol).
  for (const p of [...REQUIRED_PANELS, ...OPTIONAL_PANELS]) {
    if (panels.some((x) => x.panel === p)) continue;
    panels.push({
      panel: p,
      evidenceId: `ev_${p}_unavailable`,
      status: canon.ok ? "unavailable" : "unavailable",
      sourceEventTsMs: null,
      receivedTsMs: null,
      ageMs: null,
      source: "none",
      window: "n/a",
      figures: [],
      support: [],
      conflict: [],
      missing: [canon.ok ? `panel ${p} tidak mengembalikan data` : `simbol tidak valid: ${canon.reason}`],
      required: REQUIRED_PANELS.includes(p),
    });
  }

  // Stale panel ditentukan dari UMUR evidence sumber (bukan hanya status
  // mentah dari hub) — supaya "basi" terdeteksi juga ketika hub melapor fresh
  // padahal datanya sudah tua.
  const stalePanels: PanelId[] = panels.filter((p) => p.status === "stale").map((p) => p.panel);
  const unavailablePanels: PanelId[] = panels.filter((p) => p.status === "unavailable").map((p) => p.panel);

  const coverage = {
    total: panels.length,
    fresh: panels.filter((p) => p.status === "fresh").length,
    stale: stalePanels.length,
    partial: panels.filter((p) => p.status === "partial").length,
    unavailable: unavailablePanels.length,
    unknown: panels.filter((p) => p.status === "unknown").length,
  };

  const snapshot: DrexPanelSnapshot = {
    schemaVersion: DREX_PANEL_EVIDENCE_SCHEMA_VERSION,
    featureVersion: PANEL_AI_SCHEMA_VERSION,
    correlationId: input.correlationId,
    candidateId: input.candidateId,
    planId: input.planId,
    strategyId: input.strategyId,
    symbol: input.symbol.toUpperCase(),
    evidenceSymbol,
    side: input.side,
    venue: input.venue ?? "BINANCE_PERP",
    marketType: input.marketType ?? "PERPETUAL",
    horizon: input.horizon ?? "H1/H4",
    capturedAtMs: now,
    panels,
    crossConflict: combined.crossConflict,
    stalePanels,
    unavailablePanels,
    coverage,
    inputHash: "",
  };
  // Hash dihitung dari isi final (tanpa hash itu sendiri) -> deterministik.
  snapshot.inputHash = createHash("sha256")
    .update(JSON.stringify({ ...snapshot, inputHash: "" }))
    .digest("hex").slice(0, 16);
  return snapshot;
}

/**
 * Kualitas evidence SAAT INI untuk snapshot yang sudah diambil (dipakai
 * sebelum request shadow dikirim, setelah antre). Memakai `capturedAtMs`
 * sebagai titik acuan: evidence yang sudah basi sejak capture TIDAK boleh
 * diperbarui diam-diam.
 */
export function snapshotFreshnessAt(snapshot: DrexPanelSnapshot, atMs: number = Date.now()): {
  status: EvidenceQuality;
  stalePanels: PanelId[];
  maxAgeMs: number | null;
  /** true = masih layak dipakai untuk shadow. */
  usable: boolean;
} {
  const stalePanels: PanelId[] = [];
  const ages: number[] = [];
  for (const p of snapshot.panels) {
    if (p.sourceEventTsMs == null) continue;
    const age = Math.max(0, atMs - p.sourceEventTsMs);
    ages.push(age);
    if (age > PANEL_EVIDENCE_MAX_AGE_MS) stalePanels.push(p.panel);
  }
  const maxAgeMs = ages.length > 0 ? Math.max(...ages) : null;
  // Panel inti yang basi = tidak bisa dipakai. Panel opsional boleh basi.
  const requiredStale = stalePanels.some((p) => REQUIRED_PANELS.includes(p));
  const requiredUnavailable = snapshot.panels
    .filter((p) => p.required)
    .some((p) => p.status === "unavailable");
  return {
    status: stalePanels.length > 0 ? "stale" : (maxAgeMs == null ? "unknown" : "fresh"),
    stalePanels,
    maxAgeMs,
    usable: !requiredStale && !requiredUnavailable,
  };
}

/** Render snapshot menjadi brief deterministik untuk input Drex v2. */
export function renderDrexPanelBrief(snapshot: DrexPanelSnapshot, atMs: number = Date.now()): {
  brief: string;
  freshness: ReturnType<typeof snapshotFreshnessAt>;
} {
  const freshness = snapshotFreshnessAt(snapshot, atMs);
  const lines: string[] = [];
  lines.push(`EVIDENCE LIMA PANEL (${snapshot.schemaVersion}) untuk ${snapshot.symbol} ${snapshot.side} ${snapshot.horizon}`);
  lines.push(`symbol_evidence=${snapshot.evidenceSymbol} | market=${snapshot.marketType} | venue=${snapshot.venue} | capturedAt=${snapshot.capturedAtMs}`);
  lines.push(`coverage: fresh=${snapshot.coverage.fresh} stale=${snapshot.coverage.stale} partial=${snapshot.coverage.partial} unavailable=${snapshot.coverage.unavailable} unknown=${snapshot.coverage.unknown}`);
  for (const p of snapshot.panels) {
    const age = p.sourceEventTsMs == null ? "UNKNOWN" : `${Math.round((atMs - p.sourceEventTsMs) / 1000)}dtk`;
    const recv = p.receivedTsMs == null ? "UNKNOWN" : `${Math.round((atMs - p.receivedTsMs) / 1000)}dtk`;
    lines.push(`## ${p.panel} [${p.status}${p.required ? ", wajib" : ", opsional"}] evidenceId=${p.evidenceId}`);
    lines.push(`   sumber=${p.source} window=${p.window} umur_sumber=${age} umur_terima=${recv}`);
    if (p.figures.length) lines.push(`   angka: ${p.figures.join(" | ")}`);
    if (p.support.length) lines.push(`   pendukung: ${p.support.join(" | ")}`);
    if (p.conflict.length) lines.push(`   konflik: ${p.conflict.join(" | ")}`);
    if (p.missing.length) lines.push(`   hilang: ${p.missing.join(", ")}`);
  }
  if (snapshot.crossConflict.length) {
    lines.push(`konflik_lintas_panel: ${snapshot.crossConflict.join(" | ")}`);
  }
  if (freshness.stalePanels.length) {
    lines.push(`PERINGATAN_FRESHNESS: panel basi sejak capture: ${freshness.stalePanels.join(", ")} — kesimpulan untuk panel itu TIDAK boleh dianggap current.`);
  }
  if (freshness.maxAgeMs == null) {
    lines.push("PERINGATAN_FRESHNESS: waktu sumber tidak diketahui (UNKNOWN) untuk sebagian panel — kesimpulan terbatas.");
  }
  lines.push("Semua angka di atas dihitung kode. JANGAN mengarang angka/kondisi yang tidak ada di sini.");
  lines.push("Confidence = skor model, BUKAN probabilitas menang terkalibrasi.");
  return { brief: lines.join("\n"), freshness };
}
