// apps/server/src/exec/liveMirror.ts — READ-ONLY mirror exchange Binance vs DB
// untuk dashboard perbandingan (perintah operator 11 Okt 2026: "dashboard
// terminal terpisah yang live... cocokin yang ada di website binance dan
// website gw, kalo ada kekurangan gw bisa minta perbaiki").
//
// DISPLAY-ONLY: modul ini TIDAK PERNAH mengirim order, TIDAK PERNAH menulis DB,
// dan tidak dipakai jalur trading mana pun. Gagal membaca exchange = field
// ditandai UNAVAILABLE + alasan, bukan angka nol palsu (fail-closed).
import { BinanceUsdMClient, type BinanceOpenOrderRow } from "./binanceUsdMClient.js";
import { cachedOpenAlgoOrders, cachedOpenOrders, cachedPositionRiskAll } from "./signedSnapshotCache.js";
import { env } from "../core/env.js";
import { db } from "../core/db.js";
import { START_EQUITY_USD } from "../risk/riskEngine.js";
import { defaultDailyRiskGuard } from "../risk/dailyGuard.js";
import { logger } from "../core/logger.js";

// ── Client read-only (boleh dipakai mode PAPER: hanya GET signed) ──────────
let cachedClient: BinanceUsdMClient | null = null;
function readClient(): BinanceUsdMClient | null {
  if (cachedClient) return cachedClient;
  if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) return null;
  cachedClient = new BinanceUsdMClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET });
  return cachedClient;
}

// ── Tipe laporan ───────────────────────────────────────────────────────────
export interface MirrorExchangeState {
  status: "OK" | "UNAVAILABLE";
  error?: string;
  walletBalance: number | null;
  availableBalance: number | null;
  positions: Array<{
    symbol: string; positionAmt: number; entryPrice: number | null; markPrice: number | null;
    leverage: string | null; marginType: string | null;
  }>;
  openOrders: Array<{
    clientOrderId: string; symbol: string; type: string; side: string;
    price: number | null; triggerPrice: number | null; qty: number | null;
    reduceOnly: boolean; status: string;
  }>;
  openAlgoOrders: Array<{
    clientAlgoId: string; symbol: string; algoStatus: string; triggerPrice: number | null;
  }>;
}

export interface MirrorDbState {
  positions: Array<{
    id: number; symbol: string; side: string; qty: number; entryPrice: number;
    slPrice: number; tp1Price: number; source: string; status: string;
    quantityStep: number | null;
  }>;
  orders: Array<{
    clientOrderId: string; symbol: string; type: string; side: string;
    price: number; qty: number; reduceOnly: boolean; status: string;
  }>;
  equityUsd: number;
  executionMode: "PAPER" | "LIVE";
  armed: boolean;
}

export type MirrorMatchStatus =
  | "COCOK" | "BEDA_QTY" | "BEDA_SISI" | "HANYA_DB" | "HANYA_EXCHANGE" | "TIDAK_DIBANDINGKAN";

export interface MirrorPositionRow {
  symbol: string;
  db: { id: number; side: string; qty: number; entryPrice: number; slPrice: number; tp1Price: number; source: string } | null;
  exchange: { positionAmt: number; entryPrice: number | null; markPrice: number | null; leverage: string | null; marginType: string | null } | null;
  status: MirrorMatchStatus;
  note: string;
}

export interface MirrorOrderRow {
  key: string;
  db: { clientOrderId: string; type: string; side: string; price: number; qty: number; reduceOnly: boolean; status: string } | null;
  exchange: { type: string; side: string; price: number | null; triggerPrice: number | null; qty: number | null; status: string; kind: "ORDER" | "ALGO" } | null;
  status: MirrorMatchStatus;
  note: string;
}

export interface LiveMirrorReport {
  generatedAt: string;
  exchange: MirrorExchangeState;
  db: MirrorDbState;
  positions: MirrorPositionRow[];
  orders: MirrorOrderRow[];
}

// ── Snapshot exchange (fail-closed: gagal = UNAVAILABLE, bukan nol) ────────
async function fetchExchangeState(): Promise<MirrorExchangeState> {
  const client = readClient();
  if (!client) {
    return { status: "UNAVAILABLE", error: "BINANCE_KEYS_MISSING", walletBalance: null, availableBalance: null, positions: [], openOrders: [], openAlgoOrders: [] };
  }
  try {
    // A4 (30 Okt 2026): snapshot list dibagi via signedSnapshotCache (TTL 3
    // dtk) dengan watcher/monitor — mengurangi panggilan signed redundan yang
    // menyumbang badai 429 (audit docs/audit-badai-429-2026-10-30.md). Jalur
    // display; kesegaran 3 dtk tidak terlihat di bawah cache dashboard 20 dtk.
    const [balances, riskRows, ordersRaw, algosRaw] = await Promise.all([
      client.getBalances(),
      cachedPositionRiskAll(client),
      cachedOpenOrders(client),
      cachedOpenAlgoOrders(client).catch(() => []), // algo list opsional (endpoint baru)
    ]);
    const usdt = balances.find((b) => b.asset === "USDT");
    const positions = riskRows
      .filter((r) => Number.isFinite(Number(r.positionAmt)) && Number(r.positionAmt) !== 0)
      .map((r) => ({
        symbol: r.symbol,
        positionAmt: Number(r.positionAmt),
        entryPrice: r.entryPrice != null && Number.isFinite(Number(r.entryPrice)) ? Number(r.entryPrice) : null,
        markPrice: r.markPrice != null && Number.isFinite(Number(r.markPrice)) ? Number(r.markPrice) : null,
        leverage: r.leverage ?? null,
        marginType: r.marginType ?? null,
      }));
    const openOrders = (ordersRaw as BinanceOpenOrderRow[]).map((o) => ({
      clientOrderId: String(o.clientOrderId ?? ""),
      symbol: String(o.symbol ?? ""),
      type: String(o.type ?? ""),
      side: String(o.side ?? ""),
      price: o.price != null && Number.isFinite(Number(o.price)) && Number(o.price) > 0 ? Number(o.price) : null,
      triggerPrice: (o as { stopPrice?: string }).stopPrice != null && Number.isFinite(Number((o as { stopPrice?: string }).stopPrice)) && Number((o as { stopPrice?: string }).stopPrice) > 0 ? Number((o as { stopPrice?: string }).stopPrice) : null,
      qty: o.origQty != null && Number.isFinite(Number(o.origQty)) ? Number(o.origQty) : null,
      reduceOnly: Boolean(o.reduceOnly),
      status: String(o.status ?? ""),
    }));
    const openAlgoOrders = (algosRaw as Array<Record<string, unknown>>).map((a) => ({
      clientAlgoId: String(a.clientAlgoId ?? a.clientOrderId ?? ""),
      symbol: String(a.symbol ?? ""),
      algoStatus: String(a.algoStatus ?? a.status ?? ""),
      triggerPrice: a.triggerPrice != null && Number.isFinite(Number(a.triggerPrice)) && Number(a.triggerPrice) > 0 ? Number(a.triggerPrice) : null,
    }));
    return {
      status: "OK",
      walletBalance: usdt ? Number(usdt.balance) : null,
      availableBalance: usdt ? Number(usdt.availableBalance) : null,
      positions, openOrders, openAlgoOrders,
    };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "LIVE_MIRROR_EXCHANGE_FETCH_FAILED");
    return {
      status: "UNAVAILABLE", error: (err as Error)?.message ?? "UNKNOWN",
      walletBalance: null, availableBalance: null, positions: [], openOrders: [], openAlgoOrders: [],
    };
  }
}

// ── Snapshot DB ────────────────────────────────────────────────────────────
async function fetchDbState(): Promise<MirrorDbState> {
  const [positions, orderRows, guard] = await Promise.all([
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { id: "asc" } }),
    db.orderExec.findMany({ where: { status: { in: ["NEW", "PARTIAL"] } }, orderBy: { id: "asc" } }),
    defaultDailyRiskGuard.evaluateStatus().catch(() => null),
  ]);
  return {
    positions: positions.map((p) => ({
      id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, entryPrice: p.entryPrice,
      slPrice: p.slPrice, tp1Price: p.tp1Price, source: p.source, status: p.status,
      quantityStep: p.quantityStep,
    })),
    orders: orderRows.map((o) => ({
      clientOrderId: o.clientOrderId, symbol: o.symbol, type: o.type, side: o.side,
      price: o.price, qty: o.qty, reduceOnly: Boolean(o.reduceOnly), status: o.status,
    })),
    equityUsd: guard ? Number((START_EQUITY_USD + guard.cumulativePnlUsd).toFixed(2)) : START_EQUITY_USD,
    executionMode: env.BINANCE_EXECUTION_MODE,
    armed: defaultDailyRiskGuard.isArmed(),
  };
}

// ── Perbandingan posisi (toleransi qty = stepSize lot) ─────────────────────
function matchPositions(db: MirrorDbState, exchange: MirrorExchangeState): MirrorPositionRow[] {
  const rows: MirrorPositionRow[] = [];
  const usedExchange = new Set<string>();
  for (const p of db.positions) {
    const ex = exchange.positions.find((e) => e.symbol === p.symbol && !usedExchange.has(e.symbol));
    const dbView = { id: p.id, side: p.side, qty: p.qty, entryPrice: p.entryPrice, slPrice: p.slPrice, tp1Price: p.tp1Price, source: p.source };
    if (!ex) {
      // Posisi PAPER memang tidak ada di exchange — bukan anomali.
      const paper = p.source.startsWith("PAPER_") || p.source === "DEMO";
      rows.push({
        symbol: p.symbol, db: dbView, exchange: null,
        status: paper ? "TIDAK_DIBANDINGKAN" : "HANYA_DB",
        note: paper ? "Posisi PAPER (simulasi) — memang tidak ada di exchange" : "ANOMALI: posisi LIVE ada di DB tapi tidak ada di exchange",
      });
      continue;
    }
    usedExchange.add(ex.symbol);
    const step = p.quantityStep && p.quantityStep > 0 ? p.quantityStep : 1e-8;
    const qtyTol = Math.max(step * 0.5, Math.abs(p.qty) * 1e-6);
    const qtyOk = Math.abs(Math.abs(ex.positionAmt) - p.qty) <= qtyTol;
    const sideOk = p.side === "LONG" ? ex.positionAmt > 0 : ex.positionAmt < 0;
    rows.push({
      symbol: p.symbol,
      db: dbView,
      exchange: { positionAmt: ex.positionAmt, entryPrice: ex.entryPrice, markPrice: ex.markPrice, leverage: ex.leverage, marginType: ex.marginType },
      status: !sideOk ? "BEDA_SISI" : !qtyOk ? "BEDA_QTY" : "COCOK",
      note: !sideOk ? "Arah posisi DB vs exchange berbeda"
        : !qtyOk ? `Qty beda: DB ${p.qty} vs exchange ${Math.abs(ex.positionAmt)}`
        : "DB dan exchange konsisten",
    });
  }
  for (const ex of exchange.positions) {
    if (usedExchange.has(ex.symbol)) continue;
    rows.push({
      symbol: ex.symbol, db: null,
      exchange: { positionAmt: ex.positionAmt, entryPrice: ex.entryPrice, markPrice: ex.markPrice, leverage: ex.leverage, marginType: ex.marginType },
      status: "HANYA_EXCHANGE",
      note: "ANOMALI: posisi di exchange tanpa catatan DB (orphan) — cek manual",
    });
  }
  return rows;
}

// ── Perbandingan order (match by clientOrderId / clientAlgoId) ─────────────
function matchOrders(db: MirrorDbState, exchange: MirrorExchangeState): MirrorOrderRow[] {
  const rows: MirrorOrderRow[] = [];
  const usedExchange = new Set<string>();
  const exchangeByKey = new Map<string, { type: string; side: string; price: number | null; triggerPrice: number | null; qty: number | null; status: string; kind: "ORDER" | "ALGO" }>();
  for (const o of exchange.openOrders) {
    if (o.clientOrderId) exchangeByKey.set(o.clientOrderId, { type: o.type, side: o.side, price: o.price, triggerPrice: o.triggerPrice, qty: o.qty, status: o.status, kind: "ORDER" });
  }
  for (const a of exchange.openAlgoOrders) {
    if (a.clientAlgoId) exchangeByKey.set(a.clientAlgoId, { type: "ALGO/STOP", side: "", price: null, triggerPrice: a.triggerPrice, qty: null, status: a.algoStatus, kind: "ALGO" });
  }
  for (const o of db.orders) {
    const ex = exchangeByKey.get(o.clientOrderId);
    const dbView = { clientOrderId: o.clientOrderId, type: o.type, side: o.side, price: o.price, qty: o.qty, reduceOnly: o.reduceOnly, status: o.status };
    if (ex) {
      usedExchange.add(o.clientOrderId);
      rows.push({ key: o.clientOrderId, db: dbView, exchange: ex, status: "COCOK", note: "Order tercatat di DB dan resting di exchange" });
    } else {
      rows.push({
        key: o.clientOrderId, db: dbView, exchange: null,
        status: "HANYA_DB",
        note: "ANOMALI: order di DB tapi tidak ada di exchange (sudah fill/tercancel, atau gagal pasang) — cek manual",
      });
    }
  }
  for (const [key, ex] of exchangeByKey.entries()) {
    if (usedExchange.has(key)) continue;
    rows.push({
      key, db: null, exchange: ex,
      status: "HANYA_EXCHANGE",
      note: "ANOMALI: order resting di exchange tanpa catatan DB — cek manual",
    });
  }
  return rows;
}

// ── Laporan utama ──────────────────────────────────────────────────────────
export async function buildLiveMirrorReport(): Promise<LiveMirrorReport> {
  const [exchange, dbState] = await Promise.all([fetchExchangeState(), fetchDbState()]);
  return {
    generatedAt: new Date().toISOString(),
    exchange,
    db: dbState,
    positions: matchPositions(dbState, exchange),
    orders: matchOrders(dbState, exchange),
  };
}
