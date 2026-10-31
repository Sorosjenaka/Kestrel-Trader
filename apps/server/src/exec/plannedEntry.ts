import { withSwingRr23Attrs } from "../strategies/swing/researchExitPolicy.js";
import { db } from "../core/db.js";
import { activeOrderExecutor, flattenLiveSymbol, checkLiveEntryGate, LIVE_MODE, liveExchange, livePositionWatcher, prepareLiveSymbol } from "./liveRuntime.js";
import { cancelPreEntryBracket, entryLimitPrice, placePreEntryBracket, realignBracketQty, verifyBracketActive, zoneEntryPrice, type BracketResult } from "./preEntryBracket.js";
import { generateClientOrderId, type ExecutionResult, type OrderCancellationResult } from "./orderExecutor.js";
import { defaultDailyRiskGuard, MAX_OPEN_POSITIONS } from "../risk/dailyGuard.js";
import { calculateOrderPlan, checkMarginLevel, checkSwingLiquidation, DEFAULT_MARGIN_CAP_PCT, DEFAULT_RISK_USD, fixedRiskLevels, START_EQUITY_USD, structuralRiskSizing, roundToTick, type RiskSizingInput } from "../risk/riskEngine.js";
import { assertLossCooldownForEntry } from "../risk/lossCooldown.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { canOpenTradingLane } from "./slotFillPolicy.js";
import { swingLadderLevelsFromTp1 } from "../strategies/swing/swingLevels.js";
import { countPositionsByMode } from "../strategies/modeContext.js";
import { env } from "../core/env.js";
import { SETUP_ENGINE, rrPolicyForMode } from "../config/setupEngine.js";
import { interceptApprovedPlaybookRules, prismaPlaybookRuleStore, recordApprovedRuleApplication } from "../learning/playbookRules.js";
import { checkDepth, type DepthLevel } from "./depthGuard.js";

/** Recompute quantity/RR at the latest mark instead of reusing a stale scan price. */
// 13 Okt 2026: menerima SWING (S-05) — gap diukur terhadap maxEntryGapPct mode
// masing-masing (SCALP 0.3%, SWING 1% dari close sinyal).
export function planAtFreshPrice(input: RiskSizingInput, equityUsd: number, mark: number, mode: "SCALP" | "SWING") {
  const gap = Math.abs(mark - input.entryPrice) / input.entryPrice;
  if (!(Number.isFinite(mark) && mark > 0) || !Number.isFinite(gap) || gap > SETUP_ENGINE.maxEntryGapPct[mode]) {
    throw new Error("PLAN_PRICE_CHANGED");
  }
  return calculateOrderPlan({ ...input, mode, equityUsd, entryPrice: mark });
}

// All opening routes share this critical section. One server process owns SQLite.
let entryTail: Promise<void> = Promise.resolve();
export async function withEntryLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = entryTail;
  let release!: () => void;
  entryTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

/** Remove protection only after the entry is terminal with zero cumulative fill.
 * A raced fill is returned to the caller for normal position persistence. */
export async function cleanupEntryAttempt(symbol: string, entryClientOrderId: string, preBracket: BracketResult | null,
  deps: { executor?: Pick<typeof activeOrderExecutor, "cancelEntry">; client?: typeof liveExchange } = {},
): Promise<OrderCancellationResult> {
  const settled = await (deps.executor ?? activeOrderExecutor).cancelEntry(symbol, entryClientOrderId)
    .catch((): OrderCancellationResult => ({ confirmed: false, reason: "CANCELLATION_STATE_UNKNOWN" }));
  if (!settled.confirmed || !settled.execution || settled.execution.filledQty !== 0) return settled;
  const client = deps.client ?? liveExchange;
  if (preBracket?.slClientAlgoId && client) {
    await cancelPreEntryBracket({ client, slClientAlgoId: preBracket.slClientAlgoId,
      tpClientAlgoId: preBracket.tpClientAlgoId, tp2ClientAlgoId: preBracket.tp2ClientAlgoId });
  }
  return settled;
}

/**
 * 12 Okt 2026 — PERINTAH OPERATOR (kasus LUMIAUSDT 11 Okt: entry terisi tanpa SL):
 *   "PASANG SL DAN TP NYA DULU ... verifikasi dulu ... baru entry"
 *   "PAKE METODE ORDER LIMIT AJA" "GW GA MAU TERULANG LAGI KASUS KAYAK GINI"
 * Urutan WAJIB: qty dari logic leverage (calculateOrderPlan) -> bracket SL/TP
 * reduceOnly+qty DIVERIFIKASI di exchange -> entry LIMIT -> gagal = batal semua.
 * Posisi TIDAK PERNAH telanjang: SL/TP sudah resting SEBELUM entry dikirim.
 */
export async function executePlannedEntry(input: RiskSizingInput, metadata: {
  // 13 Okt 2026: menerima SWING (lane S-05 Swing Breakout, cap 2 global).
  mode: "SCALP" | "SWING";
  source: "AI" | "MANUAL";
  strategyId?: string; strategyName?: string; entryType?: string;
  zoneType?: string | null; zoneTop?: number | null; zoneBottom?: number | null;
  /** T-01 (4 Okt 2026): snapshot atribut trigger & kondisi market (JSON teks, pencatatan). */
  entryAttrs?: string | null;
  /** New SWING entries: RR23 (50% @2R, BE, 50% @3R). Legacy only if explicitly requested. */
  swingExitPolicy?: "RR23" | "LEGACY_40_30";
  outlookText?: string;
}) {
  // C2 (30 Okt 2026, perintah operator): pembuatan posisi PAPER BARU dimatikan
  // lewat flag config PAPER_POSITIONS_ENABLED (default false). Funnel ini satu-
  // satunya jalur pembuatan posisi paper (fill.simulated -> source PAPER_*);
  // LIVE tidak terpengaruh. Kode paper TIDAK dihapus — hanya tidak menghasilkan
  // posisi baru. Flag TRUE di .env mengaktifkan kembali (keputusan operator).
  if (!LIVE_MODE && !env.PAPER_POSITIONS_ENABLED) {
    throw new Error("PAPER_POSITIONS_DISABLED");
  }
  // New SWING entries use RR23: TP1 50% @2R, BE after TP1, final TP2 50% @3R.
  // Legacy positions without the marker keep their original ladder. LIVE ARM
  // remains hard-blocked; this is engine readiness, not permission to trade.
  const swingExitPolicy = metadata.mode === "SWING" ? (metadata.swingExitPolicy ?? "RR23") : null;
  return withEntryLock(async () => {
    const guard = await defaultDailyRiskGuard.evaluateStatus();
    if (!guard.armed) throw new Error("ARM_REQUIRED");
    const open = await db.position.findMany({ where: { status: "OPEN", source: { not: "DEMO" } } });
    // 11 Okt 2026 (GO LIVE): di LIVE, slot posisi dihitung dari posisi LIVE saja — posisi
    // PAPER peninggalan periode simulasi tidak memakan slot dan tidak memblokir simbol.
    // 27 Okt 2026: `openForCap` juga menjadi SATU-SATUNYA sumber untuk margin
    // terpakai, floating PnL, dan notional likuidasi. Antesnya ketiganya memakai
    // `open` (semua posisi termasuk PAPER_AI) -> equity/margin/liq live dihitung
    // dari exposure yang tidak ada di exchange.
    const openForCap = LIVE_MODE ? open.filter((p) => String(p.source ?? "").startsWith("LIVE_")) : open;
    if (openForCap.length >= MAX_OPEN_POSITIONS) throw new Error("MAX_POSITIONS");
    // 11 Okt 2026 — seam pra-order fail-closed: cooldown pasca-LOSS 15 menit global
    // (audit 5 Whys). Throw = order TIDAK dikirim; keluar/reduce-only tidak lewat sini.
    assertLossCooldownForEntry();
    // Jalur LIVE (10 Okt 2026): batas posisi LIVE + saldo/margin/min-notional.
    // PAPER: gate mengembalikan allowed:true tanpa menyentuh exchange.
    if (LIVE_MODE) {
      const planPreview = calculateOrderPlan({ ...input, mode: metadata.mode, equityUsd: Number.MAX_SAFE_INTEGER });
      const gate = await checkLiveEntryGate({
        symbol: input.symbol,
        notionalUsd: planPreview.notionalUsd > 0 ? planPreview.notionalUsd : (input.entryPrice * (input.requestedQty ?? 0)),
        leverage: input.leverageTarget ?? 25,
      });
      if (!gate.allowed) throw new Error(gate.reason ?? "LIVE_ENTRY_GATE");
      // T-13 (CP-4): depth/impact guard fail-closed SEBELUM bracket/entry.
      if (env.LIVE_DEPTH_GUARD_ENABLED) {
        if (!liveExchange) throw new Error("LIVE_DEPTH_UNAVAILABLE");
        const book = await liveExchange.getDepth(input.symbol, 20).catch(() => null);
        if (!book) throw new Error("LIVE_DEPTH_UNAVAILABLE");
        const rawLevels = planPreview.side === "LONG" ? book.asks : book.bids;
        const levels: DepthLevel[] = rawLevels
          .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
          .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.qty) && l.qty > 0);
        const depth = checkDepth({
          side: planPreview.side,
          notionalUsd: planPreview.notionalUsd > 0 ? planPreview.notionalUsd : (input.entryPrice * (input.requestedQty ?? 0)),
          levels,
          maxSlippageBps: env.LIVE_DEPTH_GUARD_MAX_BPS,
        });
        if (!depth.allowed) throw new Error(`LIVE_DEPTH_REJECTED:${depth.reason ?? "UNKNOWN"}`);
      }
    }
    if (openForCap.some(p => p.symbol === input.symbol)) throw new Error("SYMBOL_ALREADY_OPEN");
    // 13 Okt 2026 — lane dua-arah: hitung posisi SWING terpisah untuk
    // cap 2 GLOBAL (SWING ditolak bila posisi swing open >= cap atau total open
    // penuh). Posisi tanpa strategyId dihitung SCALP (era lama semua SCALP).
    // 14 Okt 2026: lane SWING = S-03 + S-05 (bukan S-05 saja).
    const modeCounts = countPositionsByMode(openForCap);
    if (!canOpenTradingLane(metadata.mode, modeCounts, MAX_OPEN_POSITIONS)) throw new Error("MODE_CAP_REACHED");
    const prices = binanceFuturesClient.getHubPrices(openForCap.map(p => p.symbol)).map;
    let floating = 0;
    for (const p of openForCap) {
      const mark = prices[p.symbol]?.m ?? p.entryPrice;
      floating += (p.side === "LONG" ? mark - p.entryPrice : p.entryPrice - mark) * p.qty;
    }
    const equityUsd = START_EQUITY_USD + guard.cumulativePnlUsd + floating;
    if (!binanceFuturesClient.isPriceLive(input.symbol)) throw new Error("PRICE_NOT_LIVE");
    const mark = binanceFuturesClient.getHubPrices([input.symbol]).map[input.symbol]?.m;
    const plan = planAtFreshPrice(input, equityUsd, mark, metadata.mode);
    if (!plan.allowed) throw new Error(plan.rejectReason ?? "INVALID_PLAN");
    // ── 13 Okt 2026 — LOGIKA SL/TP FIX $1/$1.7 "lewat leverage" (perintah operator,
    // persis contoh setup manual: qty 2158 @ 0.013944 -> SL 0.014407 ($1.00),
    // TP 0.013156 ($1.70)): qty final dari margin/leverage -> jarak SL = $1/qty,
    // jarak TP = $1.7/qty. BUKAN jarak struktur strategi (bug 13 Okt: SL struktur
    // -> risk cuma $0.52, TP cuma $1.17). Nominal dijamin: risk TIDAK > $1.
    // ── 13 Okt 2026 (revisi 2) — TATA LETAK ENTRY ZONA (perintah operator:
    // "gw ga mau lagi ya kalo gw dalam posisi short malah nge short di bawah"):
    // SHORT -> LIMIT di zoneTop (jual di atas), LONG -> zoneBottom (beli di
    // bawah). Zona tidak valid / harga sudah melewati zona -> mark (perilaku lama).
    const entryPx = zoneEntryPrice({
      side: plan.side, mark,
      zoneTop: metadata.zoneTop, zoneBottom: metadata.zoneBottom,
      tickSize: input.symbolRules.tickSize,
    });
    if (plan.side === "LONG" ? entryPx <= plan.slPrice : entryPx >= plan.slPrice) {
      throw new Error("ZONE_ENTRY_INVALID_SL_DIRECTION");
    }
    // ── 13 Okt 2026 (revisi 2) — MARGIN = AKIBAT, $3 CUMA PLAFON (perintah
    // operator: "jangan FLAT set 3$, itu batasan maksimal penggunaan"). qty dari
    // risiko struktur (risk pas $1 di level invalidasi strategi); leverage
    // otomatis dinaikkan (maks 25x/maks simbol) supaya margin ≤ plafon. Bila
    // leverage maksimal simbol tetap kurang, qty dipotong sampai margin = plafon.
    const marginCapUsd = Math.min(
      equityUsd * (input.marginCapPct ?? DEFAULT_MARGIN_CAP_PCT),
      input.maxMarginUsd ?? Number.MAX_VALUE,
    );
    const sizing = structuralRiskSizing({
      entryPrice: entryPx,
      structuralSlPrice: plan.slPrice, // SL struktur dari strategi (pra-override)
      stepSize: input.symbolRules.stepSize,
      targetRiskUsd: input.targetRiskUsd ?? DEFAULT_RISK_USD,
      // 15 Okt 2026 (perintah operator): SWING wajib band risk $1–$1.2 —
      // di bawah $1 ditolak, margin disesuaikan turun (jangan pernah naik).
      enforceRiskBand: metadata.mode === "SWING",
      marginCapUsd,
      maxLeverage: input.symbolRules.maxLeverage,
      leverageTarget: plan.leverage,
      maxQty: Math.min(
        input.symbolRules.maxQty ?? Number.MAX_VALUE,
        input.requestedQty ?? Number.MAX_VALUE,
      ),
    });
    if (!sizing.ok) throw new Error(`SIZING_REJECTED:${sizing.reason}`);
    plan.qty = sizing.qty;
    plan.leverage = sizing.leverage;
    plan.notionalUsd = sizing.notionalUsd;
    plan.marginUsd = sizing.marginUsd;
    // ── 13 Okt 2026 — LANE SWING (S-05): SL/TP STRUKTURAL DIPERTAHANKAN ──
    // Formula "fix $1/$1.7 dari entry" di bawah HANYA untuk SCALP (perintah
    // operator 13 Okt era scalp: jarak SL = $1/qty). Untuk S-05, SL = garis
    // berlawanan x2 (invalidasi struktur, konvensi riset sim4), TP1 = 2R dan
    // TP2/final = 3R untuk RR23. Menimpanya = geometri riset hancur; Risk $1
    // dijamin oleh structuralRiskSizing di atas
    // (qty = $1 / jarak SL struktur); leverage otomatis menjaga jarak likuidasi.
    if (metadata.mode === "SWING") {
      const slDistPctSwing = Math.abs(entryPx - plan.slPrice) / entryPx;
      const openNotional = openForCap.reduce((sum, p) => sum + Number(p.notional ?? 0), 0);
      const liquidation = checkSwingLiquidation({
        marginMode: input.marginMode ?? env.MARGIN_MODE,
        side: plan.side,
        entryPrice: entryPx,
        slPrice: plan.slPrice,
        leverage: plan.leverage,
        equityUsd,
        totalOpenNotionalUsd: openNotional,
        positionNotionalUsd: plan.notionalUsd,
      });
      if (!liquidation.allowed) throw new Error(liquidation.reason ?? "SWING_SL_NEAR_LIQ");
      plan.slDistancePct = slDistPctSwing;
      plan.effectiveRiskUsd = sizing.riskAtStructureUsd;
      plan.estimatedNetRiskUsd = sizing.riskAtStructureUsd;
      // New PAPER policy: 50% at 2R, move the remaining stop to entry after
      // confirmed completion, then close the runner at 3R. LIVE remains blocked.
      const rSwing = Math.abs(entryPx - plan.slPrice);
      const sign = plan.side === "LONG" ? 1 : -1;
      const rawTp1 = entryPx + sign * rSwing * rrPolicyForMode("SWING", input.strategyId, input.tp1ROverride).tp1R;
      const gridTp1 = (plan.side === "LONG" ? Math.ceil(rawTp1 / input.symbolRules.tickSize - 1e-9)
        : Math.floor(rawTp1 / input.symbolRules.tickSize + 1e-9)) * input.symbolRules.tickSize;
      plan.tp1Price = roundToTick(gridTp1, input.symbolRules.tickSize);
      // Share the tick-rounded TP1 geometry with replay and supervisor (including zone entry repricing).
      plan.tp2Price = swingLadderLevelsFromTp1(plan.side, entryPx, plan.tp1Price, true).tp2;
    } else {
    // ── 13 Okt 2026 — LOGIKA SL/TP FIX $1/$1.7 "lewat leverage" (perintah operator,
    const fixed = fixedRiskLevels({
      entryPrice: entryPx, qty: plan.qty, side: plan.side,
      tickSize: input.symbolRules.tickSize,
      riskUsd: input.targetRiskUsd ?? DEFAULT_RISK_USD,
      tpUsd: (input.targetRiskUsd ?? DEFAULT_RISK_USD) * 1.7,
    });
    // Guard likuidasi: jarak SL tidak boleh mendekati jarak likuidasi (~1/leverage).
    const slDistPct = Math.abs(entryPx - fixed.slPrice) / entryPx;
    if (slDistPct >= (1 / plan.leverage) * 0.8) throw new Error("FIXED_SL_NEAR_LIQ");
    plan.slPrice = fixed.slPrice;
    plan.tp1Price = fixed.tpPrice;
    plan.tp2Price = fixed.tpPrice;
    plan.slDistancePct = slDistPct;
    plan.effectiveRiskUsd = fixed.riskUsd;
    plan.estimatedNetRiskUsd = fixed.riskUsd;
    } // ── END cabang SL/TP (SCALP fix $1/$1.7 | SWING struktural) ──
    // SMB autonomous hot path: all APPROVED machine-readable playbook rules are
    // evaluated immediately before the first order side effect. A veto is fail-closed.
    const ruleCheck = await interceptApprovedPlaybookRules({
      symbol: plan.symbol,
      side: plan.side,
      mode: metadata.mode,
      strategyId: metadata.strategyId ?? null,
      entryPrice: mark,
      slPrice: plan.slPrice,
      tp1Price: plan.tp1Price,
      riskUsd: plan.estimatedNetRiskUsd,
      targetRiskUsd: input.targetRiskUsd ?? 1,
      nowMs: Date.now(),
    }, { store: prismaPlaybookRuleStore });
    if (!ruleCheck.allowed) throw new Error(`ORDER_BLOCKED_BY_RULE:${ruleCheck.blockedBy.join(",")}`);
    const used = openForCap.reduce((sum, p) => sum + p.marginUsd, 0);
    const margin = checkMarginLevel(equityUsd, used + plan.marginUsd);
    if (!margin.allowed) throw new Error(margin.reason ?? "MARGIN_LEVEL_GUARD");
    // LIVE: prepare symbol (leverage + margin + cek flat) SEBELUM order masuk.
    if (LIVE_MODE) {
      const prep = await prepareLiveSymbol({
        symbol: plan.symbol, leverage: plan.leverage,
        marginMode: input.marginMode ?? "CROSS",
      });
      if (!prep.ok) throw new Error(prep.reason ?? "LIVE_PREPARE_FAILED");
    }

    // ===== FASE A (LIVE): BRACKET SL/TP DULU — diverifikasi sebelum entry =====
    // reduceOnly+qty diterima exchange tanpa posisi (probe zero-risk 11 Okt;
    // closePosition ditolak -4509 = penyebab desain lama pasca-fill).
    const entryClientOrderId = generateClientOrderId(plan.symbol);
    let preBracket: BracketResult | null = null;
    if (LIVE_MODE && liveExchange) {
      preBracket = await placePreEntryBracket({
        symbol: plan.symbol, side: plan.side, entryPrice: entryPx,
        qty: plan.qty, slPrice: plan.slPrice, tp1Price: plan.tp1Price,
        // RR23: TP1 50% @2R, TP2/final 50% @3R. Legacy keeps 40/30/runner.
        tp2Price: metadata.mode === "SWING" ? plan.tp2Price : null,
        swingExitPolicy: metadata.mode === "SWING" ? swingExitPolicy ?? "RR23" : undefined,
        stepSize: input.symbolRules.stepSize,
        tickSize: input.symbolRules.tickSize,
        refId: entryClientOrderId, client: liveExchange,
      });
      if (!preBracket.ok) {
        // Tidak ada satu pun yang tertinggal; entry TIDAK dikirim.
        throw new Error(`PRE_ENTRY_BRACKET_FAILED:${preBracket.reason ?? "UNKNOWN"}`);
      }
    }

    // ===== FASE B: ENTRY LIMIT (perintah operator "PAKE METODE ORDER LIMIT AJA") =====
    let fill: ExecutionResult;
    try {
      fill = await activeOrderExecutor.executeOrder({
        clientOrderId: entryClientOrderId,
        symbol: plan.symbol, side: plan.side === "LONG" ? "BUY" : "SELL",
        type: "LIMIT", price: entryPx, qty: plan.qty, reduceOnly: false,
        // T-13 (CP-4): post-only di LIVE agar entry tetap maker; GTX ditolak
        // exchange bila crossing (fail-closed, bukan diubah jadi taker diam-diam).
        timeInForce: LIVE_MODE && env.LIVE_POST_ONLY_ENABLED ? "GTX" : undefined,
      });
      if (fill.status === "NEW" || fill.status === "PARTIAL") {
        // Tunggu fill terbatas (LIMIT GTC). Tidak terisi = batal bersih.
        fill = await activeOrderExecutor.verifyFill(plan.symbol, entryClientOrderId, 15_000, 250);
      }
    } catch (err) {
      const recovery = await cleanupEntryAttempt(plan.symbol, entryClientOrderId, preBracket);
      if (recovery.confirmed && recovery.execution && recovery.execution.filledQty > 0) fill = recovery.execution;
      else throw err;
    }
    if (!(fill.filledQty > 0)) {
      const recovery = await cleanupEntryAttempt(plan.symbol, entryClientOrderId, preBracket);
      if (recovery.confirmed && recovery.execution && recovery.execution.filledQty > 0) fill = recovery.execution;
      else throw new Error(recovery.confirmed ? "ENTRY_NOT_FILLED_CANCELLED" : "ENTRY_STATE_UNKNOWN_PROTECTION_RETAINED");
    }
    // PARTIAL fill: batalkan sisa entry, selaraskan bracket ke qty aktual.
    if (fill.filledQty < plan.qty) {
      const settled = await activeOrderExecutor.cancelEntry(plan.symbol, entryClientOrderId);
      if (!settled.confirmed || !settled.execution) throw new Error("ENTRY_STATE_UNKNOWN_PROTECTION_RETAINED");
      fill = settled.execution;
      if (preBracket?.slClientAlgoId && liveExchange) {
        const realigned = await realignBracketQty({
          symbol: plan.symbol, side: plan.side, entryPrice: entryPx,
          qty: fill.filledQty, slPrice: plan.slPrice, tp1Price: plan.tp1Price,
          tp2Price: metadata.mode === "SWING" ? plan.tp2Price : null,
          swingExitPolicy: metadata.mode === "SWING" ? swingExitPolicy ?? "RR23" : undefined,
          stepSize: input.symbolRules.stepSize,
          tickSize: input.symbolRules.tickSize,
          refId: `${entryClientOrderId}R`, client: liveExchange,
          oldSlClientAlgoId: preBracket.slClientAlgoId,
          oldTpClientAlgoId: preBracket.tpClientAlgoId,
          oldTp2ClientAlgoId: preBracket.tp2ClientAlgoId,
        });
        if (!realigned.ok) {
          // Proteksi hilang = posisi TIDAK boleh dibiarkan: flatten (fail-closed).
          await flattenLiveSymbol({ symbol: plan.symbol, side: plan.side, qty: fill.filledQty, reason: `BRACKET_REALIGN_FAILED_${realigned.reason ?? ""}` });
          throw new Error(`BRACKET_REALIGN_FAILED:${realigned.reason ?? "UNKNOWN"}`);
        }
        preBracket = realigned;
      }
    }

    // ===== FASE C: RESOLUSI HARGA FILL — TIDAK PERNAH throw setelah fill =====
    // (bug 11 Okt: response awal Binance bisa membawa filledQty>0 dengan
    // avgPrice=0; throw saat itu melepas posisi TELANJANG. Sekarang: resolve
    // dulu via queryOrder; fallback = harga limit order (untuk LIMIT BUY fill
    // <= limit = batas konservatif; dicatat, bukan dikarang).)
    let entryPrice = Number(fill.fillPrice);
    if (!(entryPrice > 0)) {
      try {
        const resolved = await activeOrderExecutor.verifyFill(plan.symbol, entryClientOrderId, 3_000, 200);
        entryPrice = Number(resolved.fillPrice);
      } catch { /* fallback di bawah */ }
    }
    const priceEstimated = !(entryPrice > 0);
    if (priceEstimated) entryPrice = mark;
    if (metadata.mode === "SWING" && fill.simulated) {
      // Freeze targets against the confirmed entry, including LIMIT price improvement.
      const sign = plan.side === "LONG" ? 1 : -1;
      const distance = Math.abs(entryPrice - plan.slPrice);
      const tick = input.symbolRules.tickSize;
      plan.tp1Price = roundToTick(entryPrice + sign * 2 * distance, tick);
      plan.tp2Price = roundToTick(entryPrice + sign * 3 * distance, tick);
    }
    const qty = fill.filledQty;
    const notional = entryPrice * qty;
    const position = await db.$transaction(async tx => {
      const row = await tx.position.create({ data: {
        symbol: plan.symbol, side: plan.side, mode: metadata.mode, entryPrice, qty,
        notional, leverage: plan.leverage, marginUsd: notional / plan.leverage,
        slPrice: plan.slPrice, tp1Price: plan.tp1Price, tp2Price: plan.tp2Price,
        originalQty: qty, originalSlPrice: plan.slPrice,
        originalRiskUsd: Math.abs(entryPrice - plan.slPrice) * qty,
        // Budget NET ($) dari sizing = denominator R ternormalisasi (opsi b, 29 Sep 2026).
        // originalRiskUsd tetap GROSS price risk untuk audit basis jarak harga.
        riskBudgetUsd: plan.estimatedNetRiskUsd,
        entryFeeUsd: fill.feeUsd, entryFeeEstimated: fill.feeEstimated ?? true,
        quantityStep: input.symbolRules.stepSize,
        priceTick: input.symbolRules.tickSize, accountingVersion: 1,
        mfePrice: entryPrice, maePrice: entryPrice,
        source: `${fill.simulated ? "PAPER" : "LIVE"}_${metadata.source}`,
        marginMode: input.marginMode ?? "CROSS", status: "OPEN", openedAt: new Date(),
        strategyId: metadata.strategyId, strategyName: metadata.strategyName,
        entryType: metadata.entryType, zoneType: metadata.zoneType, zoneTop: metadata.zoneTop,
        zoneBottom: metadata.zoneBottom,
        entryAttrs: metadata.mode === "SWING" && swingExitPolicy === "RR23" ? withSwingRr23Attrs(metadata.entryAttrs) : metadata.entryAttrs ?? null,
        outlookText: `${metadata.outlookText?.trim() || "Order plan"}; final estimated net stop risk $${plan.estimatedNetRiskUsd.toFixed(4)} with ${input.slippageBps ?? 0}bps gap; ${fill.simulated ? "PAPER" : "EXCHANGE"}${priceEstimated ? "; entryPrice ESTIMATED (avgPrice belum tersedia saat catat)" : ""}`,
      } });
      await tx.orderExec.updateMany({ where: { clientOrderId: fill.clientOrderId }, data: { positionId: row.id } });
      return row;
    });

    // ===== FASE D (LIVE): VERIFIKASI AKHIR — bracket masih hidup setelah fill =====
    if (LIVE_MODE && liveExchange && preBracket) {
      const check = await verifyBracketActive({
        client: liveExchange,
        slClientAlgoId: preBracket.slClientAlgoId,
        tpClientAlgoId: preBracket.tpClientAlgoId,
        tp2ClientAlgoId: preBracket.tp2ClientAlgoId,
        slPrice: plan.slPrice, tp1Price: plan.tp1Price,
        tp2Price: metadata.mode === "SWING" ? plan.tp2Price : null,
        tickSize: input.symbolRules.tickSize,
      });
      if (!check.ok) {
        await flattenLiveSymbol({ symbol: plan.symbol, side: plan.side, qty, reason: `BRACKET_LOST_AFTER_FILL_${check.reason ?? ""}` });
        throw new Error(`BRACKET_LOST_AFTER_FILL:${check.reason ?? "UNKNOWN"}`);
      }
      if (preBracket.slClientAlgoId) {
        livePositionWatcher.recordStopIntent(position.id, preBracket.slClientAlgoId);
      }
      await db.eventLog.create({
        data: {
          type: "LIVE_PRE_ENTRY_BRACKET",
          severity: "info",
          payload: JSON.stringify({
            positionId: position.id, symbol: plan.symbol, side: plan.side,
            slClientAlgoId: preBracket.slClientAlgoId, tpClientAlgoId: preBracket.tpClientAlgoId ?? null,
            tp2ClientAlgoId: preBracket.tp2ClientAlgoId ?? null,
            slPrice: plan.slPrice, tp1Price: plan.tp1Price, tp2Price: plan.tp2Price,
            qty, entryPrice,
          }),
        },
      });
    }
    // Count APPLIED only after the position row and entry fill exist. The realized
    // R is attached by the post-trade outcome hook; null here is intentional.
    await recordApprovedRuleApplication(ruleCheck.appliedRuleIds, {
      store: prismaPlaybookRuleStore,
      tradeId: position.id,
      rMultiple: null,
    });
    return { position, plan, fill };
  });
}
