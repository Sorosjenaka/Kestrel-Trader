// apps/server/src/agents/marketAnalyst.ts
// LLM MARKET ANALYST (14 Okt 2026, permintaan operator: "pasangin LLM nya…
// dia yang tugasnya analisis dan riset serta belajar evaluasi feedback dan
// dia yang menulis 5 why").
//
// Peran LLM di sistem ini TIDAK menyentuh keputusan entry (Golden Rule #1:
// angka SL/TP/entry selalu milik TS deterministik). Yang dilakukan loop ini:
//   1. MEMBACA ingatan terstruktur: SwingSignalLog (sinyal swing masuk/ditolak),
//      posisi open, trade yang baru close (hasil + riset post-mortem LLM yang
//      sudah ada di postMortemEvaluator/fiveWhys), dan ringkasan brief harian.
//   2. MENGANALISIS & MERANING via model penalaran (callReason): pola sinyal,
//      kualitas funnel, korelasi hasil, hal yang patut diteliti operator.
//   3. MENULIS hasilnya ke data/research/analyst-<dayKey>.md (riwayat append)
//      + EventLog "LLM_ANALYST" supaya bisa dibaca API/UI.
//
// Fail-open total: kegagalan LLM/DB tidak pernah melempar error ke bot; loop
// riset tidak boleh mengganggu trading. Budget tetap lewat gate adapter
// (canExecuteCall/isDegraded) + batas panggilan harian sendiri.
import { promises as fsp } from "node:fs";
import path from "node:path";
import { defaultLlmAdapter } from "./llmAdapter.js";
import { db } from "../core/db.js";
import { env } from "../core/env.js";
import { binanceFuturesClient } from "../markets/binanceFuturesClient.js";
import { gatherMarketContextSnapshot, buildMicrostructureSummary, buildMicrostructurePromptBlock, type MarketContextSnapshot } from "./marketIntel.js";
import { runTradeEvaluatorCycle } from "./tradeEvaluator.js";
import { runQuickAnalysisTriplet } from "./quickAnalysts.js";
import { runThesisArena } from "./thesisArena.js";
import { ALL_12_AGENTS } from "./agentCatalog.js";
import { maybeTriggerPanelAnalysis } from "../analysis/panelInsights.js";
import { logger } from "../core/logger.js";

export interface AnalystSnapshot {
  dayKey: string;
  swingSignals: { decision: string; strategyId: string; symbol: string; createdAt: Date }[];
  /** 27 Okt 2026: total sinyal 24 jam (baris yang ditampilkan dibatasi 50). */
  swingSignalsTotal?: number;
  openPositions: { symbol: string; side: string; strategyId: string | null; entryPrice: number; openedAt: Date }[];
  recentTrades: { symbol: string; pnlUsd: number; rMultiple: number | null; strategyId: string | null; closeReason: string | null; createdAt: Date }[];
  briefExcerpt: string;
  /** 14 Okt 2026: data likuidasi + order book untuk riset LLM (heatmap). */
  liquidations?: { windowMin: number; totalNotionalUsd: number; longLiqUsd: number; shortLiqUsd: number; count: number; topSymbols: { symbol: string; notionalUsd: number; count: number }[] };
  btcDepthWalls?: { bids: { price: number; qty: number }[]; asks: { price: number; qty: number }[] };
  /** 14 Okt 2026 (master task Fase 3+4): snapshot Market Intelligence deterministik. */
  marketIntel?: MarketContextSnapshot;
}

/** Kumpulkan data terbaru untuk analisis. Semua query fail-open (catch → kosong). */
export async function gatherAnalystSnapshot(dayKey: string): Promise<AnalystSnapshot> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [swingSignals, swingSignalsTotal, openPositions, recentTrades] = await Promise.all([
    // 27 Okt 2026 (audit beban analyst): 200 baris mentah = ~67% ukuran prompt.
    // 50 terbaru cukup untuk narasi; total asli tetap dikirim sebagai angka.
    db.swingSignalLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { decision: true, strategyId: true, symbol: true, createdAt: true },
    }).catch(() => []),
    db.swingSignalLog.count({ where: { createdAt: { gte: since } } }).catch(() => 0),
    db.position.findMany({
      where: { status: "OPEN", source: { not: "DEMO" } },
      orderBy: { openedAt: "desc" },
      take: 20,
      select: { symbol: true, side: true, strategyId: true, entryPrice: true, openedAt: true },
    }).catch(() => []),
    db.trade.findMany({
      where: { OR: [{ source: null }, { source: { not: "DEMO" } }] },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { symbol: true, pnlUsd: true, rMultiple: true, strategyId: true, createdAt: true, position: { select: { closeReason: true } } },
    }).catch(() => []),
  ]);
  let briefExcerpt = "";
  try {
    const briefPath = path.join(process.cwd(), "data", "research", `brief-${dayKey}.md`);
    const raw = await fsp.readFile(briefPath, "utf8");
    briefExcerpt = raw.slice(0, 3500);
  } catch {}
  const snap: AnalystSnapshot = {
    dayKey,
    swingSignals,
    swingSignalsTotal,
    openPositions,
    recentTrades: recentTrades.map((t) => ({
      symbol: t.symbol,
      pnlUsd: t.pnlUsd,
      rMultiple: t.rMultiple,
      strategyId: t.strategyId,
      closeReason: (t as unknown as { position?: { closeReason?: string | null } }).position?.closeReason ?? null,
      createdAt: t.createdAt,
    })),
    briefExcerpt,
  };
  // Fase 3: konteks pasar deterministik (breadth/regime/RS/likuiditas/kualitas
  // data) — fail-open, snapshot tidak valid tetap boleh (LLM diberi tahu via
  // data_quality di dalam snapshot).
  try {
    snap.marketIntel = await gatherMarketContextSnapshot();
  } catch {}
  // 14 Okt 2026: suplai riset LLM dengan likuidasi live (!forceOrder@arr) +
  // dinding order book BTC (fail-open — heatmap tidak boleh mengganggu loop).
  try {
    const { liquidationHub } = await import("../marketdata/liquidationHub.js");
    liquidationHub.start();
    snap.liquidations = liquidationHub.summary(120);
    const depth = await binanceFuturesClient.fetchDepth("BTCUSDT", 500).catch(() => null);
    if (depth) {
      const wall = (rows: [string, string][]) =>
        rows
          .map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 5);
      snap.btcDepthWalls = { bids: wall(depth.bids), asks: wall(depth.asks) };
    }
  } catch {}
  return snap;
}

/** Susun prompt pengguna dari snapshot (murni fungsi — mudah dites). */
export function buildAnalystPrompt(s: AnalystSnapshot): string {
  const totalNote = s.swingSignalsTotal != null && s.swingSignalsTotal > s.swingSignals.length
    ? ` (menampilkan ${s.swingSignals.length} terbaru dari ${s.swingSignalsTotal} sinyal 24 jam)`
    : "";
  const sig = s.swingSignals.length > 0
    ? s.swingSignals.map((x) => `- ${x.createdAt.toISOString()} ${x.symbol} ${x.strategyId} ${x.decision}`).join("\n") + totalNote
    : "(tidak ada sinyal swing 24 jam terakhir — normal untuk lane swing 1h yang selektif)";
  const pos = s.openPositions.length > 0
    ? s.openPositions.map((p) => `- ${p.symbol} ${p.side} ${p.strategyId ?? "?"} entry ${p.entryPrice} @ ${p.openedAt.toISOString()}`).join("\n")
    : "(tidak ada posisi open)";
  const liq = s.liquidations
    ? `Total $${s.liquidations.totalNotionalUsd.toLocaleString("en-US")} dalam ${s.liquidations.windowMin} mnt (${s.liquidations.count} event) — long dilikuidasi $${s.liquidations.longLiqUsd.toLocaleString("en-US")}, short $${s.liquidations.shortLiqUsd.toLocaleString("en-US")}; top: ${s.liquidations.topSymbols.map((t) => `${t.symbol} $${t.notionalUsd.toLocaleString("en-US")}(${t.count})`).join(", ") || "—"}`
    : "(data likuidasi tidak tersedia)";
  const walls = s.btcDepthWalls
    ? `BTC bid walls: ${s.btcDepthWalls.bids.map((w) => `${w.price}@${w.qty.toFixed(1)}`).join(", ") || "—"} | ask walls: ${s.btcDepthWalls.asks.map((w) => `${w.price}@${w.qty.toFixed(1)}`).join(", ") || "—"}`
    : "(order book tidak tersedia)";
  return [
    `Data per ${new Date().toISOString()} (dayKey ${s.dayKey}):`,
    "",
    "## Sinyal SWING 24 jam terakhir (SwingSignalLog)",
    sig,
    "",
    "## Posisi open",
    pos,
    "",
    "## Likuidasi 2 jam terakhir (stream resmi Binance !forceOrder@arr)",
    liq,
    "",
    "## Dinding order book BTC (5 level terbesar)",
    walls,
    "",
    "## Market Intelligence (deterministik, schema artatrade-market-intelligence-v1)",
    s.marketIntel
      ? JSON.stringify({
          generated_at: s.marketIntel.generated_at,
          universe: s.marketIntel.universe,
          breadth_1h: s.marketIntel.breadth_1h,
          breadth_24h: s.marketIntel.breadth,
          btc_relative_strength: s.marketIntel.btc_relative_strength,
          regime: s.marketIntel.regime,
          liquidity: s.marketIntel.liquidity,
          liquidations: s.marketIntel.liquidations,
          microstructure_and_flow: s.marketIntel.microstructure_and_flow,
          data_quality: s.marketIntel.data_quality,
        })
      : "(tidak tersedia)",
    "",
    "## Mikrostruktur & Order Flow (5 modul live — CVD, wall, peta likuidasi, volume profile, tier flow)",
    s.marketIntel ? buildMicrostructureSummary(s.marketIntel.microstructure_and_flow) : "(tidak tersedia)",
  ].join("\n");
}

/** Ringkasan 1 kalimat deterministik untuk fallback (byLlm=false jujur). */
export function analystFallbackSummary(s: AnalystSnapshot): string {
  const opened = s.swingSignals.filter((x) => x.decision === "ENTRY_OPENED").length;
  const rejected = s.swingSignals.filter((x) => x.decision !== "ENTRY_OPENED").length;
  const pnl = s.recentTrades.reduce((a, t) => a + t.pnlUsd, 0);
  return `Fallback deterministik: 24 jam terakhir ${opened} entry swing, ${rejected} sinyal lain (gap/ditolak/no-plan), PnL 15 trade terakhir $${pnl.toFixed(2)}. (LLM tidak tersedia.)`;
}

/**
 * Peta bukti untuk arena tesis (27 Okt 2026): ref -> nilai. Tesis Arya/Bayu
 * HANYA boleh mengutip ref yang terdaftar di sini — penjaga anti-tesis-ngawur.
 */
export function buildThesisEvidence(s: AnalystSnapshot): Record<string, string | number> {
  const ev: Record<string, string | number> = {
    signals24h: s.swingSignalsTotal ?? s.swingSignals.length,
    positionsOpen: s.openPositions.length,
    tradesRecent: s.recentTrades.length,
    pnlRecentUsd: Number(s.recentTrades.reduce((a, t) => a + t.pnlUsd, 0).toFixed(2)),
  };
  const intel = s.marketIntel;
  if (intel) {
    ev.regime = String(intel.regime ?? "UNKNOWN");
    ev.breadth1h = Number(intel.breadth_1h ?? 0);
    ev.breadth24h = Number(intel.breadth ?? 0);
    ev.btcRelativeStrength = Number(intel.btc_relative_strength ?? 0);
  }
  const micro = intel?.microstructure_and_flow;
  if (micro) {
    if (micro.orderFlowCvd?.allVenues != null) ev.cvdAllVenuesUsd = Number(micro.orderFlowCvd.allVenues);
    if (micro.wallLifelines) {
      ev.wallsActive = Number(micro.wallLifelines.active ?? 0);
      ev.largestWallUsd = Number(micro.wallLifelines.largestActiveUsd ?? 0);
    }
    if (micro.volumeProfile) {
      ev.pocPrice = Number(micro.volumeProfile.pocPrice ?? 0);
      ev.priceVsValueArea = String(micro.volumeProfile.priceVsValueArea ?? "UNKNOWN");
    }
  }
  if (s.liquidations) {
    ev.longLiqUsd = Number(s.liquidations.longLiqUsd ?? 0);
    ev.shortLiqUsd = Number(s.liquidations.shortLiqUsd ?? 0);
  }
  return ev;
}

export interface AnalystCycleResult {
  ran: boolean;
  byLlm: boolean;
  path: string | null;
  reason?: string;
}

/**
 * Satu siklus analisis. Dipanggil bot secara berkala (env LLM_ANALYST_INTERVAL_MIN).
 * Fail-open: error apa pun hanya di-log, tidak pernah throw.
 */
export async function runMarketAnalystCycle(dayKey: string, adapter = defaultLlmAdapter): Promise<AnalystCycleResult> {
  if (!env.LLM_ANALYST_ENABLED) return { ran: false, byLlm: false, path: null, reason: "DISABLED" };
  try {
    // Batas panggilan harian sendiri (hemat budget; fail-open).
    const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
    const usedToday = await db.eventLog.count({
      where: { type: "LLM_ANALYST", createdAt: { gte: dayStart } },
    }).catch(() => 0);
    if (usedToday >= env.LLM_ANALYST_MAX_DAILY_CALLS) {
      return { ran: false, byLlm: false, path: null, reason: "DAILY_CAP" };
    }
    const snapshot = await gatherAnalystSnapshot(dayKey);
    // 27 Okt 2026 (operator: "tambahin beberapa agar bisa bekerja dengan cepat
    // analisisnya"): callReason monolitik (berat, rawan terpotong) diganti TIGA
    // analis cepat PARALEL — Sari (konteks pasar), Tala (sinyal), Giri (funnel).
    // Wall-clock = 1 call, output per analis kecil (maks 8 baris).
    const quick = await runQuickAnalysisTriplet(snapshot, adapter);
    const byLlm = quick.allByLlm;
    const quickText = quick.sections
      .map((sec) => `### ${sec.title} — ${ALL_12_AGENTS[sec.agentId]?.name ?? sec.agentId} (byLlm: ${sec.byLlm ? "ya" : "fallback"})\n\n${sec.text}`)
      .join("\n\n");

    const outPath = path.join(process.cwd(), "data", "research", `analyst-${dayKey}.md`);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    // BAGIAN 3: laporan riset wajib memuat data mikrostruktur & order flow.
    // Blok Deterministik ditulis terpisah dari narasi LLM supaya data 5 modul
    // tetap ada di file walau LLM gagal / fallback.
    const microBlock = await buildMicrostructurePromptBlock("BTC");
    const microSection = microBlock
      ? `\n### Mikrostruktur & Order Flow (live, ${new Date().toISOString()})\n\n\`\`\`\n${microBlock.trim()}\n\`\`\`\n`
      : `\n### Mikrostruktur & Order Flow\n\n(tidak tersedia saat siklus ini)\n`;
    const block = [
      `\n---\n## Analisis ${new Date().toISOString()} (byLlm: ${byLlm ? "ya" : "tidak — fallback"})\n\n${quickText}\n`,
      `\n### Ringkasan Deterministik\n\n${analystFallbackSummary(snapshot)}\n`,
      `\n### Data (deterministik, lampiran)\n\n\`\`\`\n${buildAnalystPrompt(snapshot)}\n\`\`\`\n`,
      microSection,
    ].join("\n");
    await fsp.appendFile(outPath, block, "utf8");

    await db.eventLog.create({
      data: {
        type: "LLM_ANALYST",
        severity: "info",
        payload: JSON.stringify({ byLlm, path: outPath, signals: snapshot.swingSignals.length, trades: snapshot.recentTrades.length }),
      },
    }).catch(() => undefined);

    logger.info({ byLlm, outPath, signals: snapshot.swingSignals.length }, "LLM_ANALYST_DONE");
    // 14 Okt 2026 (permintaan operator): tugas analisis heatmap dipercayakan ke
    // persona VEGA (macro-scout — "tenang, ringkas, berbasis angka"): likuidasi
    // & dinding order book adalah konteks pasar/mikrostruktur, bukan keputusan
    // entry. Berjalan menumpuk siklus analyst (jadi ikut daily cap yang sama),
    // fail-open, dan TIDAK pernah menyentuh jalur order.
    await runHeatmapAnalysis(dayKey, snapshot, adapter, outPath).catch(() => undefined);
    // TAHAP 4D (26 Okt 2026): siklus analyst juga memicu analisis AI lima panel
    // (dedup hash + debounce + budget diatur di dalam modul; fail-open).
    maybeTriggerPanelAnalysis("BTC");
    // 27 Okt 2026 (pemecahan beban analyst): evaluasi trade + feedback loop
    // 5-why dikerjakan agen Mira (trade-evaluator) — interval + cap harian
    // diatur di dalam modul (self-gating), fail-open.
    await runTradeEvaluatorCycle(dayKey, snapshot, adapter).catch(() => undefined);
    // 27 Okt 2026 (operator: "sehabis analis ... masuk arena bertarung dalam
    // membuat thesis long atau short"): ARENA TESIS oleh Arya/Bayu/Ratih dengan
    // penjaga anti-looping + wajib kutip bukti. Interval/cap di dalam modul
    // (self-gating), read-only, TIDAK menyentuh keputusan entry/exit.
    await runThesisArena({
      symbol: "BTCUSDT",
      dayKey,
      analysisSummary: quick.sections.map((s) => `${s.title}: ${s.text}`).join(" | ").slice(0, 1500),
      evidence: buildThesisEvidence(snapshot),
    }, adapter).catch(() => undefined);
    return { ran: true, byLlm, path: outPath };
  } catch (err: any) {
    logger.info({ reason: err?.message }, "LLM_ANALYST_SKIPPED");
    return { ran: false, byLlm: false, path: null, reason: err?.message };
  }
}

/** Analisis heatmap likuiditas/likuidasi oleh persona Vega (macro-scout). */
export async function runHeatmapAnalysis(
  dayKey: string,
  snapshot: AnalystSnapshot,
  adapter = defaultLlmAdapter,
  outPath?: string,
): Promise<{ ran: boolean; byLlm: boolean }> {
  try {
    const liq = snapshot.liquidations;
    const walls = snapshot.btcDepthWalls;
    if (!liq && !walls) return { ran: false, byLlm: false };
    const liqText = liq
      ? `Window ${liq.windowMin} mnt — total $${liq.totalNotionalUsd.toLocaleString("en-US")} (${liq.count} event); long dilikuidasi $${liq.longLiqUsd.toLocaleString("en-US")}, short $${liq.shortLiqUsd.toLocaleString("en-US")}; simbol terbesar: ${liq.topSymbols.map((t) => `${t.symbol} $${t.notionalUsd.toLocaleString("en-US")} (${t.count}x)`).join(", ") || "—"}`
      : "(tidak tersedia)";
    const wallsText = walls
      ? `Bid: ${walls.bids.map((w) => `${w.price} × ${w.qty.toFixed(2)}`).join(" | ") || "—"}\nAsk: ${walls.asks.map((w) => `${w.price} × ${w.qty.toFixed(2)}`).join(" | ") || "—"}`
      : "(tidak tersedia)";
    const prompt = [
      "Data heatmap terbaru (sumber resmi Binance):",
      "",
      "## Likuidasi (stream !forceOrder@arr)",
      liqText,
      "",
      "## Dinding order book BTC (5 level qty terbesar)",
      wallsText,
      "",
      "Posisi open saat ini:",
      snapshot.openPositions.map((p) => `- ${p.symbol} ${p.side} entry ${p.entryPrice}`).join("\n") || "(tidak ada)",
      "",
      // BAGIAN 3: Vega (macro-scout) wajib melihat 5 modul mikrostruktur.
      (await buildMicrostructurePromptBlock("BTC")) || "(mikrostruktur & order flow tidak tersedia)",
      "Instruksi: analisis IMBALAN tekanan likuidasi (long vs short) dan posisi dinding order book",
      "relatif terhadap harga. Sebut zona harga yang berpotensi jadi magnet/Support-Resistance likuiditas,",
      "dan apa artinya bagi posisi open di atas. Ingat: ini KONTEKS RISET, bukan sinyal entry.",
      "Maksimal 12 baris.",
    ].join("\n");
    const system = [
      "Anda adalah VEGA (macro-scout) — agen riset makro & mikrostruktur pasar.",
      "Gaya: tenang, ringkas, berbasis angka. Anda menganalisis heatmap likuidasi dan order book.",
      "Anda TIDAK memberi sinyal entry — hanya konteks riset untuk operator dan analisis berikutnya.",
    ].join(" ");
    let text = "";
    let byLlm = false;
    try {
      const res = await adapter.callReason(prompt, system, { maxTokens: 900 });
      text = res.content.trim();
      byLlm = text.length > 0;
    } catch {}
    if (!byLlm) {
      text = liq
        ? `Fallback Vega: likuidasi ${liq.windowMin} mnt $${liq.totalNotionalUsd.toLocaleString("en-US")} (long $${liq.longLiqUsd.toLocaleString("en-US")} vs short $${liq.shortLiqUsd.toLocaleString("en-US")}). (LLM tidak tersedia.)`
        : "Fallback Vega: data heatmap tidak tersedia. (LLM tidak tersedia.)";
    }
    const target = outPath ?? path.join(process.cwd(), "data", "research", `analyst-${dayKey}.md`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.appendFile(target, [`\n---\n## Analisis HEATMAP — Vega (macro-scout) ${new Date().toISOString()} (byLlm: ${byLlm ? "ya" : "fallback"})\n\n${text}\n`].join("\n"), "utf8");
    await db.eventLog.create({
      data: { type: "LLM_HEATMAP", severity: "info", payload: JSON.stringify({ byLlm, path: target }) },
    }).catch(() => undefined);
    logger.info({ byLlm, target }, "LLM_HEATMAP_DONE");
    return { ran: true, byLlm };
  } catch (err: any) {
    logger.info({ reason: err?.message }, "LLM_HEATMAP_SKIPPED");
    return { ran: false, byLlm: false };
  }
}
