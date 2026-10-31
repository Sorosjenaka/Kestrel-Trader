// apps/server/src/universe/universeManager.ts - Universe Manager (FR-01, FR-02, US-03).
//  - Sinkron GET /fapi/v1/exchangeInfo tiap 30 menit (interval disuntik)
//  - Whitelist tradeable: contractType=PERPETUAL AND underlyingType=COIN AND quoteAsset=USDT AND status=TRADING
//  - DENY-BY-DEFAULT: selain itu = blacklist (204 non-crypto dari baseline 907 simbol)
//  - Blacklist manual operator SELALU menang (Rules.md Bagian 1 no.8)
//  - BTCDOMUSDT = data-only (sumber BTC.D, FR-06) -> alasan "BTCDOM-data-only"
//  - Audit: statistik per sync + event SYNC_OK/SYNC_FAIL (untuk EventLog di T-2.5)
//  - Fetch & repo bisa disuntik -> unit test OFFLINE (tanpa jaringan, tanpa DB).
//  - 25 Sep 2026: sync SUKSES juga mengisi registry dinamis assetClassGuard
//    (setExchangeNonCrypto) sehingga guard entry memakai daftar exchangeInfo
//    live, bukan hanya daftar statis yang bisa ketinggalan simbol TRADFI baru.
import { db } from "../core/db.js";
import { classifyExchangeNonCrypto, setExchangeNonCrypto, setExchangePerpUniverse, type ExchangeSymbolInfo } from "./assetClassGuard.js";

export interface RawFilter {
  filterType?: string;
  notional?: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
}

export interface RawSymbol {
  symbol: string;
  contractType?: string;
  status?: string;
  baseAsset?: string;
  quoteAsset?: string;
  underlyingType?: string;
  filters?: RawFilter[];
}

export interface SymbolRow {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType: string;
  underlyingType: string;
  status: string;
  isBlacklisted: boolean;
  blacklistReason: string | null;
  minNotional: number;
  tickSize: number;
  stepSize: number;
}

export interface SyncStats {
  total: number;
  tradeable: number;
  blacklisted: number;
  byReason: Record<string, number>;
  atMs: number;
  /** Jumlah simbol non-crypto yang di-registrasi ke guard entry (dinamis). */
  dynamicBlocked?: number;
  /** Jumlah perp di allowlist ONLY FUTURES (dinamis). */
  perpListed?: number;
}

export interface UniverseRepo {
  getManualBlacklist(): Promise<string[]>;
  upsertSymbol(row: SymbolRow): Promise<void>;
}

export type UniverseEventType = "SYNC_OK" | "SYNC_FAIL";

export interface UniverseOptions {
  get: <T>(path: string) => Promise<{ data: T }>;
  repo: UniverseRepo;
  intervalMs?: number;
  /** 14 Okt 2026: sumber volume 24h (produksi: ticker futures) agar kolom
   *  volume24hUsd/eligibility tabel Symbol hidup — audit universe tidak "Lolos 0". */
  fetchVolumes?: () => Promise<Map<string, number>>;
  now?: () => number;
  onEvent?: (type: UniverseEventType, payload: SyncStats | { error: string }) => void;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Klasifikasi murni: alasan pertama yang cocok menjadi penentu (deny menang di caller).
export function classifyExchangeSymbol(raw: RawSymbol, manual: Set<string>): { blacklist: boolean; reason: string | null } {
  const symbol = raw.symbol;
  if (manual.has(symbol)) return { blacklist: true, reason: "manual" };
  // Whitelist deny-by-default dipakai BERSAMA assetClassGuard supaya klasifikasi
  // universe DB dan guard entry tidak pernah berbeda.
  const reason = classifyExchangeNonCrypto(raw as ExchangeSymbolInfo);
  return reason ? { blacklist: true, reason } : { blacklist: false, reason: null };
}

export function toSymbolRow(raw: RawSymbol, manual: Set<string>): SymbolRow {
  const cls = classifyExchangeSymbol(raw, manual);
  const filters = raw.filters ?? [];
  const minNot = filters.find((f) => f.filterType === "MIN_NOTIONAL");
  const price = filters.find((f) => f.filterType === "PRICE_FILTER");
  const lot = filters.find((f) => f.filterType === "LOT_SIZE");
  const marketLot = filters.find((f) => f.filterType === "MARKET_LOT_SIZE");
  return {
    symbol: raw.symbol,
    baseAsset: raw.baseAsset ?? "",
    quoteAsset: raw.quoteAsset ?? "",
    contractType: raw.contractType ?? "?",
    underlyingType: raw.underlyingType ?? "?",
    status: raw.status ?? "?",
    isBlacklisted: cls.blacklist,
    blacklistReason: cls.reason,
    minNotional: num(minNot?.notional, 5),
    tickSize: num(price?.tickSize, 0.01),
    stepSize: num(lot?.stepSize ?? marketLot?.stepSize, 0.001),
  };
}

export class UniverseManager {
  private readonly get: <T>(path: string) => Promise<{ data: T }>;
  private readonly repo: UniverseRepo;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onEvent?: UniverseOptions["onEvent"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private manual = new Set<string>();
  private lastStats: SyncStats | null = null;
  private lastSyncAtMs: number | null = null;
  private lastError: string | null = null;
  /** Opsional (produksi): pengambil volume 24 jam agar kolom volume24hUsd/eligibility
   *  di tabel Symbol TIDAK mati (audit universe "Lolos 0"). Diinject dari index.ts. */
  private readonly fetchVolumes?: () => Promise<Map<string, number>>;

  constructor(opts: UniverseOptions) {
    this.get = opts.get;
    this.repo = opts.repo;
    this.intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.fetchVolumes = opts.fetchVolumes;
  }

  async syncOnce(): Promise<SyncStats> {
    try {
      this.manual = new Set(await this.repo.getManualBlacklist());
      const r = await this.get<{ symbols?: RawSymbol[] }>("/fapi/v1/exchangeInfo");
      const symbols = r.data.symbols ?? [];
      const byReason: Record<string, number> = {};
      let tradeable = 0;
      let blacklisted = 0;
      for (const raw of symbols) {
        const row = toSymbolRow(raw, this.manual);
        if (row.isBlacklisted) {
          blacklisted += 1;
          const key = row.blacklistReason ?? "?";
          byReason[key] = (byReason[key] ?? 0) + 1;
        } else {
          tradeable += 1;
        }
        await this.repo.upsertSymbol(row);
      }
      // Refresh registry dinamis guard entry HANYA saat fetch sukses (data valid).
      const dynamicBlocked = setExchangeNonCrypto(symbols as ExchangeSymbolInfo[]);
      // Refresh allowlist PERPETUAL (display pairs/top/scan + entry hanya futures).
      const perpListed = setExchangePerpUniverse(
        (symbols as ExchangeSymbolInfo[])
          .filter((s) => classifyExchangeNonCrypto(s) === null)
          .map((s) => String(s.symbol ?? "").toUpperCase())
      );
      // 14 Okt 2026: isi volume24hUsd + eligibility tabel Symbol dari ticker 24h.
      // Tanpa ini kolom volume selamanya 0 -> audit universe selalu "Lolos 0"
      // (bug pelaporan; jalur trading memakai sumber volume lain dan tidak terdampak).
      let volumeUpdated = 0;
      if (this.fetchVolumes) {
        try {
          const vols = await this.fetchVolumes();
          const minVol = Number(process.env.VOLUME_MIN_USD || 7_000_000);
          for (const [sym, vol] of vols) {
            if (!vol || vol <= 0) continue;
            const eligible = vol > minVol;
            // UpdateVolume-ONLY (jangan sentuh tickSize/minNotional/blacklist —
            // exchangeInfo di sync utama adalah sumber kebenarannya).
            await db.symbol.update({
              where: { symbol: sym },
              data: { volume24hUsd: vol, eligible, eligibleReason: eligible ? null : "VOLUME_BELOW_MIN" },
            }).catch(() => undefined); // simbol belum ada di tabel -> skip (sync utama akan create)
            volumeUpdated += 1;
          }
        } catch { /* fail-open: volume audit tidak boleh menggagalkan sync */ }
      }

      const stats: SyncStats = { total: symbols.length, tradeable, blacklisted, byReason, atMs: this.now() };
      this.lastStats = stats;
      this.lastSyncAtMs = stats.atMs;
      this.lastError = null;
      if (this.onEvent) this.onEvent("SYNC_OK", { ...stats, dynamicBlocked, perpListed });
      return stats;
    } catch (e) {
      this.lastError = String((e as Error)?.message ?? e);
      const fail = { error: this.lastError };
      if (this.onEvent) this.onEvent("SYNC_FAIL", fail);
      throw e;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.syncOnce().catch(() => { /* error sudah tercatat + event SYNC_FAIL */ });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats(): { lastStats: SyncStats | null; lastSyncAtMs: number | null; lastError: string | null; manualCount: number } {
    return { lastStats: this.lastStats, lastSyncAtMs: this.lastSyncAtMs, lastError: this.lastError, manualCount: this.manual.size };
  }
}

// Adapter repo Prisma (produksi). Setting "blacklistManual" = JSON array string.
export const prismaUniverseRepo: UniverseRepo = {
  async getManualBlacklist(): Promise<string[]> {
    // Sumber 1: Setting.blacklistManual (JSON array, format lama).
    const manual = new Set<string>();
    const s = await db.setting.findUnique({ where: { key: "blacklistManual" } });
    if (s) {
      try {
        const parsed: unknown = JSON.parse(s.value);
        if (Array.isArray(parsed)) for (const x of parsed) manual.add(String(x));
      } catch { /* format rusak diabaikan */ }
    }
    // Sumber 2: tabel Symbol (ditulis POST /api/settings/blacklist).
    // WAJIB disertakan — kalau tidak, sync universe berikutnya akan me-reset
    // isBlacklisted=false dan blacklist manual operator HILANG. Baris dengan
    // alasan otomatis hasil sync sebelumnya (non-crypto:/contract:/quote:/status:)
    // tidak dihitung manual supaya klasifikasi tetap diperbarui dari exchangeInfo.
    const rows = await db.symbol.findMany({
      where: { isBlacklisted: true },
      select: { symbol: true, blacklistReason: true },
    });
    // Alasan otomatis hasil sync sebelumnya (non-crypto:/contract:/quote:/status:/BTCDOM)
    // tidak dihitung manual supaya klasifikasi selalu diperbarui dari exchangeInfo.
    // Alasan "manual" (hasil sync utk simbol blacklist operator) HARUS ikut manual,
    // kalau tidak blacklist operator akan hilang pada sync kedua.
    const autoReason = /^(non-crypto:|contract:|quote:|status:|BTCDOM-data-only$)/;
    for (const r of rows) {
      const reason = r.blacklistReason ?? "";
      if (!autoReason.test(reason)) manual.add(r.symbol);
    }
    return Array.from(manual);
  },
  async upsertSymbol(row: SymbolRow): Promise<void> {
    await db.symbol.upsert({
      where: { symbol: row.symbol },
      update: {
        baseAsset: row.baseAsset,
        quoteAsset: row.quoteAsset,
        contractType: row.contractType,
        underlyingType: row.underlyingType,
        status: row.status,
        isBlacklisted: row.isBlacklisted,
        blacklistReason: row.blacklistReason,
        minNotional: row.minNotional,
        tickSize: row.tickSize,
        stepSize: row.stepSize,
      },
      create: row,
    });
  },
};