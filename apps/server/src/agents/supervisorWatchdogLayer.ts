// apps/server/src/agents/supervisorWatchdogLayer.ts - Agen Supervisor & Watchdog: Trade Supervisor & Watchdog (FR-26, US-13).
import { XkiroAdapter, defaultLlmAdapter } from "./llmAdapter.js";
import { AgentDialog, AgentProfile } from "./researchLayer.js";
import { db } from "../core/db.js";
import { buildMicrostructurePromptBlock } from "./marketIntel.js";

export const SUPERVISOR_WATCHDOG_AGENTS: Record<string, AgentProfile> = {
  "trade-supervisor": {
    id: "trade-supervisor",
    name: "Nadira",
    personality: "Sigap, hangat, membimbing",
    style: "TP kena. 100 persen posisi ditutup di target tunggal.",
    colors: ["#38BDF8", "#334155"], // biru langit + baja
    model: "FAST",
  },
  "watchdog": {
    id: "watchdog",
    name: "Raksa",
    personality: "Waspada, blak-blakan, gotong pendek",
    style: "fapi2 lambat tiga percobaan. Sudah pindah host.",
    colors: ["#EAB308", "#111827"], // kuning hazard + hitam
    model: "FAST",
  },
};

export interface TradeSupervisorEvent {
  positionId: number;
  symbol: string;
  side: "LONG" | "SHORT";
  event: "TP1_HIT" | "SL_HIT" | "FUNDING" | "TREND_FLIP";
  price: number;
  entryPrice: number;
  pnlUsd?: number;
  rMultiple?: number;
}

export interface WatchdogEvent {
  context: "HOST_SWITCH" | "WS_GAP" | "CIRCUIT_BREAKER" | "CLOCK_DRIFT" | "HEALTH_OK";
  activeHost?: string;
  previousHost?: string;
  failsCount?: number;
  wsGapSec?: number;
  driftMs?: number;
}

export class SupervisorWatchdogLayer {
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

  async runTradeSupervisor(event: TradeSupervisorEvent): Promise<{ action: string; dialog: AgentDialog }> {
    const profile = SUPERVISOR_WATCHDOG_AGENTS["trade-supervisor"];
    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), supervisor trade di Private Trade AI.
Kepribadian Anda: ${profile.personality}.
Gaya bicara: ${profile.style}.
Tugas: Laporkan status transisi posisi secara hangat dan membimbing. 1-2 kalimat dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Event posisi #${event.positionId} ${event.symbol} (${event.side}):
- Status: ${event.event} pada harga $${event.price} (entry: $${event.entryPrice})
- PnL: $${event.pnlUsd ?? 0} (${event.rMultiple ?? 0}R)
${await buildMicrostructurePromptBlock(event.symbol)}
Bagaimana instruksi supervisi Anda?`;

    let text = "";
    try {
      // TAHAP 6B: supervisi posisi = jalur KRITIS (slot cadangan LLM).
      // Narasi panel AI tidak boleh menunda rekomendasi supervisi posisi.
      const res = await this.adapter.callFast(userPrompt, sysPrompt, {
        queuePriority: "critical",
        fairnessKey: `supervisor:${event.symbol}`,
      });
      text = res.content.trim();
    } catch {
      switch (event.event) {
        case "TREND_FLIP":
          text = `Trend berbalik melawan ${event.side} di $${event.price}. Sisa posisi ditutup cerdas; profit yang terkunci diamankan.`;
          break;
        case "TP1_HIT":
          text = `TP kena di $${event.price} (entry $${event.entryPrice}). 100 persen posisi ditutup di target tunggal; profit diamankan penuh.`;
          break;
        case "FUNDING":
          text = `Jadwal funding rate mendekat dan merugikan. Posisi ditutup di $${event.price} untuk menghindari biaya funding.`;
          break;
        default:
          text = `Stop loss terkena di $${event.price}. Posisi dipotong rapi sesuai batas risiko $1.`;
      }
    }

    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { event: event.event, symbol: event.symbol, price: event.price },
    };

    await this.logDialog(dialog);
    return { action: event.event, dialog };
  }
  async runWatchdog(event: WatchdogEvent): Promise<{ alertLevel: "OK" | "WARN" | "CRITICAL"; dialog: AgentDialog }> {
    const profile = SUPERVISOR_WATCHDOG_AGENTS["watchdog"];
    const isCritical = event.context === "CIRCUIT_BREAKER" || (event.failsCount ?? 0) >= 5 || (event.wsGapSec ?? 0) > 5;
    const isWarn = event.context === "HOST_SWITCH" || (event.wsGapSec ?? 0) > 2 || (event.driftMs ?? 0) > 1000;
    const alertLevel: "OK" | "WARN" | "CRITICAL" = isCritical ? "CRITICAL" : isWarn ? "WARN" : "OK";

    const sysPrompt = `Anda adalah ${profile.name} (${profile.id}), pengawas watchdog infrastruktur di Private Trade AI.
Kepribadian Anda: ${profile.personality}.
Gaya bicara: ${profile.style}.
Tugas: Laporan blak-blakan status koneksi Binance, failover, atau drift jam. 1-2 kalimat lugas dalam Bahasa Indonesia tanpa emoji.`;

    const userPrompt = `Laporan infrastruktur ${event.context}:
- Host aktif: ${event.activeHost ?? "default"} (sebelumnya: ${event.previousHost ?? "-"})
- Gagal beruntun: ${event.failsCount ?? 0}
- Gap WebSocket: ${event.wsGapSec ?? 0} detik
- Clock drift: ${event.driftMs ?? 0} ms
${await buildMicrostructurePromptBlock("BTC")}
Status pengawasan Anda?`;

    let text = "";
    try {
      const res = await this.adapter.callFast(userPrompt, sysPrompt);
      text = res.content.trim();
    } catch {
      switch (event.context) {
        case "HOST_SWITCH":
          text = `${event.previousHost ?? "Host"} lambat ${event.failsCount ?? 3} percobaan. Sudah pindah ke ${event.activeHost}.`;
          break;
        case "WS_GAP":
          text = `Stream WebSocket macet ${event.wsGapSec} detik. Karantina aktif, resubscribe stream.`;
          break;
        case "CIRCUIT_BREAKER":
          text = `Circuit breaker terbuka selama 30 detik; host utama tidak stabil. Failover pool diprioritaskan.`;
          break;
        case "CLOCK_DRIFT":
          text = `Drift jam server ${event.driftMs} ms. Sinkronisasi offset otomatis disesuaikan.`;
          break;
        default:
          text = `Semua jalur data dan koneksi WebSocket berjalan normal tanpa hambatan.`;
      }
    }

    this.appendMemory(profile.id, text);

    const dialog: AgentDialog = {
      agentId: profile.id,
      name: profile.name,
      text,
      timestamp: new Date().toISOString(),
      context: { context: event.context, alertLevel },
    };

    await this.logDialog(dialog);
    return { alertLevel, dialog };
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
      // toleransi mock
    }
  }
}

export const defaultSupervisorWatchdogLayer = new SupervisorWatchdogLayer();

