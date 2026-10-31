// apps/server/src/exec/inFlightCache.ts
// 30 Okt 2026 — fix /api/live/dashboard & /api/live/mesh hang.
//
// AKAR MASALAH: getMirrorCached() (liveDashboard.ts) menyimpan promise di
// `mirrorInFlight` lalu meresetnya di `.finally()`. `.finally()` hanya jalan
// saat promise SETTLE. Ketika buildLiveMirrorReport() pernah menggantung
// (tidak pernah settle — mis. Prisma/connection pool macet tanpa timeout),
// `.finally()` tidak pernah jalan => `mirrorInFlight` teracuni permanen => baris
// `if (mirrorInFlight) return mirrorInFlight;` mengembalikan promise yang
// tersangkut itu ke SEMUA request berikutnya, selamanya. Itu sebabnya
// /api/live/mirror (panggil buildLiveMirrorReport langsung) tetap hidup, tapi
// /api/live/dashboard & /api/live/mesh (lewat cache) menggantung.
//
// FIX: bungkus fetch dengan timeout sehingga promise SELALU settle (resolve
// atau reject). Karena selalu settle, `.finally()` selalu jalan => slot
// in-flight selalu dibebaskan => sistem self-healing (request berikutnya coba
// ulang dengan koneksi segar, bukan terus mengembalikan promise yang buntu).

/** Balut promise dengan timeout keras. Dijamin settle: resolve bila `p` selesai
 *  lebih dulu, reject bila melewati `ms`. Timer dibersihkan agar tidak bocor. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: timeout ${ms}ms — promise tidak pernah settle`));
    }, ms);
    // Promise.resolve() membungkus nilai/thenable agar aman walau p bukan Promise.
    Promise.resolve(p).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}

export interface InFlightCacheOptions {
  /** Umur cache hasil sukses (ms). */
  ttlMs: number;
  /** Timeout keras per fetch (ms) — menjamin promise selalu settle. */
  timeoutMs: number;
  /** Label untuk pesan error. */
  label?: string;
}

/**
 * Cache ringan dengan in-flight sharing + TTL + timeout keras.
 *
 * Perilaku:
 *  - Cache masih segar (TTL) -> kembalikan nilai cache, tanpa fetch.
 *  - Ada fetch sedang berjalan -> ikut promise yang sama (in-flight sharing).
 *  - Selesai (sukses) -> simpan ke cache + bebaskan slot in-flight.
 *  - Selesai (gagal/timeout) -> JANGAN simpan ke cache + bebaskan slot
 *    in-flight, sehingga request berikutnya mencoba ulang dengan fetch segar.
 *
 * Kunci perbaikan: fetch dibungkus withTimeout sehingga promise selalu settle,
 * maka reset slot in-flight (`.finally`) dijamin jalan — tidak ada lagi promise
 * yang menggantung selamanya dan mengacuni seluruh request sesudahnya.
 */
export function createInFlightCache<T>(
  fetchFn: () => Promise<T>,
  opts: InFlightCacheOptions,
): () => Promise<T> {
  let cached: { at: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;
  const label = opts.label ?? "inFlightCache";

  return function get(): Promise<T> {
    const now = Date.now();
    if (cached && now - cached.at < opts.ttlMs) {
      return Promise.resolve(cached.value);
    }
    if (inFlight) return inFlight;
    inFlight = withTimeout(fetchFn(), opts.timeoutMs, label)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        // Selalu jalan karena withTimeout menjamin settle. Bebaskan slot walau
        // fetch gagal/timeout supaya tidak teracuni permanen.
        inFlight = null;
      });
    return inFlight;
  };
}
