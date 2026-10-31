// apps/server/src/exec/exitAccounting.ts — 12 Okt 2026 (CP-1 + review gate 12 Okt):
// akuntansi exit WAJIB dari fill ASLI exchange (GET /fapi/v1/userTrades), BUKAN
// harga trigger. exitAvg = rata-rata tertimbang fill berdasarkan kuantitas di dalam
// SEGMEN posisi yang dapat diatribusikan; realized PnL, komisi, dan funding
// direkonsiliasi dari sumber exchange.
//
// ATRIBUSI (review gate kriteria 1-2): userTrades itu per-SYMBOL, bukan per-posisi.
// Simulasi netting One-Way Mode mengisolasi segmen posisi yang ditutup secara
// deterministik:
//   1. jendela dibatasi [openedAt - clockSkew, waktu fetch];
//   2. awal segmen = fill sisi ENTRY pertama di jendela (jaminan: prepareLiveSymbol
//      mewajibkan simbol FLAT sebelum entry — audit F-08, futuresOrderManager.ts);
//   3. sejak awal segmen: fill sisi entry menambah qty (termasuk penambahan manual),
//      fill sisi penutup mengonsumsi qty sampai qty berjalan habis;
//   4. qty kembali 0 => segmen selesai (posisi tertutup penuh); baris setelahnya
//      adalah GENERASI BERIKUTNYA (re-entry manual / posisi berikutnya) dan DIBUANG;
//   5. kelebihan qty sisi penutup melewati flat (flip manual membuka posisi berlawan)
//      => attribution AMBIGUOUS -> akuntansi TIDAK PERNAH VERIFIED;
//   6. fill penutup SEBELUM awal segmen (aktivitas generasi sebelumnya di dalam
//      jendela) diabaikan — bukan bagian posisi ini.
// Kelebihan kuantitas TIDAK diprorata diam-diam: penyebabnya ditentukan lewat dedupe
// id + simulasi netting; bila tidak dapat dibuktikan -> AMBIGUOUS/ESTIMATED.
//
// Semantik (review kriteria 3):
//   realizedPnlUsd = PnL GROSS berbasis harga dari exchange (TIDAK termasuk fee dan
//     funding; diverifikasi empiris kasus USUSDT 12 Okt: realized 1.62929, fee total
//     0.029277, funding -0.002226 -> NET 1.59779 = angka yang diterima operator).
//   feeUsd = Σ|commission| fill penutup yang dikonsumsi (+ sisi entry untuk
//     rekonsiliasi), HANYA denominasi USDT (feeAssetClean=false bila ada aset lain).
//   fundingUsd = Σ income FUNDING_FEE bertanda (negatif = kita membayar).
//   NET = realizedPnlUsd - feeUsd + fundingUsd. TIDAK ADA double-deduction:
//     realizedPnl exchange sudah mengecualikan fee & funding.
//   Anti duplikasi ledger: dedupe id trade (userTrades) + Trade unik per positionId.
//
// Kelengkapan (review kriteria 4): pagination userTrades yang mencapai cap dengan
// halaman terakhir masih penuh -> truncated=true -> bukti DITOLAK (null) -> ESTIMATED.
// Income funding >= 1000 baris (tidak lengkap) -> fundingVerified=false walau tetap
// dijumlahkan. Status verifikasi fill, fee, dan funding TERPISAH.
//
// Kepatuhan: seluruh jalur READ-ONLY (GET signed). Tidak ada order, tidak ada
// mutasi posisi, tidak ada LLM. Deterministik dan teruji tanpa jaringan.

export type ExchangeSide = "BUY" | "SELL";

export type ExitAttribution = "FULL" | "TRUNCATED_REENTRY" | "AMBIGUOUS";

export interface RawUserTradeRow {
  id?: unknown;
  time?: unknown;
  side?: unknown;
  price?: unknown;
  qty?: unknown;
  realizedPnl?: unknown;
  commission?: unknown;
  commissionAsset?: unknown;
  orderId?: unknown;
}

export interface AggregatedExit {
  /** true bila segmen posisi kembali flat dan qty penutup >= qty posisi. */
  complete: boolean;
  /** Harga rata-rata tertimbang fill penutup di segmen; null bila tak ada fill valid. */
  exitAvg: number | null;
  filledQty: number;
  /** Jumlah realizedPnl exchange dari porsi fill yang dikonsumsi; null bila ada
   * fill tanpa realizedPnl valid (caller menghitung dari harga fill). */
  realizedPnlUsd: number | null;
  /** Komisi sisi penutup (USDT-only; lihat feeAssetClean). */
  feeUsd: number;
  /** Komisi sisi ENTRY yang terekam di jendela yang sama (rekonsiliasi total). */
  entryFeeUsd: number;
  exitFillCount: number;
  /** Hasil atribusi segmen; AMBIGUOUS tidak pernah boleh VERIFIED. */
  attribution: ExitAttribution;
  /** false bila ada komisi fill yang dikonsumsi berdenominasi non-USDT. */
  feeAssetClean: boolean;
  /** orderId exchange dari fill penutup yang dikonsumsi (jejak atribusi). */
  exitOrderIds: number[];
}

function toFinite(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

interface ParsedFill {
  id: number;
  time: number;
  side: ExchangeSide;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  orderId: number | null;
  assetOk: boolean;
}

export function aggregateExitFills(input: {
  posSide: "LONG" | "SHORT";
  posQty: number;
  openedAtMs: number;
  rows: RawUserTradeRow[];
  clockSkewMs?: number;
}): AggregatedExit {
  const empty: AggregatedExit = {
    complete: false, exitAvg: null, filledQty: 0, realizedPnlUsd: null,
    feeUsd: 0, entryFeeUsd: 0, exitFillCount: 0,
    attribution: "AMBIGUOUS", feeAssetClean: true, exitOrderIds: [],
  };
  if (!(input.posQty > 0) || !Array.isArray(input.rows)) return empty;
  const closeSide: ExchangeSide = input.posSide === "LONG" ? "SELL" : "BUY";
  const entrySide: ExchangeSide = closeSide === "SELL" ? "BUY" : "SELL";
  const minTime = input.openedAtMs - (input.clockSkewMs ?? 5000);

  // Parse + validasi + dedupe id (event duplikat dihitung sekali).
  const seen = new Set<number>();
  const recs: ParsedFill[] = [];
  for (const raw of input.rows) {
    const id = toFinite(raw?.id);
    const time = toFinite(raw?.time);
    const price = toFinite(raw?.price);
    const qty = toFinite(raw?.qty);
    if (id === null || time === null || price === null || qty === null) continue;
    if (!(price > 0) || !(qty > 0) || time < minTime) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = String(raw?.side ?? "").toUpperCase();
    if (s !== "BUY" && s !== "SELL") continue;
    const orderId = toFinite(raw?.orderId);
    const asset = raw?.commissionAsset;
    const assetOk = asset === undefined || asset === null || String(asset).toUpperCase() === "USDT";
    recs.push({
      id, time, side: s as ExchangeSide, price, qty,
      realizedPnl: toFinite(raw?.realizedPnl) ?? NaN,
      commission: Math.abs(toFinite(raw?.commission) ?? 0),
      orderId: orderId === null ? null : Math.trunc(orderId),
      assetOk,
    });
  }
  if (recs.length === 0) return empty;
  recs.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id - b.id));

  // Awal segmen = fill sisi ENTRY pertama di jendela. Jaminan flat pra-entry
  // (prepareLiveSymbol) membuat semua fill penutup sebelum titik ini milik
  // generasi sebelumnya -> bukan posisi ini.
  const startIdx = recs.findIndex((r) => r.side === entrySide);
  if (startIdx < 0) return empty; // tanpa fill entry yang dapat diatribusi -> tak lengkap

  const tolQty = Math.max(input.posQty * 1e-9, 1e-12);
  let openQty = 0;
  let segmentDone = false;
  let flipExcess = false;
  let postSegmentClose = 0;
  let notional = 0;
  let filled = 0;
  let realized = 0;
  let realizedClean = true;
  let fee = 0;
  let entryFeeUsd = 0;
  let count = 0;
  let feeAssetClean = true;
  const orderIds = new Set<number>();

  for (let i = startIdx; i < recs.length; i++) {
    const r = recs[i]!;
    if (segmentDone) {
      // Generasi berikutnya (re-entry lalu close-nya) -> buang, catat untuk atribusi.
      if (r.side === closeSide) postSegmentClose += 1;
      continue;
    }
    if (r.side === entrySide) {
      openQty += r.qty;
      entryFeeUsd += r.commission;
      continue;
    }
    // Sisi penutup.
    if (openQty <= tolQty) continue; // tidak ada qty berjalan yang bisa ditutup
    const take = Math.min(r.qty, openQty);
    if (r.qty - take > tolQty) flipExcess = true; // kelebihan melewati flat = flip manual
    const ratio = take / r.qty;
    notional += take * r.price;
    if (Number.isFinite(r.realizedPnl)) realized += r.realizedPnl * ratio;
    else realizedClean = false;
    fee += r.commission * ratio;
    if (!r.assetOk) feeAssetClean = false;
    if (r.orderId !== null) orderIds.add(r.orderId);
    filled += take;
    openQty -= take;
    count += 1;
    if (openQty <= tolQty) {
      openQty = 0;
      segmentDone = true;
    }
  }

  if (filled <= 0) return empty;
  const complete = segmentDone && filled >= input.posQty - tolQty;
  const attribution: ExitAttribution =
    flipExcess ? "AMBIGUOUS" : postSegmentClose > 0 ? "TRUNCATED_REENTRY" : "FULL";
  return {
    complete,
    exitAvg: notional / filled,
    filledQty: filled,
    realizedPnlUsd: realizedClean ? realized : null,
    feeUsd: fee,
    entryFeeUsd,
    exitFillCount: count,
    attribution,
    feeAssetClean,
    exitOrderIds: [...orderIds].sort((a, b) => a - b),
  };
}

/** Klien struktural (memudahkan test mock) — dipenuhi BinanceUsdMClient. */
export interface UserTradesClient {
  getUserTrades(input: { symbol: string; startTime?: number; endTime?: number; fromId?: number; limit?: number }): Promise<RawUserTradeRow[]>;
}

export interface UserTradesWindow {
  rows: RawUserTradeRow[];
  /** true bila cap halaman tercapai dan halaman terakhir masih penuh — data
   * mungkin terpotong; caller WAJIB menolak klaim VERIFIED (review kriteria 4). */
  truncated: boolean;
}

/** Ambil seluruh userTrades simbol dalam jendela [startTime, endTime].
 * Halaman pertama: startTime+endTime (limit 1000). Halaman lanjutan WAJIB
 * fromId saja (kontrak Binance: fromId tidak boleh digabung startTime/endTime).
 * Berhenti saat halaman terakhir < 1000 baris atau cap maxPages (anti runaway);
 * cap tercapai dengan halaman terakhir penuh -> truncated=true. */
export async function fetchUserTradesWindow(
  client: UserTradesClient, symbol: string, startTime: number, endTime: number, maxPages = 5,
): Promise<UserTradesWindow> {
  const first = await client.getUserTrades({ symbol, startTime: Math.trunc(startTime), endTime: Math.trunc(endTime), limit: 1000 });
  const rows: RawUserTradeRow[] = Array.isArray(first) ? [...first] : [];
  let last = rows;
  let pages = 1;
  while (last.length >= 1000 && pages < maxPages) {
    const lastId = Number(last[last.length - 1]?.id);
    if (!Number.isFinite(lastId)) break;
    const next = await client.getUserTrades({ symbol, fromId: Math.trunc(lastId) + 1, limit: 1000 });
    const page: RawUserTradeRow[] = Array.isArray(next) ? next : [];
    rows.push(...page);
    last = page;
    pages += 1;
    if (page.length === 0) break;
  }
  return { rows, truncated: last.length >= 1000 };
}

export interface ExitDecisionInput {
  pos: { side: "LONG" | "SHORT"; entryPrice: number; qty: number };
  /** Hasil exchange (fill + funding); null bila pengambilan gagal / terpotong. */
  exchange: (AggregatedExit & { fundingUsd: number; fundingVerified: boolean }) | null;
  /** Fallback lama berbasis harga trigger/level (resolveExitPrice). */
  fallback: { price: number; reason: "TP1" | "SL" };
}

export interface ExitDecision {
  exitPrice: number;
  closeReason: "TP1" | "SL";
  /** PnL GROSS berbasis harga (fee & funding BELUM dikurang). */
  realizedPnlUsd: number;
  /** Σ komisi (entry+exit) denominasi USDT. */
  feeUsd: number;
  /** Σ funding bertanda (negatif = kita membayar). */
  fundingUsd: number;
  fundingVerified: boolean;
  /** false bila ada komisi non-USDT atau fill tidak terverifikasi. */
  feeVerified: boolean;
  quality: "VERIFIED" | "ESTIMATED";
  basis: "EXCHANGE_FILLS" | "TRIGGER_FALLBACK";
  attribution: ExitAttribution | "NONE";
  /** Alasan keputusan (untuk log/EventLog; "OK" bila VERIFIED bersih). */
  note: string;
}

/** Keputusan akuntansi exit — deterministik, tanpa I/O.
 * VERIFIED hanya bila fill exchange LENGKAP dan atribusi terbukti (FULL atau
 * TRUNCATED_REENTRY). AMBIGUOUS / tidak lengkap / bukti tak tersedia -> ESTIMATED
 * memakai fallback trigger dengan alasan eksplisit (tidak pernah diam-diam final).
 * NET direkonsiliasi sebagai: realizedPnlUsd - feeUsd + fundingUsd. */
export function decideExitAccounting(input: ExitDecisionInput): ExitDecision {
  const dir = input.pos.side === "LONG" ? 1 : -1;
  const ex = input.exchange;
  const usable = !!ex && ex.complete && ex.exitAvg !== null && ex.filledQty > 0 && ex.attribution !== "AMBIGUOUS";
  if (!usable) {
    const note = !ex
      ? "EXCHANGE_EVIDENCE_UNAVAILABLE"
      : !ex.complete
        ? "INCOMPLETE_FILLS"
        : "AMBIGUOUS_ATTRIBUTION";
    return {
      exitPrice: input.fallback.price,
      closeReason: input.fallback.reason,
      realizedPnlUsd: Number(((input.fallback.price - input.pos.entryPrice) * input.pos.qty * dir).toFixed(4)),
      feeUsd: 0,
      fundingUsd: 0,
      fundingVerified: false,
      feeVerified: false,
      quality: "ESTIMATED",
      basis: "TRIGGER_FALLBACK",
      attribution: ex?.attribution ?? "NONE",
      note,
    };
  }
  const exitPrice = ex!.exitAvg as number;
  // realized: angka exchange bila bersih; bila ada fill tanpa realizedPnl valid,
  // hitung deterministik dari harga fill (tetap berbasis fill, bukan trigger).
  const realized = ex!.realizedPnlUsd !== null
    ? Number(ex!.realizedPnlUsd.toFixed(4))
    : Number((dir * (exitPrice - input.pos.entryPrice) * input.pos.qty).toFixed(4));
  return {
    exitPrice,
    closeReason: realized > 0 ? "TP1" : "SL",
    realizedPnlUsd: realized,
    feeUsd: Number((ex!.feeUsd + ex!.entryFeeUsd).toFixed(6)),
    fundingUsd: Number(ex!.fundingUsd.toFixed(6)),
    fundingVerified: ex!.fundingVerified,
    feeVerified: ex!.feeAssetClean,
    quality: "VERIFIED",
    basis: "EXCHANGE_FILLS",
    attribution: ex!.attribution,
    note: "OK",
  };
}