// apps/server/src/agents/researchLayer.ts - Agen Lapis Riset & Scanner (FR-26, US-05, US-10).
import { XkiroAdapter, defaultLlmAdapter } from "./llmAdapter.js";
import { db } from "../core/db.js";
import { buildMicrostructurePromptBlock } from "./marketIntel.js";
import type { AltMatrixResult } from "../engines/macroGate.js";

export interface AgentProfile {
  id: string;
  name: string;
  personality: string;
  style: string;
  colors: [string, string];
  model: "FAST" | "REASON";
}

export const RESEARCH_AGENTS: Record<string, AgentProfile> = {
  "macro-scout": {
    id: "macro-scout",
    name: "Vega",
    personality: "Tenang, ringkas, berbasis angka",
    style: "BTC 1 jam: TRENDING naik, ADX 27. Alt long terkendali; SL di bawah swing low.",
    colors: ["#14B8A6", "#64748B"],
    model: "FAST",
  },
  "universe-curator": {
    id: "universe-curator",
    name: "Sena",
    personality: "Perfeksionis, tegas, suka checklist",
    style: "Dua simbol baru masuk; nol non-crypto lolos. Audit bersih.",
    colors: ["#F59E0B", "#1E3A8A"],
    model: "FAST",
  },
  "regime-analyst": {
    id: "regime-analyst",
    name: "Rhea",
    personality: "Pendiam, observasional, metafora cuaca",
    style: "Pasar sedang mendung tipis; chop naik, hati-hati.",
    colors: ["#8B5CF6", "#1F2937"],
    model: "FAST",
  },
  "scanner-supervisor": {
    id: "scanner-supervisor",
    name: "Bima",
    personality: "Koordinator cepat, bahasa komando",
    style: "50 pemindai jalan; 3 kandidat lolos, ranking siap.",
    colors: ["#22C55E", "#374151"],
    model: "FAST",
  },
};

export interface AgentDialog {
  agentId: string;
  name: string;
  text: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

export class ResearchLayer {
  private readonly adapter: XkiroAdapter;
  private readonly memory = new Map<string, string[]>();

  constructor(adapter?: XkiroAdapter) {
    this.adapter = adapter ?? defaultLlmAdapter;
  }

  private appendMemory(agentId: string, text: string) {
    const list = this.memory.get(agentId) ?? [];
    list.push(text);
    if (list.length > 10) list.shift();
    this.memory.set(agentId, list);
  }
  /** Panggilan LLM dengan fallback deterministik berlabel (tidak pernah 500 dari route riset). */
  private async narrate(userPrompt: string, sysPrompt: string, fallbackText: string): Promise<{ text: string; byLlm: boolean }> {
    try {
      const res = await this.adapter.callFast(userPrompt, sysPrompt);
      const text = res.content.trim();
      if (text.length > 0) return { text, byLlm: true };
    } catch {}
    return { text: fallbackText, byLlm: false };
  }

  /**
   * BAGIAN 3: blok mikrostruktur & order flow live (5 modul) untuk agen
   * lapis riset. Fail-open: string kosong bila hub belum siap, sehingga
   * prompt & perilaku agen tidak berubah.
   */
  private async microBlock(symbol = "BTC"): Promise<string> {
    return buildMicrostructurePromptBlock(symbol);
  }


  /** T-19: narasi LLM untuk brief riset harian. Angka SUDAH dihitung TS dan tidak
   * boleh diubah/dihitung ulang oleh LLM (Golden Rules #1); LLM hanya menulis
   * kalimat pola dari angka yang diberikan. Label byLlm tidak pernah menyamarkan
   * fallback sebagai jawaban LLM. */
  async narrateResearchBrief(stats: { strategyId: string; trades: number; winRatePct: number; evUsd: number }[], label: string): Promise<{ text: string; byLlm: boolean }> {
    const table = stats
      .map((s) => `${s.strategyId}: ${s.trades} trade, WR ${s.winRatePct.toFixed(1)}%, EV ${s.evUsd.toFixed(4)}`)
      .join("; ");
    const sysPrompt =
      "Anda penulis ringkasan riset trading. Angka berikut sudah dihitung sistem dan TIDAK BOLEH Anda ubah " +
      "atau menghitung ulang nominal uang. Jawab maksimal tiga kalimat Bahasa Indonesia: kondisi performa, " +
      "penyebab utama, dan satu hal yang layak diuji berikutnya.";
    const userPrompt = `Statistik ${label}: ${table || "(belum ada trade tertutup)"}.`;
    const fallback = "Narasi otomatis tidak tersedia (provider LLM gagal); angka di atas tetap berlaku apa adanya.";
    return this.narrate(userPrompt, sysPrompt, fallback);
  }

  /** Vega mengamati enam kondisi BTC.D x BTC sebelum Arka menilai kandidat alt.
   * Hasil matriks tetap deterministik; teks LLM adalah analisis, bukan override. */
  async observeAltMatrix(data: {
    symbol: string;
    side: "LONG" | "SHORT";
    btcTrend: string;
    btcAdx: number;
    btc1hChgPct: number;
    eth1hChgPct: number;
    btcDomChg1hPct: number;
    matrix: AltMatrixResult;
    macroAllowed: boolean;
    macroDetail: string;
  }): Promise<{ dialog: AgentDialog; byLlm: boolean }> {
    const profile = RESEARCH_AGENTS["macro-scout"];
    const map = "BTC.D naik + BTC naik = alt DECREASE; BTC.D naik + BTC turun = DUMP; " +
      "BTC.D naik + BTC stabil = STABLE; BTC.D turun + BTC naik = PUMP; " +
      "BTC.D turun + BTC turun = STABLE; BTC.D turun + BTC stabil = INCREASE.";
    const sysPrompt = `Anda Vega, pengamat makro indeks Binance BTCDOM (proksi BTC dominance, bukan persentase kapitalisasi BTC.D) x harga BTC. ${map} ` +
      "Label matriks sudah dihitung kode dan tidak boleh Anda ubah. ETH adalah konteks tambahan. " +
      "Jawab maksimal tiga kalimat pendek dalam Bahasa Indonesia: kondisi angka, bias alt, implikasi arah kandidat. " +
      "Anda tidak boleh mengubah hard gate makro, filter sideways pair, sizing, atau keputusan akhir Arka/Wardha.";
    const userPrompt = `Observasi matriks untuk ${data.symbol} ${data.side}: BTC.D 1h ${data.btcDomChg1hPct}%, ` +
      `BTC 1h ${data.btc1hChgPct}% (${data.btcTrend}, ADX ${data.btcAdx}), ETH 1h ${data.eth1hChgPct}%. ` +
      `Hasil kode baris ${data.matrix.row}: ${data.matrix.bias}; ETH konfirmasi=${data.matrix.ethConfirmed}; ` +
      `arah kandidat sesuai matriks=${data.side === "LONG" ? data.matrix.allowLongAlt : data.matrix.allowShortAlt}; ` +
      `gate makro=${data.macroAllowed ? "PASS" : "BLOCK"} (${data.macroDetail}).\n` +
      `${await this.microBlock("BTC")}`;
    let text = "";
    let byLlm = false;
    try {
      const res = await this.adapter.callFast(userPrompt, sysPrompt, { maxTokens: 1200, timeoutMs: 5000 });
      text = res.content.trim();
      byLlm = text.length > 0;
    } catch { /* observasi gagal; hasil kode tetap sumber kebenaran */ }
    if (!byLlm) text = `Matriks baris ${data.matrix.row} = ${data.matrix.bias}; ` +
      `${data.symbol} ${data.side} gate makro ${data.macroAllowed ? "PASS" : "BLOCK"}. Observasi LLM tidak tersedia.`;
    this.appendMemory(profile.id, text);
    const dialog: AgentDialog = { agentId: profile.id, name: profile.name, text,
      timestamp: new Date().toISOString(), context: { symbol: data.symbol, side: data.side,
        matrixRow: data.matrix.row, altBias: data.matrix.bias, ethConfirmed: data.matrix.ethConfirmed,
        macroAllowed: data.macroAllowed, byLlm } };
    await this.logDialog(dialog);
    return { dialog, byLlm };
  }

  async runMacroScout(data: {
    btcTrend: string;
    btcAdx: number;
    btc1hChgPct: number;
    ethTrend: string;
    eth1hChgPct: number;
    btcDomChg1hPct: number;
  }): Promise<{ allowed: boolean; dialog: AgentDialog }> {
    const profile = RESEARCH_AGENTS["macro-scout"];
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), agen makro di Private Trade AI. Kepribadian: ${profile.personality}. Gaya: ${profile.style}. Berikan evaluasi 1-2 kalimat padat angka dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Data makro: BTC ${data.btcTrend}, ADX=${data.btcAdx}, 1h=${data.btc1hChgPct}%. ETH 1h=${data.eth1hChgPct}%. BTC.D 1h=${data.btcDomChg1hPct}%. Aman entry?\n` +
      `${await this.microBlock("BTC")}`;

    const { text, byLlm } = await this.narrate(userPrompt, sysPrompt, `Riset offline: BTC ${data.btcTrend} ADX ${data.btcAdx}, ETH 1h ${data.eth1hChgPct}%, BTC.D 1h ${data.btcDomChg1hPct}% (LLM tidak tersedia).`);
    this.appendMemory(profile.id, text);

    const isDomSpike = data.btcDomChg1hPct > 0.5;
    const isBtcDump = data.btc1hChgPct < -1.5;
    const allowed = !isDomSpike && !isBtcDump;

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { btc1hChgPct: data.btc1hChgPct, btcDomChg1hPct: data.btcDomChg1hPct, allowed, byLlm },
    };

    await this.logDialog(dialog);
    return { allowed, dialog };
  }

  async runUniverseCurator(data: {
    totalSymbols: number;
    cryptoPerpsCount: number;
    nonCryptoFiltered: number;
    manualBlacklistCount: number;
  }): Promise<{ audited: boolean; dialog: AgentDialog }> {
    const profile = RESEARCH_AGENTS["universe-curator"];
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), kurator universe simbol di Private Trade AI. Kepribadian: ${profile.personality}. Gaya: ${profile.style}. Berikan 1-2 kalimat ringkas checklist dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Universe: total ${data.totalSymbols}, crypto-perps ${data.cryptoPerpsCount}, non-crypto filtered ${data.nonCryptoFiltered}, blacklist ${data.manualBlacklistCount}. Status audit?\n` +
      `${await this.microBlock("BTC")}`;

    const { text, byLlm } = await this.narrate(userPrompt, sysPrompt, `Riset offline: ${data.cryptoPerpsCount} crypto-perps diaudit, ${data.nonCryptoFiltered} non-crypto disaring, blacklist ${data.manualBlacklistCount} (LLM tidak tersedia).`);
    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { cryptoPerps: data.cryptoPerpsCount, nonCryptoFiltered: data.nonCryptoFiltered, byLlm },
    };

    await this.logDialog(dialog);
    return { audited: true, dialog };
  }
  async runRegimeAnalyst(data: {
    symbol: string;
    regime: string;
    chopIndex: number;
    adx: number;
    shieldActive: boolean;
  }): Promise<{ regime: string; dialog: AgentDialog }> {
    const profile = RESEARCH_AGENTS["regime-analyst"];
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), analis regime di Private Trade AI. Kepribadian: ${profile.personality}. Gaya: ${profile.style}. Evaluasi cuaca pasar 1-2 kalimat dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Simbol ${data.symbol}: regime=${data.regime}, chop=${data.chopIndex}, ADX=${data.adx}, shield=${data.shieldActive ? "AKTIF" : "OFF"}. Kondisi pasar?\n` +
      `${await this.microBlock(data.symbol)}`;

    const { text, byLlm } = await this.narrate(userPrompt, sysPrompt, `Riset offline: ${data.symbol} ${data.regime} chop ${data.chopIndex} ADX ${data.adx}, shield ${data.shieldActive ? "AKTIF" : "OFF"} (LLM tidak tersedia).`);
    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { symbol: data.symbol, regime: data.regime, shieldActive: data.shieldActive, byLlm },
    };

    await this.logDialog(dialog);
    return { regime: data.regime, dialog };
  }

  async runScannerSupervisor(data: {
    activeWorkers: number;
    totalPairsScanned: number;
    candidatesPassed: number;
    topSymbol?: string;
    topScore?: number;
  }): Promise<{ ready: boolean; dialog: AgentDialog }> {
    const profile = RESEARCH_AGENTS["scanner-supervisor"];
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), koordinator scanner di Private Trade AI. Kepribadian: ${profile.personality}. Gaya: ${profile.style}. Berikan 1-2 kalimat komando dan ranking dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Scan: ${data.activeWorkers} workers, ${data.totalPairsScanned} pair, lolos ${data.candidatesPassed}, top 1 ${data.topSymbol ?? "None"} (${data.topScore ?? 0}). Kesiapan pemindai?\n` +
      `${await this.microBlock("BTC")}`;

    const { text, byLlm } = await this.narrate(userPrompt, sysPrompt, `Riset offline: ${data.activeWorkers} pemindai jalan; ${data.candidatesPassed} kandidat lolos, ranking siap (LLM tidak tersedia).`);
    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { candidatesPassed: data.candidatesPassed, topSymbol: data.topSymbol, byLlm },
    };

    await this.logDialog(dialog);
    return { ready: data.candidatesPassed > 0, dialog };
  }

  private async logDialog(dialog: AgentDialog) {
    try {
      await db.eventLog.create({
        data: {
          type: "AGENT_DIALOG",
          severity: "info",
          payload: JSON.stringify(dialog),
        },
      });
    } catch {
      // toleransi jika tabel DB mock
    }
  }
}

export const defaultResearchLayer = new ResearchLayer();

