// apps/server/src/exec/bracketCleanup.ts — 13 Okt 2026
// Perbaikan insiden orphan SL/TP (12-13 Okt): Position 3028 (IOUSDT) & 3029
// (RSRUSDT) ditutup SL native, tetapi sibling TP (algo TPA_) tetap NEW di
// exchange. Root cause: TIDAK ADA jalur dari "posisi flat" -> "cancel proteksi
// sibling" (cancelAlgo hanya ada di jalur pre-entry: verify gagal / entry tidak
// terisi / realign partial / kill switch).
//
// KONTRAK DESAIN (perintah operator 13 Okt):
//   - Perintah bersih WAJIB didahului BUKTI FLAT dari positionRisk exchange
//     (bukan status DB). amt != 0 = jangan sentuh apa pun (proteksi masih perlu).
//   - Kepemilikan: hanya algo SLA_/TPA_ (preEntryBracket.bracketAlgoIds) yang
//     basis-nya cocok dengan entry refId posisi ini (recoverable dari OrderExec).
//     Order tanpa awalan SLA_/TPA_ (manual operator) TIDAK PERNAH disentuh.
//     Kandidat yang tidak bisa diatribusikan = AMBIGUOUS -> TIDAK dibatalkan,
//     dilaporkan (fail-closed, degraded-safe).
//   - Cancel TIDAK dianggap berhasil dari respons saja: selalu verifikasi ulang
//     via queryAlgo (timeout transport BISA berarti sudah terkirim). Retry
//     BOUNDED; hasil tak pasti = UNCONFIRMED (dilaporkan, tidak diulang tanpa batas).
//   - Idempotent: dipanggil dua kali / oleh dua aktor (server & watchdog) hasil
//     akhirnya sama dan aman (cancel kedua = -2011/not-found -> terkonfirmasi
//     lewat query).
//   - TRIGGERED = trigger sudah menyala (order penutup sedang jalan): tetap
//     dicoba cancel, keputusan akhir TETAP dari status exchange.
import type { BinanceAlgoResponse } from "./binanceUsdMClient.js";

export interface CleanupExchange {
  /** positionRisk per simbol (one-way mode: 1 baris). */
  getPositionRisk(symbol: string): Promise<Array<{ symbol?: string; positionAmt?: string | number }>>;
  queryAlgo(clientAlgoId: string): Promise<BinanceAlgoResponse>;
  cancelAlgo(clientAlgoId: string): Promise<BinanceAlgoResponse>;
  /** Recovery listing (opsional): daftar algo NEW per akun. */
  getOpenAlgoOrders?(): Promise<unknown[]>;
}

export interface CleanupRepo {
  /** Baris ENTRY posisi (reduceOnly=false, terlama) — sumber tradeBasis. */
  findEntryByPositionId(positionId: number): Promise<{ clientOrderId: string; reduceOnly: boolean } | null>;
}

export interface CleanupOrderResult {
  clientAlgoId: string;
  attempted: boolean;
  finalStatus: string;        // CANCELED / FINISHED / EXPIRED / REJECTED / NOT_FOUND / <status aktif>
  confirmed: boolean;         // true = status terminal terverifikasi DARI exchange
  note?: string;
}

export interface CleanupResult {
  flatVerified: boolean;      // bukti amt=0 dari exchange
  cancelled: CleanupOrderResult[];
  skipped: CleanupOrderResult[];   // milik posisi lain / in-flight / ambigu TIDAK dibatalkan
  reason?: string;            // alasan bila tidak ada aksi (POSITION_STILL_OPEN dll.)
}

const ACTIVE_ALGO = new Set(["NEW", "WORKING", "LIVE", "ACTIVE"]);
const TERMINAL_ALGO = new Set(["CANCELED", "FINISHED", "EXPIRED", "REJECTED"]);
const CANCEL_RETRIES = 2;
const RETRY_DELAY_MS = 750;

export function protectiveBase(refId: string): string {
  return refId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
}

export function isProtectiveAlgoId(clientAlgoId: string): boolean {
  // 29 Okt 2026 (BUG FIX): TPB_ (TP2/ladder) juga order pelindung bot —
  // sebelumnya regex hanya SLA_/TPA_ sehingga TP2 tidak terlindungi saat
  // cleanup dan bisa hilang tanpa jejak (insiden SKYUSDT TP2 orphan-cancel).
  return /^(SLA|TPA|TPB)_/.test(clientAlgoId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errCode(err: unknown): number | null {
  const c = (err as { code?: unknown; binanceCode?: unknown })?.code;
  return typeof c === "number" ? c : null;
}

/** Bukti flat dari exchange (bukan DB). Returns null = state posisi TIDAK diketahui. */
export async function verifyFlat(ex: CleanupExchange, symbol: string): Promise<boolean | null> {
  let rows: Array<{ symbol?: string; positionAmt?: string | number }>;
  try {
    rows = await ex.getPositionRisk(symbol);
  } catch {
    return null;
  }
  const mine = rows.filter((r) => String(r.symbol ?? "").toUpperCase() === symbol.toUpperCase());
  if (mine.length !== 1) return null;           // 0 baris / >1 baris = tak diketahui (fail-closed)
  const amt = Number(mine[0].positionAmt);
  if (!Number.isFinite(amt)) return null;
  return amt === 0;
}

function statusOf(res: BinanceAlgoResponse | { algoStatus?: string }): string {
  return String(res.algoStatus ?? "").toUpperCase();
}

/** Cancel satu algo + VERIFIKASI status akhir via query. Tidak pernah menganggap
 *  "request OK" sebagai bukti. Retry bounded hanya untuk hasil tak pasti. */
export async function cancelWithConfirmation(
  ex: CleanupExchange, clientAlgoId: string,
): Promise<CleanupOrderResult> {
  const confirmed = (finalStatus: string, note?: string): CleanupOrderResult =>
    ({ clientAlgoId, attempted: true, finalStatus, confirmed: true, note });
  const unconfirmed = (finalStatus: string, note: string): CleanupOrderResult =>
    ({ clientAlgoId, attempted: true, finalStatus, confirmed: false, note });

  for (let attempt = 0; attempt <= CANCEL_RETRIES; attempt++) {
    try {
      await ex.cancelAlgo(clientAlgoId);
    } catch (err) {
      // -2011/-2013 = exchange menyatakan order tidak ada (definitif).
      const code = errCode(err);
      if (code === -2011 || code === -2013) return confirmed("NOT_FOUND", "order_absen_di_exchange");
      // Timeout/tak pasti: jangan klaim apa pun, keputusan lewat query.
    }
    // Verifikasi selalu — respons cancel BUKAN bukti.
    let q: BinanceAlgoResponse | null = null;
    try {
      q = await ex.queryAlgo(clientAlgoId);
      const st = statusOf(q);
      if (TERMINAL_ALGO.has(st)) return confirmed(st);
      if (ACTIVE_ALGO.has(st)) {
        if (attempt < CANCEL_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
        return unconfirmed(st, "CANCEL_TIDAK_KONFIRMASI_masih_aktif");
      }
      if (attempt < CANCEL_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return unconfirmed(st || "UNKNOWN", "STATUS_TAK_DIKENAL");
    } catch (err) {
      const code = errCode(err);
      if (code === -2013 || code === -2011) return confirmed("NOT_FOUND", "order_absen_di_exchange");
      if (attempt < CANCEL_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
      return unconfirmed("QUERY_UNKNOWN", `query_gagal_${(err as Error)?.message ?? "?"}`);
    }
  }
  return unconfirmed("UNKNOWN", "RETRY_HABIS");
}

/** Kumpulkan proteksi bot milik SATU trade (basis refId) pada satu simbol.
 *  - Sumber #1 (DB-first): basis dari OrderExec entry posisi -> kandidat
 *    SLA_/TPA_<basis> -> queryAlgo per kandidat.
 *  - Sumber #2 (recovery listing): getOpenAlgoOrders -> algo SLA_/TPA_ pada simbol
 *    ini yang basisnya cocok ATAU milik posisi lain yang masih OPEN (dilewati).
 *  - Algo SLA_/TPA_ yang basisnya TIDAK dikenal = AMBIGUOUS -> dilaporkan, tidak
 *    dibatalkan. Order non-SLA_/TPA_ = bukan milik bot -> tidak dilaporkan. */
export async function collectOwnedProtectiveOrders(input: {
  ex: CleanupExchange; repo: CleanupRepo; symbol: string; positionId: number;
  openPositionSymbols?: Set<string>;
}): Promise<{ owned: string[]; ambiguous: string[] }> {
  const { ex, repo, symbol, positionId } = input;
  const owned = new Set<string>();
  const ambiguous = new Set<string>();

  const entry = await repo.findEntryByPositionId(positionId).catch(() => null);
  const basis = entry && !entry.reduceOnly ? protectiveBase(entry.clientOrderId) : null;
  if (basis) {
    for (const prefix of ["SLA_", "TPA_", "TPB_"]) {
      const cid = prefix + basis;
      try {
        const q = await ex.queryAlgo(cid);
        const st = statusOf(q);
        if (ACTIVE_ALGO.has(st)) owned.add(cid);
      } catch (err) {
        const code = errCode(err);
        if (code !== -2013 && code !== -2011) {
          // Query gagal (bukan "absen"): jangan buktikan apa pun; listing
          // recovery di bawah yang bisa menangkap bila tersedia.
        }
      }
    }
  }

  if (typeof ex.getOpenAlgoOrders === "function") {
    let listed: unknown[] = [];
    try {
      listed = await ex.getOpenAlgoOrders();
    } catch { /* listing gagal: DB-first di atas tetap berlaku */ }
    for (const raw of listed) {
      const o = raw as { symbol?: string; clientAlgoId?: string; clientOrderId?: string };
      if (String(o.symbol ?? "").toUpperCase() !== symbol.toUpperCase()) continue;
      const cid = String(o.clientAlgoId ?? o.clientOrderId ?? "");
      if (!isProtectiveAlgoId(cid)) continue;
      if (owned.has(cid)) continue;
      const remainder = cid.slice(4);
      if (basis && remainder === basis) { owned.add(cid); continue; }
      // Basis lain: milik posisi OPEN lain (simbol sama, one-way = posisi lain
      // di simbol ini mustahil, tapi guard tetap) -> milik asing, JANGAN cancel.
      if (input.openPositionSymbols && input.openPositionSymbols.size > 0) {
        // Basis entry posisi OPEN tidak tersedia di sini tanpa query DB tambahan;
        // perlakukan sebagai ambigu (fail-closed), bukan milik pasti.
      }
      ambiguous.add(cid);
    }
  }
  return { owned: [...owned], ambiguous: [...ambiguous] };
}

/** Titik masuk idempotent: buktikan flat -> kenal milik -> cancel + konfirmasi.
 *  Dipanggil server (finalizeClosedPosition) & aman dipanggil berulang. */
export async function cleanupProtectiveOrders(input: {
  ex: CleanupExchange; repo: CleanupRepo; symbol: string; positionId: number;
}): Promise<CleanupResult> {
  const { ex, repo, symbol, positionId } = input;
  const flat = await verifyFlat(ex, symbol);
  if (flat === null) {
    return { flatVerified: false, cancelled: [], skipped: [], reason: "POSITION_STATE_UNKNOWN" };
  }
  if (!flat) {
    return { flatVerified: false, cancelled: [], skipped: [], reason: "POSITION_STILL_OPEN" };
  }
  const { owned, ambiguous } = await collectOwnedProtectiveOrders({
    ex, repo, symbol, positionId,
  });
  const cancelled: CleanupOrderResult[] = [];
  for (const cid of owned) {
    // Re-verify flat SEBELUM setiap cancel (meminimalkan jendela race: posisi
    // tidak boleh terbuka kembali saat proteksinya dibatalkan). Bukan bukti
    // flat / terbuka lagi = ABORT sisa cancel (fail-closed).
    const stillFlat = await verifyFlat(ex, symbol);
    if (stillFlat !== true) {
      return {
        flatVerified: true, cancelled, skipped: ambiguous.map((cid2) => ({
          clientAlgoId: cid2, attempted: false, finalStatus: "ACTIVE_LAIN", confirmed: false,
          note: "AMBIGUOUS_atribusi_tidak_dapat_dibuktikan",
        })),
        reason: stillFlat === false ? "POSITION_REOPENED" : "POSITION_STATE_UNKNOWN_TENGAH_JALAN",
      };
    }
    cancelled.push(await cancelWithConfirmation(ex, cid));
  }
  const skipped: CleanupOrderResult[] = ambiguous.map((cid) => ({
    clientAlgoId: cid, attempted: false, finalStatus: "ACTIVE_LAIN", confirmed: false,
    note: "AMBIGUOUS_atribusi_tidak_dapat_dibuktikan",
  }));
  return { flatVerified: true, cancelled, skipped };
}
