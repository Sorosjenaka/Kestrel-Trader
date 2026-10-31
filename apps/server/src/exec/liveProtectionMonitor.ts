// apps/server/src/exec/liveProtectionMonitor.ts — Tahap 2+3 rencana
// docs/plan-fix-watcher-2026-10-30.md (insiden #3239/#3240).
//
// Monitor proteksi posisi LIVE, loop 60 dtk, READ-ONLY (hanya GET — tidak ada
// order yang dikirim, tidak menyentuh logika entry/sizing/risk/eksekusi):
//   - A2: tiap posisi LIVE OPEN WAJIB punya SL aktif di exchange. Tanpa SL ->
//     EventLog severity "critical" (otomatis masuk alert feed /api/alerts).
//   - A3: selisih DB vs exchange (dua arah) yang bertahan > 5 menit -> CRITICAL.
//
// Disiplin rate-limit (IP Binance shared):
//   - Loop ini TIDAK ikut backoff watcher: alarm keamanan harus tetap jalan
//     saat watcher menahan diri karena 429 (permintaan operator, A3).
//   - Tapi satu siklus hanya 3 GET (positionRisk + openAlgo + openOrders) per
//     menit; kalau exchange sendiri membalas 429/-1003, monitor mundur
//     eksponensial 30 dtk..5 menit, dan 418 = STOP total + alarm (aturan
//     "STOP saat 418"). Diam TIDAK pernah dianggap sehat: gagal cek berlarut
//     memicu alarm ketidakpastian (A3).
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";
import { liveExchange, LIVE_MODE } from "./liveRuntime.js";
import { cachedOpenAlgoOrders, cachedOpenOrders, cachedPositionRiskAll } from "./signedSnapshotCache.js";

const CHECK_INTERVAL_MS = 60_000;
const NO_SL_GRACE_MS = 120_000; // posisi < 2 menit: SL masih dalam masa pasang
const ALARM_DEDUP_MS = 3_600_000; // alarm per posisi maks 1x/jam (anti-spam)
const DIVERGENCE_GRACE_MS = 5 * 60_000; // A3: selisih harus bertahan > 5 menit
const CHECK_UNAVAILABLE_MS = 10 * 60_000; // A3: cek berlarut gagal -> alarm ketidakpastian

export interface ProtectionOrderRow {
  symbol: string;
  clientAlgoId: string;
  orderType: string;
  side: string;
  closePosition: boolean;
  reduceOnly: boolean;
}

/** Normalisasi baris algo (orderType/clientAlgoId) dan openOrders biasa
 *  (type/clientOrderId) ke satu bentuk. Defensif: field boleh absen. */
export function toProtectionOrderRow(raw: unknown): ProtectionOrderRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === "string" ? r.symbol : "";
  if (!symbol) return null;
  return {
    symbol,
    clientAlgoId: String(r.clientAlgoId ?? r.clientOrderId ?? ""),
    orderType: String(r.orderType ?? r.type ?? "").toUpperCase(),
    side: String(r.side ?? "").toUpperCase(),
    closePosition: r.closePosition === true || r.closePosition === "true",
    reduceOnly: r.reduceOnly === true || r.reduceOnly === "true",
  };
}

/** SL pelindung = STOP-type (STOP / STOP_MARKET / TRAILING_STOP_MARKET) dengan
 *  sisi yang MENUTUP posisi, atau order bot ber-prefix SLA_ (preEntryBracket) /
 *  SL_ (ensureCloseAllStop). TAKE_PROFIT* BUKAN SL. Order manual ikut dihitung
 *  — yang diuji adalah "SL aktif di exchange", bukan siapa pemiliknya. */
export function isStopProtection(row: ProtectionOrderRow, posSide: string): boolean {
  if (row.side && posSide) {
    const closingSide = posSide === "LONG" ? "SELL" : "BUY";
    if (row.side !== closingSide) return false;
  }
  if (row.clientAlgoId.startsWith("SLA_") || row.clientAlgoId.startsWith("SL_")) return true;
  return row.orderType.includes("STOP");
}

export function hasStopProtection(input: {
  symbol: string;
  side: string;
  rows: Array<ProtectionOrderRow | null>;
}): boolean {
  return input.rows.some((row) => !!row && row.symbol === input.symbol && isStopProtection(row, input.side));
}

export interface DivergenceRow {
  key: string;
  direction: "DB_OPEN_EXCHANGE_FLAT" | "EXCHANGE_OPEN_DB_MISSING";
  symbol: string;
  positionId?: number;
}

/** A3 — selisih DB vs exchange (dua arah), murni tanpa state/waktu:
 *  - DB_OPEN_EXCHANGE_FLAT: ledger OPEN tapi exchange sudah flat
 *    (persis insiden #3239/#3240 — watcher gagal atribusi fill).
 *  - EXCHANGE_OPEN_DB_MISSING: exposure exchange tanpa baris ledger LIVE
 *    (orphan / posisi manual di akun yang sama).
 *  Exchange flat = tidak ada baris, atau semua positionAmt = 0. */
export function findDivergences(input: {
  dbPositions: Array<{ id: number; symbol: string }>;
  exchangePositions: Array<{ symbol: string; positionAmt: unknown }>;
}): DivergenceRow[] {
  const openAtExchange = new Map<string, boolean>();
  for (const row of input.exchangePositions) {
    const amt = Number(row.positionAmt);
    const open = Number.isFinite(amt) && amt !== 0;
    openAtExchange.set(row.symbol, (openAtExchange.get(row.symbol) ?? false) || open);
  }
  const out: DivergenceRow[] = [];
  const dbSymbols = new Set<string>();
  for (const pos of input.dbPositions) {
    dbSymbols.add(pos.symbol);
    if (!openAtExchange.get(pos.symbol)) {
      out.push({ key: `DB:${pos.id}`, direction: "DB_OPEN_EXCHANGE_FLAT", symbol: pos.symbol, positionId: pos.id });
    }
  }
  for (const [symbol, open] of openAtExchange) {
    if (open && !dbSymbols.has(symbol)) {
      out.push({ key: `EX:${symbol}`, direction: "EXCHANGE_OPEN_DB_MISSING", symbol });
    }
  }
  return out;
}

interface MonitorPositionRow {
  id: number;
  symbol: string;
  side: string;
  openedAt: Date | number;
  status: string;
  source: string | null;
}

export interface MonitorOptions {
  now?: () => number;
  intervalMs?: number;
  noSlGraceMs?: number;
  alarmDedupMs?: number;
  divergenceGraceMs?: number;
  checkUnavailableMs?: number;
  snapshotTtlMs?: number;
}

export class LiveProtectionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly noSlGraceMs: number;
  private readonly alarmDedupMs: number;
  private readonly divergenceGraceMs: number;
  private readonly checkUnavailableMs: number;
  private readonly snapshotTtlMs: number;
  private readonly noSlAlarmAt = new Map<number, number>();
  private rateLimitBackoffMs = 0;
  private rateLimitUntil = 0;
  // A3 state: sejak kapan tiap kunci divergen, dan kapan terakhir di-alarm.
  private readonly divergenceSince = new Map<string, number>();
  private readonly divergenceAlarmAt = new Map<string, number>();
  private lastSuccessfulCheckAt: number;
  private unavailableAlarmAt = 0;

  constructor(opts?: MonitorOptions) {
    this.now = opts?.now ?? Date.now;
    this.intervalMs = opts?.intervalMs ?? CHECK_INTERVAL_MS;
    this.noSlGraceMs = opts?.noSlGraceMs ?? NO_SL_GRACE_MS;
    this.alarmDedupMs = opts?.alarmDedupMs ?? ALARM_DEDUP_MS;
    this.divergenceGraceMs = opts?.divergenceGraceMs ?? DIVERGENCE_GRACE_MS;
    this.checkUnavailableMs = opts?.checkUnavailableMs ?? CHECK_UNAVAILABLE_MS;
    this.snapshotTtlMs = opts?.snapshotTtlMs ?? 5_000;
    this.lastSuccessfulCheckAt = this.now();
  }

  start(): void {
    if (!LIVE_MODE || this.timer) return;
    this.timer = setInterval(() => { void this.runCheck().catch((err) => this.onCheckError(err)); }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, "LiveProtectionMonitor aktif (mode LIVE)");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Satu siklus pemeriksaan (dipanggil timer atau langsung oleh test). */
  async runCheck(): Promise<void> {
    // Evaluasi ketersediaan SELALU jalan (bahkan saat backoff/skip) — diam
    // tidak boleh pernah diartikan sehat (A3).
    this.evaluateAvailability();
    if (this.running || !liveExchange) return;
    if (this.now() < this.rateLimitUntil) return;
    this.running = true;
    try {
      // 4 GET signed per siklus, dibatch: satu siklus melayani A2 + A3.
      // A4: snapshot dibagi dengan mirror/watcher via signedSnapshotCache
      // (TTL snapshotTtlMs) — duplikasi antar konsumen berbagi satu panggilan.
      const [dbPositions, algos, openOrders, exchangePositions] = await Promise.all([
        db.position.findMany({ where: { status: "OPEN", source: { startsWith: "LIVE_" } } }) as Promise<MonitorPositionRow[]>,
        cachedOpenAlgoOrders(liveExchange, { ttlMs: this.snapshotTtlMs }),
        cachedOpenOrders(liveExchange, { ttlMs: this.snapshotTtlMs }),
        cachedPositionRiskAll(liveExchange, { ttlMs: this.snapshotTtlMs }),
      ]);
      this.rateLimitBackoffMs = 0; // sukses -> jeda rate-limit diulang nol
      this.lastSuccessfulCheckAt = this.now();
      const rows = [...algos, ...openOrders].map(toProtectionOrderRow);
      for (const pos of dbPositions) {
        await this.checkStopProtection(pos, rows);
      }
      this.checkDivergences(dbPositions, exchangePositions);
    } finally {
      this.running = false;
    }
  }

  /** A2: posisi LIVE OPEN tanpa SL aktif di exchange -> CRITICAL (dedup 1x/jam). */
  private async checkStopProtection(pos: MonitorPositionRow, rows: Array<ProtectionOrderRow | null>): Promise<void> {
    const openedMs = typeof pos.openedAt === "number" ? pos.openedAt : pos.openedAt.getTime();
    if (this.now() - openedMs < this.noSlGraceMs) return; // masa pasang SL
    if (hasStopProtection({ symbol: pos.symbol, side: pos.side, rows })) return;
    const last = this.noSlAlarmAt.get(pos.id) ?? 0;
    if (this.now() - last < this.alarmDedupMs) return;
    this.noSlAlarmAt.set(pos.id, this.now());
    const onSymbol = rows.filter((r) => !!r && r.symbol === pos.symbol);
    const payload = {
      positionId: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      openedAt: new Date(openedMs).toISOString(),
      checkedAt: new Date(this.now()).toISOString(),
      ordersOnSymbol: onSymbol.map((r) => ({ clientAlgoId: r!.clientAlgoId, orderType: r!.orderType, side: r!.side })),
      message: `Posisi LIVE ${pos.symbol} (${pos.side}) OPEN tanpa SL aktif di exchange`,
    };
    logger.error({ positionId: pos.id, symbol: pos.symbol, side: pos.side }, "LIVE_NO_SL_ALARM");
    await db.eventLog.create({
      data: { type: "LIVE_NO_SL_ALARM", severity: "critical", payload: JSON.stringify(payload) },
    }).catch((err: unknown) => logger.error({ err: (err as Error)?.message }, "LIVE_NO_SL_ALARM_WRITE_FAIL"));
  }

  /** A3: selisih DB vs exchange yang bertahan > divergenceGraceMs -> CRITICAL.
   *  Dua arah; key yang sudah tidak divergen di-reset supaya insiden baru
   *  berikutnya bisa ber-ALARM lagi (bukan teredam oleh alarm lama). */
  private checkDivergences(
    dbPositions: Array<{ id: number; symbol: string }>,
    exchangePositions: Array<{ symbol: string; positionAmt: unknown }>,
  ): void {
    const current = findDivergences({ dbPositions, exchangePositions });
    const currentKeys = new Set(current.map((d) => d.key));
    for (const key of [...this.divergenceSince.keys()]) {
      if (!currentKeys.has(key)) {
        this.divergenceSince.delete(key);
        this.divergenceAlarmAt.delete(key);
      }
    }
    for (const d of current) {
      if (!this.divergenceSince.has(d.key)) this.divergenceSince.set(d.key, this.now());
      const since = this.divergenceSince.get(d.key)!;
      if (this.now() - since < this.divergenceGraceMs) continue; // masa tenggang
      const lastAlarm = this.divergenceAlarmAt.get(d.key) ?? 0;
      if (this.now() - lastAlarm < this.alarmDedupMs) continue;
      this.divergenceAlarmAt.set(d.key, this.now());
      const persistMs = this.now() - since;
      const payload = {
        key: d.key, direction: d.direction, symbol: d.symbol, positionId: d.positionId ?? null,
        since: new Date(since).toISOString(), checkedAt: new Date(this.now()).toISOString(), persistMs,
        message: `Selisih DB vs exchange > ${Math.round(this.divergenceGraceMs / 60_000)} menit (${d.direction}): ${d.symbol}`,
      };
      logger.error({ key: d.key, direction: d.direction, symbol: d.symbol, persistMs }, "LIVE_DIVERGENCE_GT_5M");
      void db.eventLog.create({
        data: { type: "LIVE_DIVERGENCE_GT_5M", severity: "critical", payload: JSON.stringify(payload) },
      }).catch((err: unknown) => logger.error({ err: (err as Error)?.message }, "LIVE_DIVERGENCE_WRITE_FAIL"));
    }
  }

  /** A3: alarm ketidakpastian — pemeriksaan tidak berhasil berlarut (429/418/
   *  gagal) lebih dari checkUnavailableMs. Status proteksi/divergensi TIDAK
   *  terverifikasi; keheningan tidak boleh dianggap sehat. */
  private evaluateAvailability(): void {
    const staleMs = this.now() - this.lastSuccessfulCheckAt;
    if (staleMs < this.checkUnavailableMs) return;
    if (this.now() - this.unavailableAlarmAt < this.alarmDedupMs) return;
    this.unavailableAlarmAt = this.now();
    const payload = {
      lastSuccessfulCheckAt: new Date(this.lastSuccessfulCheckAt).toISOString(),
      staleMs,
      message: `Pemeriksaan proteksi/divergensi tidak berhasil ${Math.round(staleMs / 60_000)} menit — status proteksi TIDAK TERVERIFIKASI`,
    };
    logger.error({ staleMs }, "LIVE_PROTECTION_CHECK_UNAVAILABLE");
    void db.eventLog.create({
      data: { type: "LIVE_PROTECTION_CHECK_UNAVAILABLE", severity: "critical", payload: JSON.stringify(payload) },
    }).catch(() => undefined);
  }
  /** Kegagalan cek: 429/-1003 = mundur eksponensial tapi TIDAK berhenti;
   *  418 = STOP total + CRITICAL (aturan IP shared "STOP saat 418"). */
  private onCheckError(err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    const status = (err as { httpStatus?: number } | null)?.httpStatus;
    if (status === 418) {
      logger.error({ err: msg }, "LIVE_PROTECTION_CHECK_STOPPED_418");
      void db.eventLog.create({
        data: { type: "LIVE_PROTECTION_CHECK_STOPPED_418", severity: "critical",
          payload: JSON.stringify({ err: msg, message: "Monitor proteksi dihentikan: IP kena ban 418 (STOP saat 418)" }) } },
      ).catch(() => undefined);
      this.stop();
      return;
    }
    if (status === 429 || status === 418 || /code -1003/.test(msg)) {
      this.rateLimitBackoffMs = Math.min(this.rateLimitBackoffMs ? this.rateLimitBackoffMs * 2 : 30_000, 300_000);
      this.rateLimitUntil = this.now() + this.rateLimitBackoffMs;
      logger.warn({ err: msg, backoffMs: this.rateLimitBackoffMs }, "LIVE_PROTECTION_RATE_LIMIT_BACKOFF");
      return;
    }
    logger.warn({ err: msg }, "LIVE_PROTECTION_CHECK_FAILED");
  }
}

export const liveProtectionMonitor = new LiveProtectionMonitor();
