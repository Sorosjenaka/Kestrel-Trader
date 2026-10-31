// apps/server/src/marketdata/eventTime.ts
// 25 Okt 2026 — Normalisasi waktu event lintas bursa.
//
// MASALAH YANG DIPERBAIKI (terbukti lewat probe live 25 Okt 2026):
//   Setiap bursa memakai satuan waktu BERBEDA di field timestamp, dan
//   tidak ada satu pun yang menyebut satuan itu di dokumentasi payload:
//
//     Binance (perp/spot) : ms epoch (number)          OK
//     Hyperliquid         : ms epoch (number)          OK
//     Bybit v5            : ms epoch (string)          OK
//     OKX v5              : ms epoch (string)          OK
//     Gate v4             : ms epoch (string, desimal) OK
//     Bitget v2           : ms epoch (string)          OK
//     KuCoin /market/match: NANOSECOND (string)        BROKEN
//     Coinbase matches    : ISO-8601 string            perlu Date.parse
//
//   Parser lama melakukan `Number(r.time)` tanpa mendeteksi satuan. Untuk KuCoin
//   hasilnya 1.792.902.798.229.000.000 (ns) yang SEHARUSNYA 1.792.902.798.229
//   (ms) — selisih 1.000.000x. Akibatnya:
//
//     1. priceHistory.push() menerima t=1.79e18 ms. `lastSampleSec` jadi
//        1.79e15, JAUH di masa depan. Setiap transaksi nyata sesudahnya
//        punya sec < lastSampleSec -> DIABAIKAN. Akibatnya priceHistory
//        terkunci: hanya berisi satu sampel dari detik itu.
//     2. firstSince(fromMs) mengembalikan sampel terkunci itu untuk SEMUA
//        window -> priceChangePct 15M identik dengan 1H.
//     3. TimeRing (secBuy/secSell/secTrades) menerima sec=1.79e15. Slot
//        modulo 3600 tertimpa acak, dan karena `t >= fromSec` selalu true
//        untuk t sebesar itu, notional + jumlah trade KuCoin dihitung
//        di SETIAP window (1M, 5M, 15M, 1H) sekaligus — data.window
//        mereka tidak pernah bisa keluar.
//     4. Seri CVD per venue memuat titik bertimestamp 1.79e15 -> sumbu X
//        chart meledak dan seluruh data nyata tergeser ke tepi.
//
//   Perbaikan: SATU fungsi normalisasi dipakai semua parser. Deteksi satuan
//   berdasarkan besaran angka (abu-abu tapi deterministik), plus pagar
//   sanity terhadap skew masa depan.
//
// ATURAN: kalau timestamp tidak bisa dinormalisasi ke rentang yang masuk
// akal, return null — pemanggil memakai Date.now() dan MENCATAT anomali.
// Tidak ada angka yang dikarang.

/** Toleransi skew masa depan antar bursa (detik). */
export const MAX_FUTURE_SKEW_MS = 90_000;
/** Toleransi skew ke belakang (detik) — transaksi lebih lama dari ini diabaikan. */
export const MAX_PAST_SKEW_MS = 6 * 3600_000;

/**
 * Deteksi satuan dari besaran nilai epoch.
 *  >= 1e17  -> nanosecond
 *  >= 1e14  -> microsecond
 *  >= 1e11  -> millisecond
 *  >= 1e8   -> second
 *  < 1e8    -> bukan epoch -> null
 */
export function detectEpochUnit(value: number): "ns" | "us" | "ms" | "s" | null {
  const abs = Math.abs(value);
  if (abs >= 1e17) return "ns";
  if (abs >= 1e14) return "us";
  if (abs >= 1e11) return "ms";
  if (abs >= 1e8) return "s";
  return null;
}

/** Ubah nilai epoch ber-satuan menjadi epoch-ms. */
function toEpochMs(value: number): number | null {
  switch (detectEpochUnit(value)) {
    case "ns": return value / 1e6;
    case "us": return value / 1e3;
    case "ms": return value;
    case "s": return value * 1e3;
    default: return null;
  }
}

export interface NormalizedTime {
  /** epoch-ms hasil normalisasi, atau null bila tidak bisa dipakai. */
  t: number | null;
  /** true bila satuan terdeteksi otomatis (bukan ms default). */
  unitAdjusted: boolean;
  /** true bila hasil berada di luar pagar sanity. */
  outOfRange: boolean;
  /** alasan singkat untuk log (tanpa secret). */
  reason?: string;
}

/**
 * Normalisasi satu field timestamp mentah dari bursa.
 *
 * @param raw   nilai mentah (number | string | null | undefined)
 * @param nowMs epoch-ms "sekarang" untuk pagar sanity (default Date.now())
 */
export function normalizeEventTime(raw: unknown, nowMs: number = Date.now()): NormalizedTime {
  if (raw == null) return { t: null, unitAdjusted: false, outOfRange: false, reason: "MISSING" };

  let numeric = NaN;
  if (typeof raw === "number") {
    numeric = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { t: null, unitAdjusted: false, outOfRange: false, reason: "EMPTY" };
    // Angka dulu (KuCoin ns, OKX/Bitget/Gate ms, Binance ms).
    numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      // Baru ISO-8601 (Coinbase).
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) {
        return checkRange(parsed, nowMs, false);
      }
      return { t: null, unitAdjusted: false, outOfRange: false, reason: "UNPARSEABLE" };
    }
  } else {
    return { t: null, unitAdjusted: false, outOfRange: false, reason: "UNSUPPORTED_TYPE" };
  }

  if (!Number.isFinite(numeric)) {
    return { t: null, unitAdjusted: false, outOfRange: false, reason: "NOT_FINITE" };
  }

  const unit = detectEpochUnit(numeric);
  if (!unit) {
    return { t: null, unitAdjusted: false, outOfRange: false, reason: "NOT_EPOCH" };
  }
  const ms = toEpochMs(numeric);
  if (ms == null || !Number.isFinite(ms)) {
    return { t: null, unitAdjusted: false, outOfRange: false, reason: "NOT_FINITE" };
  }
  return checkRange(ms, nowMs, unit !== "ms");
}

function checkRange(ms: number, nowMs: number, unitAdjusted: boolean): NormalizedTime {
  if (ms > nowMs + MAX_FUTURE_SKEW_MS) {
    return { t: null, unitAdjusted, outOfRange: true, reason: "FUTURE" };
  }
  if (ms < nowMs - MAX_PAST_SKEW_MS) {
    return { t: null, unitAdjusted, outOfRange: true, reason: "TOO_OLD" };
  }
  return { t: ms, unitAdjusted, outOfRange: false };
}
