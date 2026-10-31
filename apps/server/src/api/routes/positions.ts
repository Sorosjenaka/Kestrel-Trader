// apps/server/src/api/routes/positions.ts — Batch 5 extraction (FR-15/16/17/18/19/22).
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { SymbolRiskRules } from "../../risk/riskEngine.js";

import { usesSwingRr23, SWING_RR23 } from "../../strategies/swing/researchExitPolicy.js";
import { SWING_TP1_FRAC } from "../../strategies/swingBreakoutEngine.js";

// ── Dependency types (typeof = exact signature dari source module) ──────────
type ResolveEntryMode = typeof import("../tradingMode.js").resolveEntryMode;
type CalculateOrderPlan = typeof import("../../risk/riskEngine.js").calculateOrderPlan;
type MaxMarginForMode = typeof import("../../risk/riskEngine.js").maxMarginForMode;
type ResolveMarginPolicy = typeof import("../../risk/riskEngine.js").resolveMarginPolicy;
type CheckPairRedundancy = typeof import("../../exec/slotFillPolicy.js").checkPairRedundancy;
type CheckTradeVolume = typeof import("../../exec/slotFillPolicy.js").checkTradeVolume;
type CheckAssetClass = typeof import("../../universe/assetClassGuard.js").checkAssetClass;
type IsPerpListed = typeof import("../../universe/assetClassGuard.js").isPerpListed;
type ExecutePlannedEntry = typeof import("../../exec/plannedEntry.js").executePlannedEntry;
type EstimateCrossLiqPrice = typeof import("../../exec/positionSupervisor.js").estimateCrossLiqPrice;
type BuildLiveMirrorReport = typeof import("../../exec/liveMirror.js").buildLiveMirrorReport;
type BuildLiveDashboardReport = typeof import("../../exec/liveDashboard.js").buildLiveDashboardReport;
type BuildLiveMeshReport = typeof import("../../exec/liveMesh.js").buildLiveMeshReport;
type ClosePaperPositions = typeof import("../positionActions.js").closePaperPositions;
type LiveAccountMutationBlocked = typeof import("../positionActions.js").liveAccountMutationBlocked;
type GetPaperResetAt = typeof import("../../core/paperSession.js").getPaperResetAt;

interface DailyRiskGuardLike {
  canOpenPosition(symbol: string): Promise<{ allowed: boolean; reason?: string | null }>;
  evaluateStatus(): Promise<{ cumulativePnlUsd: number }>;
  isArmed(): boolean;
}

interface BinanceClientLike {
  getHubPrices(symbols?: string[]): { map: Record<string, { p: number; m: number; t: number; s: string; c: number; v: number; h: number; l: number }>; ageMs: number };
  fetchSymbolTicker(symbol: string): Promise<{ markPrice: number; volume24h: number } | null>;
  isPriceLive(symbol: string): boolean;
}

interface PositionSupervisorLike {
  emergencyKill(id: number, markPrice: number): Promise<void>;
}

interface UniverseRepoLike {
  getManualBlacklist(): Promise<string[]>;
}

export interface PositionsRouterDeps {
  db: PrismaClient;
  resolveEntryMode: ResolveEntryMode;
  calculateOrderPlan: CalculateOrderPlan;
  maxMarginForMode: MaxMarginForMode;
  resolveMarginPolicy: ResolveMarginPolicy;
  checkPairRedundancy: CheckPairRedundancy;
  checkTradeVolume: CheckTradeVolume;
  checkAssetClass: CheckAssetClass;
  isPerpListed: IsPerpListed;
  executePlannedEntry: ExecutePlannedEntry;
  estimateCrossLiqPrice: EstimateCrossLiqPrice;
  buildLiveMirrorReport: BuildLiveMirrorReport;
  buildLiveDashboardReport: BuildLiveDashboardReport;
  buildLiveMeshReport: BuildLiveMeshReport;
  closePaperPositions: ClosePaperPositions;
  liveAccountMutationBlocked: LiveAccountMutationBlocked;
  getPaperResetAt: GetPaperResetAt;
  PAPER_RESET_KEY: string;
  START_EQUITY_USD: number;
  marginMode: "ISOLATED" | "CROSS";
  executionMode: string;
  dailyRiskGuard: DailyRiskGuardLike;
  binance: BinanceClientLike;
  positionSupervisor: PositionSupervisorLike;
  prismaUniverseRepo: UniverseRepoLike;
}

/**
 * 25 Okt 2026 (perintah operator TP1/history): lifecycle parent position.
 * TP1 50% terisi tapi sisa masih OPEN -> parent harus TERLIHAT sebagai
 * PARTIALLY_CLOSED (atau setara) dengan realisasi TP1 langsung, BUKAN
 * "OPEN" polos. Final TP2/SL/TPMAX menutup sisa dan meng-update parent
 * yang sama (tetap satu baris history, Trade dibuat saat final saja).
 * Field ini turunan display — TIDAK mengubah status DB atau exit policy.
 * Murni & di-export untuk regression test.
 */
export function derivePositionLifecycle<T extends {
  status: string;
  qty?: number | null;
  originalQty?: number | null;
  tp1FilledAt?: Date | string | null;
  tp1FillPrice?: number | null;
  mode?: string | null;
  source?: string | null;
  entryAttrs?: string | null;
  quantityStep?: number | null;
}>(p: T): T & {
  lifecycle: string;
  closedQty: number | null;
  remainingQty: number | null;
  tp1TargetQty: number | null;
} {
  const orig = Number(p.originalQty ?? 0);
  const remaining = Number(p.qty ?? 0);
  const closedQty = orig > 0 ? Math.max(0, orig - remaining) : null;
  const partial = p.status === "OPEN" && orig > 0 && (p.tp1FilledAt != null || remaining < orig);
  // TP1 target follows the stored exit policy — not a hardcoded 50%.
  // SCALP single-target: 100% of original qty.
  // SWING RR23: 50% floor to step. SWING legacy: 40% floor to step.
  let tp1TargetQty: number | null = null;
  if (orig > 0) {
    if (p.mode === "SWING") {
      const step = Number(p.quantityStep ?? 0) > 0 ? Number(p.quantityStep) : 1e-8;
      const frac = usesSwingRr23({
        mode: p.mode ?? undefined,
        source: p.source ?? undefined,
        entryAttrs: p.entryAttrs ?? undefined,
      }) ? SWING_RR23.tp1Frac : SWING_TP1_FRAC;
      tp1TargetQty = Math.floor(orig * frac / step + 1e-9) * step;
      if (tp1TargetQty < step) tp1TargetQty = orig; // degenerate: single-target
    } else {
      tp1TargetQty = orig; // SCALP single-target closes 100%
    }
  }
  return {
    ...p,
    lifecycle: partial ? "PARTIALLY_CLOSED" : p.status,
    closedQty,
    remainingQty: orig > 0 ? remaining : null,
    tp1TargetQty,
  };
}

export function buildPositionsRouter(deps: PositionsRouterDeps): Router {
  const router = Router();
  const {
    db,
    resolveEntryMode,
    calculateOrderPlan,
    maxMarginForMode,
    resolveMarginPolicy,
    checkPairRedundancy,
    checkTradeVolume,
    checkAssetClass,
    isPerpListed,
    executePlannedEntry,
    estimateCrossLiqPrice,
    buildLiveMirrorReport,
    buildLiveDashboardReport,
    buildLiveMeshReport,
    closePaperPositions,
    liveAccountMutationBlocked,
    getPaperResetAt,
    PAPER_RESET_KEY,
    START_EQUITY_USD,
    marginMode,
    executionMode,
    dailyRiskGuard,
    binance,
    positionSupervisor,
    prismaUniverseRepo,
  } = deps;

  // ── Orders ─────────────────────────────────────────────────────────────────

  // FR-15, FR-16, NFR-13: Order Risk Sizing Plan
  router.post("/api/orders/plan", async (req, res) => {
    try {
      const selection = resolveEntryMode(req.body?.mode);
      if (!selection.allowed) return res.status(selection.status).json({ allowed: false, error: selection.error });
      const {
        symbol = "BTCUSDT",
        side = "BUY",
        entryPrice,
        slPrice,
        tp1Price,
        equityUsd = 100,
        targetRiskUsd = 1.0,
      } = req.body;

      if (!entryPrice || !slPrice) {
        return res.status(400).json({ error: "entryPrice and slPrice are required" });
      }

      const symRow = await db.symbol.findUnique({
        where: { symbol: String(symbol).toUpperCase() },
      });

      const symbolRules: SymbolRiskRules = {
        symbol: String(symbol).toUpperCase(),
        minNotional: symRow?.minNotional ?? 5.0,
        tickSize: symRow?.tickSize ?? 0.01,
        stepSize: symRow?.stepSize ?? 0.001,
        maxLeverage: symRow?.maxLeverage ?? 0,
        leverageUpdatedAt: symRow?.maxLeverageUpdatedAt ? symRow.maxLeverageUpdatedAt.getTime() : null,
        isBlacklisted: symRow?.isBlacklisted ?? false,
        blacklistReason: symRow?.blacklistReason ?? null,
      };

      const plan = calculateOrderPlan({
        symbol: symbolRules.symbol,
        mode: selection.mode,
        maxMarginUsd: maxMarginForMode(selection.mode),
        side,
        entryPrice: Number(entryPrice),
        slPrice: Number(slPrice),
        tp1Price: tp1Price ? Number(tp1Price) : undefined,
        equityUsd: Number(equityUsd),
        targetRiskUsd: Number(targetRiskUsd),
        riskBudgetMode: "GROSS" as const,
        allowStepOverhang: true,
        slippageBps: 0,
        marginMode: (marginMode === "ISOLATED" ? "ISOLATED" : "CROSS") as "CROSS" | "ISOLATED",
        symbolRules,
      });

      res.json({
        plan,
        allowed: plan.allowed,
        rejectReason: plan.rejectReason,
        sent: false,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // FR-22: Order Execution & Idempotency
  router.post("/api/orders/execute", (_req, res) => {
    // Raw opening/closing orders bypass position sizing and fill accounting.
    res.status(409).json({ allowed: false, error: "UNMANAGED_ORDER_DISABLED",
      hint: "Use /api/positions/open for validated entries and position exit endpoints for managed exits." });
  });

  router.get("/api/orders/:clientOrderId", async (req, res) => {
    try {
      const row = await db.orderExec.findUnique({
        where: { clientOrderId: req.params.clientOrderId },
      });
      if (!row) {
        return res.status(404).json({ error: "Order not found" });
      }
      res.json({ order: row });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Live Mirror ────────────────────────────────────────────────────────────

  // FR-17, FR-18, FR-19: Position Supervisor
  // Live Mirror (11 Okt 2026, perintah operator): dashboard perbandingan
  // READ-ONLY exchange Binance vs DB — untuk cross-check dengan website Binance.
  // Tidak mengirim order, tidak menulis DB (display-only, fail-closed).
  router.get("/api/live/mirror", async (_req, res) => {
    try {
      const report = await buildLiveMirrorReport();
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Dashboard gabungan LIVE + PAPER (27 Okt 2026, perintah operator: "tambahkan
  // juga fitur Live atau dashboard Live agar gw bisa lihat langsung jadi nya ada
  // paper yang terus berjalan dan Live berjalan terus juga").
  // READ-ONLY: hanya GET; tidak pernah mengirim order atau menulis DB.
  router.get("/api/live/dashboard", async (_req, res) => {
    try {
      const report = await buildLiveDashboardReport();
      res.setHeader("Cache-Control", "no-store");
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 27 Okt 2026: mesh mission-control — status nyata proses/agen/LLM + log.
  router.get("/api/live/mesh", async (_req, res) => {
    try {
      const report = await buildLiveMeshReport();
      res.setHeader("Cache-Control", "no-store");
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Positions CRUD ─────────────────────────────────────────────────────────

  router.get("/api/positions", async (req, res) => {
    try {
      const { status = "OPEN", symbol, includeDemo } = req.query;
      const positionsRaw = await db.position.findMany({
        where: {
          ...(status ? { status: String(status).toUpperCase() } : {}),
          ...(symbol ? { symbol: String(symbol).toUpperCase() } : {}),
          // T-5.16: data DEMO (pipeline uji) disembunyikan dari tampilan operator.
          ...(String(includeDemo ?? "") === "1" ? {} : { source: { not: "DEMO" } }),
        },
        orderBy: { openedAt: "desc" },
        include: { orders: true, trade: true },
      });
      const positions = positionsRaw.map(derivePositionLifecycle);
      // 15 Okt 2026 (fix #3177, operator: "balance 41$ tapi liq dekat banget,
      // gw pakai CROSS"): lampirkan estimasi harga likuidasi CROSS (equity-aware)
      // per posisi OPEN. Pro-rata stress scenario — informational, BUKAN angka
      // likuidasi exchange (butuh wallet/tier asli); UI menampilkan apa adanya.
      const openRows = positions.filter((p) => p.status === "OPEN");
      if (openRows.length > 0) {
        try {
          const { map: hubMap } = binance.getHubPrices();
          const guardStatus = await dailyRiskGuard.evaluateStatus().catch(() => null);
          const floating = openRows.reduce((sum, p) => {
            const mark = Number(hubMap[p.symbol]?.m ?? 0) || p.entryPrice;
            return sum + (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * Number(p.qty ?? 0);
          }, 0);
          const equityUsd = START_EQUITY_USD + Number(guardStatus?.cumulativePnlUsd ?? 0) + floating;
          const totalNotional = openRows.reduce((sum, p) => sum + Number(p.notional ?? 0), 0);
          const enriched = positions.map((p) => {
            if (p.status !== "OPEN" || !(totalNotional > 0)) return p;
            const liq = estimateCrossLiqPrice(p.entryPrice, p.side, equityUsd, totalNotional, Number(p.notional ?? 0));
            return liq != null ? { ...p, liqPrice: liq } : p;
          });
          res.json({ positions: enriched });
          return;
        } catch { /* gagal hitung → kirim tanpa liqPrice (UI fallback) */ }
      }
      res.json({ positions });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Entry Pipeline (FR-15/16, manual entry tervalidasi) ───────────────────

  router.post("/api/positions/open", async (req, res) => {
    try {
      const selection = resolveEntryMode(req.body?.mode);
      if (!selection.allowed) return res.status(selection.status).json({ allowed: false, error: selection.error });
      const {
        symbol,
        side,
        entryPrice,
        qty,
        leverage = 25,
        slPrice,
        tp1Price,
        outlookText,
        score = 78,
      } = req.body;

      if (!symbol || !side || !entryPrice) {
        return res.status(400).json({ error: "symbol, side, entryPrice are required" });
      }

      const sym = String(symbol).toUpperCase();
      // ── CRYPTO-ONLY (Rules §8, perintah operator 25 Sep 2026) ──
      // Saham/ETF/komoditas/index/FX TIDAK PERNAH boleh di-entry lewat jalur
      // manual. Cek daftar statis + registry exchangeInfo live (setelah sync),
      // ditambah blacklist manual operator dari tabel Symbol (dibaca lagi di
      // calculateOrderPlan di bawah sebagai lapis kedua).
      const assetCheck = checkAssetClass(sym, new Set(await prismaUniverseRepo.getManualBlacklist()));
      if (assetCheck.blocked) {
        return res.status(403).json({
          allowed: false,
          error: assetCheck.reason,
          symbol: sym,
          assetClass: assetCheck.assetClass,
          hint: "Hanya pair crypto (PERPETUAL/COIN/USDT) yang boleh ditradingkan",
        });
      }
      // ONLY FUTURES (perintah operator 26 Sep 2026): di luar allowlist PERPETUAL = tolak.
      if (isPerpListed(sym) === false) {
        return res.status(403).json({
          allowed: false,
          error: "NON_PERPETUAL",
          symbol: sym,
          hint: "Hanya pair Binance Futures PERPETUAL yang boleh ditradingkan",
        });
      }
      const guard = await dailyRiskGuard.canOpenPosition(sym);
      if (!guard.allowed) {
        return res.status(403).json({ allowed: false, error: guard.reason ?? "Order rejected by risk guard" });
      }

      // ── SATU TRADE PER PAIR (perintah operator 25 Sep 2026 — FINAL) ──
      // Pair yang posisinya masih OPEN tidak boleh di-entry lagi: tunggu trade-nya
      // selesai (TP2/BE/SL/TREND_FLIP/FUNDING/KILL). Tidak ada toleransi waktu.
      // Operator tetap bisa menembus dengan { overrideCooldown: true } bila disengaja.
      if (req.body?.overrideCooldown !== true) {
        const openForSymbol = await db.position.count({ where: { symbol: sym, status: "OPEN" } });
        const redundancy = checkPairRedundancy(openForSymbol);
        if (redundancy.blocked) {
          return res.status(403).json({
            allowed: false,
            error: redundancy.reason,
            symbol: sym,
            openPositionsForSymbol: openForSymbol,
            hint: "kirim { overrideCooldown: true } bila operator memang sengaja menembus aturan satu trade per pair",
          });
        }
      }
      const guardStatus = await dailyRiskGuard.evaluateStatus();
      const equityUsd = Number((START_EQUITY_USD + guardStatus.cumulativePnlUsd).toFixed(2));

      const posSide = side === "SELL" || side === "SHORT" ? "SHORT" : "LONG";
      // Gate harga live: entry WAJIB dari chart real-time Binance Futures, tolak harga basi.
      const liveTick = await binance.fetchSymbolTicker(sym);
      if (!liveTick || liveTick.markPrice <= 0 || !binance.isPriceLive(sym)) {
        return res.status(403).json({ allowed: false, error: "PRICE_NOT_LIVE", equityUsd });
      }
      const volumeGate = checkTradeVolume(liveTick.volume24h);
      if (!volumeGate.allowed) {
        return res.status(403).json({
          allowed: false,
          error: "VOLUME_BELOW_MIN",
          detail: volumeGate.reason,
          volume24hUsd: volumeGate.volumeUsd,
          minVolumeUsd: volumeGate.minVolumeUsd,
          equityUsd,
        });
      }
      const ePrice = Number(entryPrice);
      if (Math.abs(ePrice - liveTick.markPrice) / liveTick.markPrice > 0.01) {
        return res.status(403).json({ allowed: false, error: "STALE_ENTRY_PRICE", livePrice: liveTick.markPrice, equityUsd });
      }
      const useMode = selection.mode;

      const symRow = await db.symbol.findUnique({ where: { symbol: sym } });
      if (!symRow?.maxLeverage || !symRow.maxLeverageUpdatedAt) {
        return res.status(403).json({ allowed: false, error: "LEVERAGE_NOT_FOUND" });
      }
      const policy = resolveMarginPolicy({ mode: useMode, equityUsd, score: Number(score) || 78,
        structuralSlPct: slPrice === undefined ? undefined : Math.abs(ePrice - Number(slPrice)) / ePrice,
        maxLeverage: Math.min(Number(leverage), symRow.maxLeverage), seed: sym });
      if (!policy.allowed) return res.status(403).json({ allowed: false, error: policy.reason });
      const calculatedSl = slPrice !== undefined ? Number(slPrice) : ePrice * (posSide === "LONG" ? 1 - policy.slPct : 1 + policy.slPct);
      const input = {
        symbol: sym, mode: useMode, side: posSide as "LONG" | "SHORT", entryPrice: ePrice, slPrice: calculatedSl,
        // Omitted TP values are derived from the FINAL SL by the shared calculator.
        tp1Price: tp1Price === undefined ? undefined : Number(tp1Price),
        riskBudgetMode: "GROSS" as const,
        allowStepOverhang: true,
        slippageBps: 0,
        requestedQty: qty === undefined ? undefined : Number(qty),
        equityUsd, targetRiskUsd: policy.targetRiskUsd, leverageTarget: policy.leverage,
        marginMode: (marginMode === "ISOLATED" ? "ISOLATED" : "CROSS") as "CROSS" | "ISOLATED",
        maxMarginUsd: maxMarginForMode(useMode),
        marginCapPct: equityUsd < 180 ? 0.25 : 0.4,
        symbolRules: { symbol: sym, minNotional: symRow.minNotional, tickSize: symRow.tickSize,
          stepSize: symRow.stepSize, maxLeverage: symRow.maxLeverage,
          leverageUpdatedAt: symRow.maxLeverageUpdatedAt.getTime(), isBlacklisted: symRow.isBlacklisted },
      };
      const plan = calculateOrderPlan(input);
      if (!plan.allowed) return res.status(403).json({ allowed: false, error: plan.rejectReason });
      try {
        const opened = await executePlannedEntry(input, { mode: useMode, source: "MANUAL", outlookText });
        res.status(201).json({ position: opened.position, plan: opened.plan, simulated: opened.fill.simulated });
      } catch (error) {
        res.status(409).json({ allowed: false, error: (error as Error).message });
      }
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Stubs (disabled client-asserted operations) ────────────────────────────

  router.post("/api/positions/:id/hit-tp1", (_req, res) => {
    res.status(409).json({ error: "CLIENT_ASSERTED_FILL_DISABLED" });
  });

  router.get("/api/positions/:id", async (req, res) => {
    try {
      const pos = await db.position.findUnique({
        where: { id: Number(req.params.id) },
        include: { orders: true, trade: true },
      });
      if (!pos) {
        return res.status(404).json({ error: "Position not found" });
      }
      res.json({ position: derivePositionLifecycle(pos) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/positions/tick", (_req, res) => {
    res.status(409).json({ error: "CLIENT_ASSERTED_PRICE_DISABLED" });
  });

  // ── Kill / Emergency Close ─────────────────────────────────────────────────

  router.post("/api/positions/:id/kill", async (req, res) => {
    try {
      if (liveAccountMutationBlocked()) return res.status(403).json({ ok: false, error: "LIVE_ACCOUNT_MUTATIONS_BLOCKED" });
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: "INVALID_POSITION_ID" });
      if (!await db.position.findUnique({ where: { id }, select: { id: true } })) return res.status(404).json({ error: "Position not found" });
      const result = await closePaperPositions([id]);
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/positions/kill-all", async (_req, res) => {
    try {
      if (liveAccountMutationBlocked()) return res.status(403).json({ ok: false, error: "LIVE_ACCOUNT_MUTATIONS_BLOCKED" });
      const result = await closePaperPositions();
      res.status(result.ok ? 200 : 409).json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Trades Reset & Purge ───────────────────────────────────────────────────

  router.post("/api/trades/reset", async (_req, res) => {
    try {
      if (executionMode !== "PAPER") return res.status(403).json({ ok: false, error: "PAPER_ONLY_RESET" });
      if (dailyRiskGuard.isArmed()) return res.status(409).json({ ok: false, error: "DISARM_REQUIRED" });
      const open = await db.position.findMany({ where: { status: "OPEN", source: { not: "DEMO" } } });
      const { map } = binance.getHubPrices(open.map((p) => p.symbol));
      const missing = open.filter((p) => {
        const quote = map[p.symbol];
        return !(quote && Number.isFinite(quote.m) && quote.m > 0 && Date.now() - quote.t <= 30_000);
      });
      if (missing.length) return res.status(409).json({ ok: false, error: "FRESH_MARK_REQUIRED", symbols: missing.map((p) => p.symbol) });
      const closed: Array<{ id: number; symbol: string; markPrice: number }> = [];
      for (const pos of open) {
        // A PAPER market exit uses the fresh futures mark as a simulated fill.
        // Never manufacture a flat exit at entry merely to reach $200.
        const mark = map[pos.symbol]!.m;
        await positionSupervisor.emergencyKill(pos.id, mark);
        const updated = await db.position.findUnique({ where: { id: pos.id }, select: { status: true } });
        if (updated?.status !== "CLOSED") {
          return res.status(409).json({ ok: false, error: "PAPER_EXIT_INCOMPLETE", positionId: pos.id, closed });
        }
        closed.push({ id: pos.id, symbol: pos.symbol, markPrice: mark });
      }
      const archiveCount = await db.trade.count({ where: { source: { not: "DEMO" } } });
      const resetAt = new Date();
      await db.$transaction([
        db.setting.upsert({ where: { key: PAPER_RESET_KEY }, update: { value: resetAt.toISOString() }, create: { key: PAPER_RESET_KEY, value: resetAt.toISOString() } }),
        db.eventLog.create({ data: { type: "PAPER_SESSION_RESET", severity: "warn", payload: JSON.stringify({ resetAt: resetAt.toISOString(), startingEquityUsd: START_EQUITY_USD, archivedTrades: archiveCount, paperPositionsClosed: closed }) } }),
      ]);
      res.json({ ok: true, resetAt: resetAt.toISOString(), startingEquityUsd: START_EQUITY_USD, archivedTrades: archiveCount, closedPositionsCount: closed.length, message: `Periode PAPER baru dimulai dari $${START_EQUITY_USD.toFixed(2)}; trade lama tetap tersimpan untuk pembelajaran.` });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // Tombol "Bersihkan Non-Strategi" (perintah operator 26 Sep 2026): hapus trade
  // CLOSED beralasan non-strategi (KILL/LIQ_GAP/TIMEOUT/FUNDING) + posisinya,
  // sehingga history 100% outcome strategi (TP2/SL/BE/TREND_FLIP) dan winrate/
  // balance terkoreksi otomatis (dihitung live dari baris tersisa).
  // DIPERTAHANKAN: LearningEntry (otak) & EventLog (+ event audit purge ini).
  // Posisi OPEN tak pernah tersentuh (dibatalkan bila ada yang cocok).
  router.post("/api/trades/purge", async (req, res) => {
    try {
      const paperResetAt = await getPaperResetAt();
      const IMPURE = ["KILL", "LIQ_GAP", "TIMEOUT", "FUNDING"];
      const reasons = Array.isArray(req.body?.reasons) && req.body.reasons.length > 0
        ? req.body.reasons.map((r: unknown) => String(r).toUpperCase())
        : IMPURE;
      const targets = await db.position.findMany({
        where: { status: "CLOSED", closeReason: { in: reasons }, ...(paperResetAt ? { closedAt: { gte: paperResetAt } } : {}) },
        select: { id: true, symbol: true, closeReason: true, status: true },
      });
      const openHit = targets.filter((p) => p.status !== "CLOSED");
      if (openHit.length > 0) {
        return res.status(403).json({
          ok: false,
          error: "PURGE_REFUSED_OPEN",
          detail: `${openHit.length} posisi cocok tetapi tidak CLOSED`,
        });
      }
      const tradesBefore = await db.trade.count();
      const delPositions = await db.position.deleteMany({ where: { id: { in: targets.map((p) => p.id) } } });
      const tradesAfter = await db.trade.count();
      await db.eventLog.create({
        data: {
          type: "MANUAL_PURGE_NONSTRATEGY",
          severity: "warn",
          payload: JSON.stringify({
            action: "PURGE_NONSTRATEGY_HISTORY",
            reasons,
            timestamp: new Date().toISOString(),
            positionsDeleted: delPositions.count,
            tradesDeleted: tradesBefore - tradesAfter,
            symbols: targets.map((p) => `${p.symbol}:${p.closeReason}`),
          }),
        },
      });
      res.json({
        ok: true,
        reasons,
        positionsDeleted: delPositions.count,
        tradesDeleted: tradesBefore - tradesAfter,
        remainingTrades: tradesAfter,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  return router;
}
