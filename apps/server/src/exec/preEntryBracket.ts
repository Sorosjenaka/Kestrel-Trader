// apps/server/src/exec/preEntryBracket.ts — 12 Okt 2026
// PERINTAH OPERATOR (kasus LUMIAUSDT 11 Okt, loss $2.52 karena posisi telanjang):
//   "PASANG SL DAN TP NYA DULU ... verifikasi dulu lewat sana ... baru entry"
//   "PAKE METODE ORDER LIMIT AJA" "GW GA MAU TERULANG LAGI KASUS KAYAK GINI"
//
// Urutan WAJIB (kontrak desain):
//   1. pasang SL (algo CONDITIONAL, reduceOnly+qty)  -> VERIFIKASI trigger di-echo
//   2. pasang TP (algo CONDITIONAL, reduceOnly+qty)  -> VERIFIKASI trigger di-echo
//   3. BARU kirim entry (LIMIT) — dipanggil plannedEntry setelah ok:true
// Gagal di tahap mana pun = batal semua + entry TIDAK dikirim (posisi tidak pernah telanjang).
//
// Dasar probe 11 Okt (tools/probe-preentry-sltp-v2.mjs, zero-risk):
//   closePosition=true DITOLAK tanpa posisi (-4509) — itu sebab desain lama pasca-fill.
//   reduceOnly=true + quantity DITERIMA tanpa posisi (200, algoStatus NEW, bisa
//   diverifikasi queryAlgo dan dibatalkan). SL = STOP_MARKET; TP = TAKE_PROFIT
//   limit (fill TP = maker, cocok model fee: TP maker / SL taker).
//
// Batasan jujur: reduceOnly = order tidak pernah membuka posisi; jika entry tidak
// pernah terisi, bracket hanya menganggur (dibatalkan caller). Trigger di-echo dan
// dicek ke tick — "order diterima" TIDAK dianggap "order aktif" (pitfall: trigger
// salah nama param = diterima tapi tidak pernah nyala).
import type { BinanceUsdMClient, BinanceAlgoResponse } from "./binanceUsdMClient.js";
import { SWING_RR23 } from "../strategies/swing/researchExitPolicy.js";

export interface BracketInput {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  qty: number;
  slPrice: number;
  tp1Price: number | null;
  tickSize: number;
  refId: string;
  client: BinanceUsdMClient;
  // Ladder SWING: RR23 = TP1 50% @2R + TP2/final 50% @3R (no runner leg);
  // legacy = TP1 40% + TP2 30% + runner 30% @TPMAX. SL tetap full qty.
  tp2Price?: number | null;
  stepSize?: number;
  swingExitPolicy?: "RR23" | "LEGACY_40_30";
}

export interface BracketResult {
  ok: boolean;
  reason?: string;
  slClientAlgoId?: string;
  tpClientAlgoId?: string;
  tp2ClientAlgoId?: string;
}

export function bracketAlgoIdsV2(refId: string): { slClientAlgoId: string; tpClientAlgoId: string; tp2ClientAlgoId: string } {
  const base = refId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
  return { slClientAlgoId: `SLA_${base}`, tpClientAlgoId: `TPA_${base}`, tp2ClientAlgoId: `TPB_${base}` };
}

/** Kuantisasi qty fase ladder ke stepSize (floor). < step -> 0 (fase dilewati). */
export function ladderLegQty(qty: number, frac: number, stepSize: number | undefined): number {
  if (!(qty > 0)) return 0;
  if (!stepSize || !(stepSize > 0)) return qty * frac;
  return Math.floor((qty * frac) / stepSize + 1e-9) * stepSize;
}

export function bracketAlgoIds(refId: string): { slClientAlgoId: string; tpClientAlgoId: string } {
  const base = refId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
  return { slClientAlgoId: `SLA_${base}`, tpClientAlgoId: `TPA_${base}` };
}

function triggerEchoed(quoted: string | number | undefined, intended: number, tickSize: number): boolean {
  const q = Number(quoted);
  return Number.isFinite(q) && q > 0 && Math.abs(q - intended) <= tickSize;
}

function statusActive(status: string | undefined): boolean {
  return /^(NEW|WORKING|TRIGGERED|ACTIVE)/i.test(String(status ?? ""));
}

/** Harga entry LIMIT dikuantisasi ke tickSize — tanpa ini Binance menolak -4014
 *  "Price not increased by tick size" (bug 2 tes live 12 Okt: mark mentah
 *  0.1110718 dengan tick 0.0000100 ditolak). Dipakai plannedEntry sebelum postOrder. */
export function entryLimitPrice(mark: number, tickSize: number): number {
  if (!(Number.isFinite(mark) && mark > 0) || !(tickSize > 0)) throw new Error("ENTRY_PRICE_INVALID");
  return Math.round(mark / tickSize) * tickSize;
}

/**
 * 13 Okt 2026 (revisi 2) — Perintah operator: "gw ga mau lagi ya kalo gw dalam
 * posisi short malah nge short di bawah". Tata letak entry LIMIT mengikuti tepi
 * zona yang benar: SHORT -> zoneTop (jual di atas), LONG -> zoneBottom (beli di
 * bawah). Bila zona tidak valid, atau harga SUDAH melewati zona (SHORT: mark
 * sudah jatuh di bawah zoneBottom; LONG: mark sudah naik di atas zoneTop),
 * fallback ke mark (perilaku lama).
 */
export function zoneEntryPrice(input: {
  side: "LONG" | "SHORT";
  mark: number;
  zoneTop?: number | null;
  zoneBottom?: number | null;
  tickSize: number;
}): number {
  const { side, mark, tickSize } = input;
  const fallback = entryLimitPrice(mark, tickSize);
  const top = input.zoneTop;
  const bottom = input.zoneBottom;
  const zoneValid = typeof top === "number" && typeof bottom === "number"
    && Number.isFinite(top) && Number.isFinite(bottom) && top > 0 && bottom > 0 && top >= bottom;
  if (!zoneValid) return fallback;
  if (side === "SHORT") {
    if (mark < bottom) return fallback;          // harga sudah jatuh melewati zona
    return entryLimitPrice(top, tickSize);       // jual di atas
  }
  if (mark > top) return fallback;               // harga sudah naik melewati zona
  return entryLimitPrice(bottom, tickSize);      // beli di bawah
}

/** Verifikasi ulang dengan retry: queryAlgo BISA mengembalikan -2013 "Order does not
 *  exist" (throw BinanceRequestError ATAU badan error) sesaat setelah POST — lag
 *  indeks exchange ~1-2 detik (terbukti di tes live 12 Okt, dibaca ulang setelah
 *  ~1,2 dtk baru muncul). Respons tanpa triggerPrice yang valid = LAG (retry),
 *  BUKAN kegagalan. Echo salah = fatal. Total jendela tunggu ~5 dtk. */
async function verifyAlgo(
  client: BinanceUsdMClient, clientAlgoId: string, triggerPrice: number, tickSize: number,
): Promise<{ ok: boolean; reason?: string }> {
  const backoffMs = [250, 250, 500, 500, 750, 750, 1000, 1000, 1000];
  let lastReason = "QUERY_GAGAL";
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      const q = await client.queryAlgo(clientAlgoId);
      // Bisa berupa badan error (-2013 "Order does not exist") tanpa throw saat
      // algo belum ter-indeks — perlakukan sebagai lag yang bisa dicoba lagi.
      const echoed = Number((q as { triggerPrice?: string | number }).triggerPrice);
      if (!Number.isFinite(echoed) || echoed <= 0) {
        lastReason = `ALGO_BELUM_TERLIHAT_${(q as { code?: number | string }).code ?? ""}`;
      } else {
        if (!triggerEchoed(echoed, triggerPrice, tickSize)) {
          return { ok: false, reason: `TRIGGER_ECHO_MISMATCH_ekspose_${echoed}_vs_${triggerPrice}` };
        }
        if (!statusActive(q.algoStatus)) return { ok: false, reason: `ALGO_NOT_ACTIVE_${q.algoStatus}` };
        return { ok: true };
      }
    } catch (err) {
      lastReason = (err as Error).message;
    }
    if (attempt < backoffMs.length) await new Promise((r) => setTimeout(r, backoffMs[attempt]));
  }
  return { ok: false, reason: `ALGO_VERIFY_GAGAL_${lastReason}` };
}

async function safeCancel(client: BinanceUsdMClient, clientAlgoId: string | undefined): Promise<void> {
  if (!clientAlgoId) return;
  try { await client.cancelAlgo(clientAlgoId); } catch { /* sudah tidak ada / sudah bersih */ }
}

/**
 * Pasang SL DULU lalu TP — keduanya reduceOnly+qty (tanpa posisi), diverifikasi
 * sebelum dikembalikan. ok:false = TIDAK ADA satu pun yang tertinggal dan caller
 * WAJIB tidak mengirim entry.
 */
export async function placePreEntryBracket(input: BracketInput): Promise<BracketResult> {
  const { symbol, side, entryPrice, qty, slPrice, tp1Price, tickSize, refId, client } = input;
  if (!(qty > 0) || !(slPrice > 0) || !(entryPrice > 0) || !(tickSize > 0)) {
    return { ok: false, reason: "BRACKET_INPUT_INVALID" };
  }
  const long = side === "LONG";
  if (long ? !(slPrice < entryPrice) : !(slPrice > entryPrice)) return { ok: false, reason: "BRACKET_SL_WRONG_SIDE" };
  if (tp1Price && tp1Price > 0 && (long ? !(tp1Price > entryPrice) : !(tp1Price < entryPrice))) {
    return { ok: false, reason: "BRACKET_TP_WRONG_SIDE" };
  }
  const ladder = !!(input.tp2Price && input.tp2Price > 0);
  const ids = ladder ? bracketAlgoIdsV2(refId) : { ...bracketAlgoIds(refId), tp2ClientAlgoId: undefined };
  const { slClientAlgoId, tpClientAlgoId } = ids;
  const tp2ClientAlgoId = ids.tp2ClientAlgoId as string;
  const closeSide = long ? "SELL" : "BUY";
  const rr23 = input.swingExitPolicy === "RR23";
  const tp1Qty = ladder ? ladderLegQty(qty, rr23 ? SWING_RR23.tp1Frac : 0.4, input.stepSize) : qty;
  // RR23 has no runner: every remaining lot belongs to TP2/final 3R.
  const tp2Qty = ladder
    ? rr23
      ? Number((qty - tp1Qty).toFixed(12))
      : ladderLegQty(qty, 0.3, input.stepSize)
    : 0;
  const tp2Price = ladder ? input.tp2Price! : 0;
  // Fase < 1 step = fase tidak jalan; degradasi aman: TP1 full qty (single-target).
  const ladderEffective = ladder && tp1Price != null && tp1Qty > 0 && tp2Qty > 0
    && (long ? tp2Price > tp1Price : tp2Price < tp1Price);
  const tp1OrderQty = ladderEffective ? tp1Qty : qty;
  const tp2OrderQty = ladderEffective ? tp2Qty : 0;

  // 1) SL dulu — kalau ini gagal, tidak ada apa-apa sama sekali.
  let slRes: BinanceAlgoResponse;
  try {
    slRes = await client.placeReduceOnlyGuard({
      symbol, side: closeSide, type: "STOP_MARKET",
      triggerPrice: slPrice, quantity: qty, clientAlgoId: slClientAlgoId,
    });
    // Echo dari respons POST juga harus benar sebelum klaim "terpasang".
    if (!triggerEchoed(slRes.triggerPrice, slPrice, tickSize)) {
      await safeCancel(client, slClientAlgoId);
      return { ok: false, reason: `SL_TRIGGER_ECHO_MISMATCH_${slRes.triggerPrice}` };
    }
    const v = await verifyAlgo(client, slClientAlgoId, slPrice, tickSize);
    if (!v.ok) {
      await safeCancel(client, slClientAlgoId);
      return { ok: false, reason: `SL_VERIFY_FAILED_${v.reason}` };
    }
  } catch (err) {
    await safeCancel(client, slClientAlgoId);
    return { ok: false, reason: `SL_PLACE_FAILED_${(err as Error).message}` };
  }

  // 2) TP — gagal = SL ikut dibatalkan (tidak ada proteksi setengah jadi).
  if (tp1Price && tp1Price > 0) {
    try {
      const tpRes = await client.placeReduceOnlyGuard({
        symbol, side: closeSide, type: "TAKE_PROFIT",
        triggerPrice: tp1Price, price: tp1Price, quantity: tp1OrderQty, clientAlgoId: tpClientAlgoId,
      });
      if (!triggerEchoed(tpRes.triggerPrice, tp1Price, tickSize)) {
        await safeCancel(client, tpClientAlgoId);
        await safeCancel(client, slClientAlgoId);
        return { ok: false, reason: `TP_TRIGGER_ECHO_MISMATCH_${tpRes.triggerPrice}` };
      }
      const v = await verifyAlgo(client, tpClientAlgoId, tp1Price, tickSize);
      if (!v.ok) {
        await safeCancel(client, tpClientAlgoId);
        await safeCancel(client, slClientAlgoId);
        return { ok: false, reason: `TP_VERIFY_FAILED_${v.reason}` };
      }
    } catch (err) {
      await safeCancel(client, tpClientAlgoId);
      await safeCancel(client, slClientAlgoId);
      return { ok: false, reason: `TP_PLACE_FAILED_${(err as Error).message}` };
    }
      // Kaki TP2 (RR23: 50% final @3R; legacy: 30%) — gagal = semua dibatalkan.
      if (tp2OrderQty > 0) {
        try {
          const tp2Res = await client.placeReduceOnlyGuard({
            symbol, side: closeSide, type: "TAKE_PROFIT",
            triggerPrice: tp2Price, price: tp2Price, quantity: tp2OrderQty, clientAlgoId: tp2ClientAlgoId,
          });
          if (!triggerEchoed(tp2Res.triggerPrice, tp2Price, tickSize)) {
            await safeCancel(client, tp2ClientAlgoId);
            await safeCancel(client, tpClientAlgoId);
            await safeCancel(client, slClientAlgoId);
            return { ok: false, reason: `TP2_TRIGGER_ECHO_MISMATCH_${tp2Res.triggerPrice}` };
          }
          const v2 = await verifyAlgo(client, tp2ClientAlgoId, tp2Price, tickSize);
          if (!v2.ok) {
            await safeCancel(client, tp2ClientAlgoId);
            await safeCancel(client, tpClientAlgoId);
            await safeCancel(client, slClientAlgoId);
            return { ok: false, reason: `TP2_VERIFY_FAILED_${v2.reason}` };
          }
        } catch (err) {
          await safeCancel(client, tp2ClientAlgoId);
          await safeCancel(client, tpClientAlgoId);
          await safeCancel(client, slClientAlgoId);
          return { ok: false, reason: `TP2_PLACE_FAILED_${(err as Error).message}` };
        }
      return { ok: true, slClientAlgoId, tpClientAlgoId, tp2ClientAlgoId };
    }
    return { ok: true, slClientAlgoId, tpClientAlgoId };
  }
  return { ok: true, slClientAlgoId };
}

/** Batalkan bracket (entry batal / timeout fill). Best-effort; sisa dibersihkan kill switch. */
export async function cancelPreEntryBracket(input: {
  client: BinanceUsdMClient; slClientAlgoId?: string; tpClientAlgoId?: string; tp2ClientAlgoId?: string;
}): Promise<void> {
  await safeCancel(input.client, input.tp2ClientAlgoId);
  await safeCancel(input.client, input.tpClientAlgoId);
  await safeCancel(input.client, input.slClientAlgoId);
}

/** Post-fill: kedua guard masih aktif dengan trigger benar? */
export async function verifyBracketActive(input: {
  client: BinanceUsdMClient; slClientAlgoId?: string; tpClientAlgoId?: string; tp2ClientAlgoId?: string;
  slPrice: number; tp1Price: number | null; tickSize: number; tp2Price?: number | null;
}): Promise<{ ok: boolean; reason?: string }> {
  if (input.slClientAlgoId) {
    const v = await verifyAlgo(input.client, input.slClientAlgoId, input.slPrice, input.tickSize);
    if (!v.ok) return { ok: false, reason: `SL_${v.reason}` };
  }
  if (input.tpClientAlgoId && input.tp1Price && input.tp1Price > 0) {
    const v = await verifyAlgo(input.client, input.tpClientAlgoId, input.tp1Price, input.tickSize);
    if (!v.ok) return { ok: false, reason: `TP_${v.reason}` };
  }
  if (input.tp2ClientAlgoId && input.tp2Price && input.tp2Price > 0) {
    const v = await verifyAlgo(input.client, input.tp2ClientAlgoId, input.tp2Price, input.tickSize);
    if (!v.ok) return { ok: false, reason: `TP2_${v.reason}` };
  }
  return { ok: true };
}

/** Selaraskan bracket ke qty aktual setelah PARTIAL fill: batal + pasang ulang. */
export async function realignBracketQty(input: BracketInput & {
  oldSlClientAlgoId?: string; oldTpClientAlgoId?: string; oldTp2ClientAlgoId?: string;
}): Promise<BracketResult> {
  // Keep the known protection until its replacement has been placed and queried.
  // A placement failure must never remove the remaining filled exposure's SL.
  const proposed = bracketAlgoIdsV2(input.refId);
  const oldIds = [input.oldSlClientAlgoId, input.oldTpClientAlgoId, input.oldTp2ClientAlgoId];
  // Appending a suffix can be lost by the 30-char ref truncation. Never reuse an
  // active guard identity, or the following old-order cancellation could cancel
  // the replacement itself.
  const reusesIdentity = Object.values(proposed).some(id => oldIds.includes(id));
  const replacement = await placePreEntryBracket(reusesIdentity
    ? { ...input, refId: `R${Date.now().toString(36)}_${input.refId}` } : input);
  if (!replacement.ok) return replacement;
  await cancelPreEntryBracket({
    client: input.client, slClientAlgoId: input.oldSlClientAlgoId,
    tpClientAlgoId: input.oldTpClientAlgoId, tp2ClientAlgoId: input.oldTp2ClientAlgoId,
  });
  return replacement;
}
