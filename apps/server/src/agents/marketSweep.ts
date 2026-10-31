// apps/server/src/agents/marketSweep.ts — LLM MARKET SWEEP (15 Okt 2026)
// Riset multi-paralel SEMUA simbol eligible (~144) per siklus: fan-out per
// simbol lewat XkiroAdapter (limiter global LLM_MAX_CONCURRENCY + retry 429
// + budget tracker yang sudah ada), cache key `symbol:bar1h` (simbol dengan
// bar 1h belum berganti DIPAKAI hasil lamanya — sweep lanjutan jauh lebih
// murah), stage-2 REASON hanya untuk verdict ACTIONABLE (konservatif menang).
//
// KEAMANAN & RUANG LINGKUP:
//  - Ini LAPISAN RISET read-only: hanya membaca scannerPool.getScanView()
//    + EventLog, menulis EventLog + markdown. TIDAK mengimpor bot/entry
//    pipeline; tidak ada jalur order baru; ARM live tidak tersentuh.
//  - Parse fail-closed: JSON rusak/enum salah = simbol dihitung INVALID,
//    tidak ada fabrikasi. Kegagalan LLM = log only, timer tetap jalan.
//  - Pola mengikuti marketAnalyst.ts (fallback berlabel, EventLog, markdown).
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import { db } from "../core/db.js";
import { scannerPool, type CandidateItem } from "../scanner/scannerPool.js";
import { defaultLlmAdapter, cleanJsonText } from "./llmAdapter.js";
import type { LlmResponse } from "./llmAdapter.js";
import { promises as fsp } from "node:fs";
import * as path from "node:path";

export type SweepVerdict = "NO_SETUP" | "WATCH" | "ACTIONABLE";

export interface SweepSymbolVerdict {
  symbol: string;
  regime: string;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "MIXED" | "UNKNOWN";
  momentum: "UP" | "DOWN" | "FLAT" | "UNKNOWN";
  riskNote: string;
  verdict: SweepVerdict;
  confidence: number;
  reason: string;
}

export interface SweepRunReport {
  sweepId: string;
  startedAt: string;
  finishedAt: string | null;
  symbolsTotal: number;
  symbolsLlm: number;
  symbolsSkippedCache: number;
  symbolsSkippedInvalid: number;
  symbolsError: number;
  actionable: SweepSymbolVerdict[];
  watch: SweepSymbolVerdict[];
  fastCalls: number;
  reasonCalls: number;
  estTokens: number;
}

type SweepDb = Pick<typeof db, "eventLog">;

export interface MarketSweepOptions {
  adapter?: { callFast(u: string, s?: string, o?: object): Promise<LlmResponse>; callReason(u: string, s?: string, o?: object): Promise<LlmResponse> };
  db?: SweepDb;
  getCandidates?: () => CandidateItem[];
  now?: () => number;
  intervalMin?: number;
  maxSymbols?: number;
  stage2?: boolean;
}

const SWEEP_SYSTEM = [
  "Anda analis riset pasar futures kripto. Berdasarkan data deterministik yang diberikan,",
  "nilai simbol ini. Balas HANYA satu objek JSON (tanpa teks lain) dengan schema:",
  '{"symbol":string,"regime":string,"bias":"BULLISH"|"BEARISH"|"NEUTRAL"|"MIXED"|"UNKNOWN",',
  '"momentum":"UP"|"DOWN"|"FLAT"|"UNKNOWN","riskNote":string(maks160),',
  '"verdict":"NO_SETUP"|"WATCH"|"ACTIONABLE","confidence":number(0-1),"reason":string(maks240)}',
  "Definisi verdict: NO_SETUP = tidak ada setup layak; WATCH = menarik tapi belum layak;",
  "ACTIONABLE = setup jelas yang layak diperhatikan untuk eksekusi. Alasan dalam Bahasa Indonesia.",
  "INI RISET, BUKAN SINYAL ORDER — jangan menyarankan angka entry/SL/TP.",
].join(" ");

/** Prompt per simbol — pure function (angka deterministik saja, tanpa karangan). */
export function buildSweepPrompt(c: CandidateItem): string {
  const plan = c.plan
    ? `entry ${c.plan.side} @${c.plan.entryPrice ?? "-"} SL ${c.plan.slPrice ?? "-"} TP1 ${c.plan.tp1Price ?? "-"}`
    : "tidak ada plan";
  return [
    `Simbol: ${c.symbol}`,
    `Skor komposit: ${c.score.toFixed(2)} | Regime: ${c.regime}`,
    `Trigger ${c.triggerScore.toFixed(2)} | Struktur ${c.zoneScore.toFixed(2)} | Tren ${c.trendScore.toFixed(2)}`,
    `Chop ${c.chop ?? "-"} / ADX ${c.chopAdx ?? "-"} | Bias ${c.biasTrend ?? "-"} (ADX ${c.biasAdx ?? "-"})`,
    `Strategi: ${c.strategyId ?? "-"} ${c.entryType ?? ""} | ${plan}`,
    c.eligReasons?.length ? `Catatan eligibility: ${c.eligReasons.join(", ")}` : "",
    c.tfSummary ?? "",
    "Nilai simbol ini sesuai schema JSON yang diminta.",
  ].filter(Boolean).join("\n");
}

/** Parse fail-closed: tidak valid = null (tidak ada fabrikasi nilai). */
export function parseSweepVerdict(symbol: string, raw: string): SweepSymbolVerdict | null {
  try {
    const obj = JSON.parse(cleanJsonText(raw)) as Record<string, unknown>;
    const verdict = obj.verdict;
    if (verdict !== "NO_SETUP" && verdict !== "WATCH" && verdict !== "ACTIONABLE") return null;
    const bias = typeof obj.bias === "string" ? obj.bias.toUpperCase() : "UNKNOWN";
    const momentum = typeof obj.momentum === "string" ? obj.momentum.toUpperCase() : "UNKNOWN";
    const conf = Number(obj.confidence);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;
    const strOrNull = (v: unknown, max: number): string =>
      typeof v === "string" ? v.slice(0, max) : "";
    const symbolEcho = strOrNull(obj.symbol, 32);
    if (symbolEcho && symbolEcho.toUpperCase() !== symbol.toUpperCase()) return null;
    return {
      symbol,
      regime: strOrNull(obj.regime, 32) || "UNKNOWN",
      bias: (["BULLISH", "BEARISH", "NEUTRAL", "MIXED", "UNKNOWN"].includes(bias) ? bias : "UNKNOWN") as SweepSymbolVerdict["bias"],
      momentum: (["UP", "DOWN", "FLAT", "UNKNOWN"].includes(momentum) ? momentum : "UNKNOWN") as SweepSymbolVerdict["momentum"],
      riskNote: strOrNull(obj.riskNote, 160),
      verdict,
      confidence: conf,
      reason: strOrNull(obj.reason, 240),
    };
  } catch {
    return null;
  }
}

function hourFloor(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

const CACHE_MAX = 512;

export class MarketSweep {
  private readonly adapter: NonNullable<MarketSweepOptions["adapter"]>;
  private readonly db: SweepDb;
  private readonly getCandidates: () => CandidateItem[];
  private readonly now: () => number;
  private readonly intervalMin: number;
  private readonly maxSymbols: number;
  private readonly stage2: boolean;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private cache = new Map<string, { barOpen1h: number; verdict: SweepSymbolVerdict }>();
  private latest: SweepRunReport | null = null;

  constructor(options?: MarketSweepOptions) {
    this.adapter = options?.adapter ?? defaultLlmAdapter;
    this.db = options?.db ?? db;
    this.getCandidates = options?.getCandidates ?? (() => scannerPool.getScanView().candidates);
    this.now = options?.now ?? Date.now;
    this.intervalMin = options?.intervalMin ?? env.LLM_SWEEP_INTERVAL_MIN;
    this.maxSymbols = options?.maxSymbols ?? env.LLM_SWEEP_MAX_SYMBOLS;
    this.stage2 = options?.stage2 ?? env.LLM_SWEEP_STAGE2;
  }

  /** Idempotent; jitter kecil biar tidak tabrak siklus scan. */
  start(): void {
    if (this.timer) return;
    const jitterMs = Math.floor(Math.random() * Math.min(45, this.intervalMin * 60) * 1000);
    setTimeout(() => {
      this.timer = setInterval(() => {
        void this.runSweep().catch((err) => logger.warn({ err: (err as Error).message }, "LLM_SWEEP_FAILED"));
      }, this.intervalMin * 60_000);
      void this.runSweep().catch((err) => logger.warn({ err: (err as Error).message }, "LLM_SWEEP_FAILED"));
    }, jitterMs);
    logger.info({ intervalMin: this.intervalMin, maxSymbols: this.maxSymbols, stage2: this.stage2 }, "LLM_SWEEP_STARTED");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isSweepRunning(): boolean {
    return this.inFlight;
  }

  getLatestReport(): SweepRunReport | null {
    return this.latest;
  }

  /** Fan-out semua simbol (cache-aware). Re-entrancy guarded. */
  async runSweep(): Promise<SweepRunReport | null> {
    if (this.inFlight) return null; // sweep lebih lambat dari interval = lewati, jangan antre
    this.inFlight = true;
    const startedAt = this.now();
    const report: SweepRunReport = {
      sweepId: `sweep-${startedAt}`,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
      symbolsTotal: 0, symbolsLlm: 0, symbolsSkippedCache: 0, symbolsSkippedInvalid: 0, symbolsError: 0,
      actionable: [], watch: [], fastCalls: 0, reasonCalls: 0, estTokens: 0,
    };
    try {
      const all = this.getCandidates();
      const symbols = (this.maxSymbols > 0 ? all.slice(0, this.maxSymbols) : all)
        .filter((c) => c.symbol);
      report.symbolsTotal = symbols.length;
      if (symbols.length === 0) {
        report.finishedAt = new Date(this.now()).toISOString();
        this.latest = report;
        return report;
      }

      // 1) Cache: bar 1h belum berganti = pakai verdict lama.
      const fresh: CandidateItem[] = [];
      for (const c of symbols) {
        const bar = c.mtfAnalyzedAt ? hourFloor(c.mtfAnalyzedAt) : null;
        const hit = bar != null ? this.cache.get(c.symbol) : undefined;
        if (bar != null && hit && hit.barOpen1h === bar) {
          report.symbolsSkippedCache += 1;
          this.classify(hit.verdict, report);
        } else {
          fresh.push(c);
        }
      }

      // 2) Fan-out FAST — limiter adapter (LLM_MAX_CONCURRENCY) yang membatasi.
      const analyzed = await Promise.allSettled(fresh.map(async (c) => {
        const res = await this.adapter.callFast(buildSweepPrompt(c), SWEEP_SYSTEM, { maxTokens: 400 });
        report.fastCalls += 1;
        report.estTokens += res.usage.totalTokens;
        return { candidate: c, res };
      }));
      for (const r of analyzed) {
        if (r.status === "rejected") { report.symbolsError += 1; continue; }
        const { candidate, res } = r.value;
        const verdict = parseSweepVerdict(candidate.symbol, res.content);
        if (!verdict) { report.symbolsSkippedInvalid += 1; continue; }
        report.symbolsLlm += 1;
        const bar = candidate.mtfAnalyzedAt ? hourFloor(candidate.mtfAnalyzedAt) : null;
        if (bar != null) {
          this.cache.set(candidate.symbol, { barOpen1h: bar, verdict });
          if (this.cache.size > CACHE_MAX) {
            const oldest = this.cache.keys().next().value;
            if (oldest) this.cache.delete(oldest);
          }
        }
        // 3) Stage-2 REASON untuk ACTIONABLE (maks 20/sweep) — konservatif menang.
        if (verdict.verdict === "ACTIONABLE" && this.stage2 && report.reasonCalls < 20) {
          try {
            const res2 = await this.adapter.callReason(
              `${buildSweepPrompt(candidate)}\n\nPenilaian tahap-1: verdict ACTIONABLE (confidence ${verdict.confidence.toFixed(2)}). Verifikasi ulang: setuju atau turunkan?`,
              SWEEP_SYSTEM, { maxTokens: 900 });
            report.reasonCalls += 1;
            report.estTokens += res2.usage.totalTokens;
            const v2 = parseSweepVerdict(candidate.symbol, res2.content);
            if (v2) {
              // Konservatif menang: stage-2 tidak ACTIONABLE → WATCH.
              verdict.verdict = v2.verdict === "ACTIONABLE" ? "ACTIONABLE" : "WATCH";
              verdict.confidence = Math.min(verdict.confidence, v2.confidence);
              verdict.reason = v2.reason || verdict.reason;
            } else {
              verdict.verdict = "WATCH"; // stage-2 tidak terparse = jangan biarkan ACTIONABLE
            }
          } catch {
            verdict.verdict = "WATCH"; // gagal call stage-2 = turunkan (fail-closed)
          }
        }
        this.classify(verdict, report);
      }

      report.finishedAt = new Date(this.now()).toISOString();
      this.latest = report;
      await this.persist(report);
      return report;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "LLM_SWEEP_FAILED");
      report.finishedAt = new Date(this.now()).toISOString();
      this.latest = report;
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  private classify(v: SweepSymbolVerdict, report: SweepRunReport): void {
    if (v.verdict === "ACTIONABLE") report.actionable.push(v);
    else if (v.verdict === "WATCH") report.watch.push(v);
  }

  /** EventLog + markdown (pola marketAnalyst). Gagal = log only. */
  private async persist(report: SweepRunReport): Promise<void> {
    try {
      await this.db.eventLog.create({
        data: {
          type: "LLM_SWEEP",
          severity: "info",
          payload: JSON.stringify({
            sweepId: report.sweepId,
            total: report.symbolsTotal, llm: report.symbolsLlm,
            cache: report.symbolsSkippedCache, invalid: report.symbolsSkippedInvalid,
            error: report.symbolsError, fastCalls: report.fastCalls, reasonCalls: report.reasonCalls,
            estTokens: report.estTokens,
            actionable: report.actionable.slice(0, 25).map((v) => ({ symbol: v.symbol, confidence: v.confidence, reason: v.reason })),
            watch: report.watch.slice(0, 25).map((v) => ({ symbol: v.symbol, confidence: v.confidence, reason: v.reason })),
          }),
        },
      });
      for (const v of [...report.actionable, ...report.watch]) {
        await this.db.eventLog.create({
          data: {
            type: "LLM_SWEEP_VERDICT",
            severity: v.verdict === "ACTIONABLE" ? "warn" : "info",
            payload: JSON.stringify({ sweepId: report.sweepId, ...v }),
          },
        }).catch(() => undefined);
      }
      const dayKey = new Date(report.startedAt).toISOString().slice(0, 10);
      const target = path.join(process.cwd(), "data", "research", `sweep-${dayKey}.md`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const rows = [...report.actionable, ...report.watch].sort((a, b) => b.confidence - a.confidence)
        .map((v) => `| ${v.symbol} | ${v.verdict} | ${v.confidence.toFixed(2)} | ${v.bias} | ${v.reason} |`)
        .join("\n");
      await fsp.appendFile(target, [
        `\n---\n## SWEEP ${report.sweepId} ${report.startedAt}`,
        `Total ${report.symbolsTotal} | LLM ${report.symbolsLlm} | cache ${report.symbolsSkippedCache} | invalid ${report.symbolsSkippedInvalid} | error ${report.symbolsError} | tokens ${report.estTokens}`,
        rows ? `| Simbol | Verdict | Conf | Bias | Alasan |\n|---|---|---|---|---|\n${rows}` : "(tidak ada WATCH/ACTIONABLE)",
      ].join("\n") + "\n", "utf8");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "LLM_SWEEP_PERSIST_FAILED");
    }
  }
}

export const marketSweep = new MarketSweep();
