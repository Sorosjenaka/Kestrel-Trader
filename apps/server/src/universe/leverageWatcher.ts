// apps/server/src/universe/leverageWatcher.ts - Leverage Watcher (FR-16, FR-33, US-14).
//  - Snapshot max leverage per pair: seed manual + GET /fapi/v1/leverageBracket signed
//  - Diff siklus 6 jam (atau on-demand): jika maxLev berubah, tulis ke LeverageHistory
//  - Aturan FR-16: leverage efektif = min(25, maxLev); tolak order jika snapshot > 7 hari (stale)
//  - GET /api/universe/leverage (FR-33): pairs + history (50 entri terakhir)
//  - Repo & fetcher disuntik -> 100% test offline.
import crypto from "node:crypto";
import { db } from "../core/db.js";
import { env } from "../core/env.js";

export const STALE_LEVERAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari (FR-16)
export const DEFAULT_DIFF_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 jam (US-14)
export const TARGET_LEVERAGE_DEFAULT = 25; // Rules §4 & Schema 1.1

export const REASON_NO_SNAPSHOT = "NO_LEVERAGE_SNAPSHOT";
export const REASON_STALE_SNAPSHOT = "STALE_LEVERAGE_SNAPSHOT";

export interface RawBracket {
  bracket: number;
  initialLeverage: number;
  notionalCap?: number;
  notionalFloor?: number;
  maintMarginRatio?: number;
  cum?: number;
}

export interface RawLeverageSymbol {
  symbol: string;
  brackets?: RawBracket[];
}

export interface LeverageHistoryItem {
  id?: number;
  symbol: string;
  maxLeverage: number;
  previousMaxLeverage: number | null;
  observedAt: Date;
  source: string;
}

export interface LeveragePairView {
  symbol: string;
  maxLeverage: number | null;
  observedAt: string | null;
  source: string;
  isStale: boolean;
  effectiveLeverage: number | null;
}

export interface LeverageCheckResult {
  valid: boolean;
  effectiveLeverage: number | null;
  reason: string | null;
}

export interface LeverageRepo {
  getSymbols(symbol?: string): Promise<Array<{ symbol: string; maxLeverage: number | null; maxLeverageUpdatedAt: Date | null }>>;
  updateSymbolLeverage(symbol: string, maxLeverage: number, updatedAt: Date): Promise<void>;
  touchSymbolLeverage(symbol: string, updatedAt: Date): Promise<void>;
  recordHistory(item: Omit<LeverageHistoryItem, "id">): Promise<void>;
  getHistory(symbol?: string, limit?: number): Promise<LeverageHistoryItem[]>;
}

export function signHmacSha256(queryString: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

export function buildSignedQuery(params: Record<string, string | number>, secret: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  const qs = parts.join("&");
  const sig = signHmacSha256(qs, secret);
  return `${qs}&signature=${sig}`;
}

export function parseMaxLeverageFromBrackets(brackets?: RawBracket[]): number | null {
  if (!brackets || brackets.length === 0) return null;
  let max = -Infinity;
  for (const b of brackets) {
    if (typeof b.initialLeverage === "number" && b.initialLeverage > max) {
      max = b.initialLeverage;
    }
  }
  return Number.isFinite(max) && max > 0 ? max : null;
}

export interface LeverageWatcherOptions {
  repo?: LeverageRepo;
  now?: () => number;
  targetLeverage?: number;
  maxAgeMs?: number;
  onDiffDetected?: (diff: { symbol: string; old: number | null; new: number; observedAt: Date; source: string }) => void;
}

export class LeverageWatcher {
  private readonly repo: LeverageRepo;
  private readonly now: () => number;
  private readonly targetLeverage: number;
  private readonly maxAgeMs: number;
  private readonly onDiffDetected?: LeverageWatcherOptions["onDiffDetected"];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LeverageWatcherOptions = {}) {
    this.repo = opts.repo ?? prismaLeverageRepo;
    this.now = opts.now ?? Date.now;
    this.targetLeverage = opts.targetLeverage ?? env.LEVERAGE_TARGET ?? TARGET_LEVERAGE_DEFAULT;
    this.maxAgeMs = opts.maxAgeMs ?? STALE_LEVERAGE_MAX_AGE_MS;
    this.onDiffDetected = opts.onDiffDetected;
  }

  async applySnapshot(
    entries: Array<{ symbol: string; maxLeverage: number }>,
    source: "signed-endpoint" | "seed-manual"
  ): Promise<{ updated: number; unchanged: number; diffs: Array<{ symbol: string; old: number | null; new: number }> }> {
    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    const existing = await this.repo.getSymbols();
    const existingMap = new Map(existing.map((s) => [s.symbol, s]));

    let updated = 0;
    let unchanged = 0;
    const diffs: Array<{ symbol: string; old: number | null; new: number }> = [];

    for (const e of entries) {
      const cur = existingMap.get(e.symbol);
      const curLev = cur?.maxLeverage ?? null;
      if (curLev !== e.maxLeverage) {
        await this.repo.updateSymbolLeverage(e.symbol, e.maxLeverage, nowDate);
        await this.repo.recordHistory({
          symbol: e.symbol,
          maxLeverage: e.maxLeverage,
          previousMaxLeverage: curLev,
          observedAt: nowDate,
          source,
        });
        diffs.push({ symbol: e.symbol, old: curLev, new: e.maxLeverage });
        updated += 1;
        if (this.onDiffDetected) {
          this.onDiffDetected({ symbol: e.symbol, old: curLev, new: e.maxLeverage, observedAt: nowDate, source });
        }
      } else {
        await this.repo.touchSymbolLeverage(e.symbol, nowDate);
        unchanged += 1;
      }
    }
    return { updated, unchanged, diffs };
  }

  async seedManual(map: Record<string, number>): Promise<{ updated: number; unchanged: number }> {
    const entries = Object.entries(map).map(([symbol, maxLeverage]) => ({ symbol, maxLeverage }));
    return this.applySnapshot(entries, "seed-manual");
  }

  async syncSigned(fetcher: (pathWithQuery: string) => Promise<{ data: RawLeverageSymbol[] }>, apiKey = env.BINANCE_API_KEY, apiSecret = env.BINANCE_API_SECRET): Promise<{ updated: number; unchanged: number }> {
    if (!apiKey || !apiSecret) {
      throw new Error("syncSigned: API key atau secret kosong");
    }
    const timestamp = this.now();
    const query = buildSignedQuery({ timestamp, recvWindow: 5000 }, apiSecret);
    const path = `/fapi/v1/leverageBracket?${query}`;
    const res = await fetcher(path);
    const items = res.data ?? [];
    const entries: Array<{ symbol: string; maxLeverage: number }> = [];
    for (const raw of items) {
      const max = parseMaxLeverageFromBrackets(raw.brackets);
      if (max !== null) entries.push({ symbol: raw.symbol, maxLeverage: max });
    }
    return this.applySnapshot(entries, "signed-endpoint");
  }

  async checkLeverage(symbol: string): Promise<LeverageCheckResult> {
    const rows = await this.repo.getSymbols(symbol);
    const row = rows[0];
    if (!row || row.maxLeverage === null || row.maxLeverageUpdatedAt === null) {
      return { valid: false, effectiveLeverage: null, reason: REASON_NO_SNAPSHOT };
    }
    const age = this.now() - row.maxLeverageUpdatedAt.getTime();
    if (age > this.maxAgeMs) {
      return { valid: false, effectiveLeverage: null, reason: REASON_STALE_SNAPSHOT };
    }
    const effective = Math.min(this.targetLeverage, row.maxLeverage);
    return { valid: true, effectiveLeverage: effective, reason: null };
  }

  async getView(symbol?: string): Promise<{ pairs: LeveragePairView[]; history: LeverageHistoryItem[] }> {
    const symbols = await this.repo.getSymbols(symbol);
    const history = await this.repo.getHistory(symbol, 50);
    const nowMs = this.now();

    const pairs: LeveragePairView[] = symbols.map((s) => {
      const isStale = s.maxLeverageUpdatedAt === null || (nowMs - s.maxLeverageUpdatedAt.getTime() > this.maxAgeMs);
      const effective = s.maxLeverage !== null && !isStale ? Math.min(this.targetLeverage, s.maxLeverage) : null;
      return {
        symbol: s.symbol,
        maxLeverage: s.maxLeverage,
        observedAt: s.maxLeverageUpdatedAt?.toISOString() ?? null,
        source: "snapshot",
        isStale,
        effectiveLeverage: effective,
      };
    });

    return { pairs, history };
  }

  start(intervalMs = DEFAULT_DIFF_INTERVAL_MS, worker?: () => Promise<unknown>): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (worker) void worker().catch(() => {});
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const prismaLeverageRepo: LeverageRepo = {
  async getSymbols(symbol?: string) {
    return db.symbol.findMany({
      where: symbol ? { symbol } : undefined,
      select: { symbol: true, maxLeverage: true, maxLeverageUpdatedAt: true },
      orderBy: { symbol: "asc" },
    });
  },
  async updateSymbolLeverage(symbol: string, maxLeverage: number, updatedAt: Date) {
    await db.symbol.upsert({
      where: { symbol },
      update: { maxLeverage, maxLeverageUpdatedAt: updatedAt },
      create: {
        symbol,
        baseAsset: symbol.replace("USDT", ""),
        quoteAsset: "USDT",
        maxLeverage,
        maxLeverageUpdatedAt: updatedAt,
      },
    });
  },
  async touchSymbolLeverage(symbol: string, updatedAt: Date) {
    await db.symbol.updateMany({
      where: { symbol },
      data: { maxLeverageUpdatedAt: updatedAt },
    });
  },
  async recordHistory(item: Omit<LeverageHistoryItem, "id">) {
    await db.leverageHistory.create({
      data: {
        symbol: item.symbol,
        maxLeverage: item.maxLeverage,
        previousMaxLeverage: item.previousMaxLeverage,
        observedAt: item.observedAt,
        source: item.source,
      },
    });
  },
  async getHistory(symbol?: string, limit = 50) {
    const rows = await db.leverageHistory.findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { observedAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      maxLeverage: r.maxLeverage,
      previousMaxLeverage: r.previousMaxLeverage,
      observedAt: r.observedAt,
      source: r.source,
    }));
  },
};

export const leverageWatcher = new LeverageWatcher();