// apps/server/src/api/routes/microstructureCache.ts
// 24 Okt 2026 — cache snapshot mikrostruktur yang dipakai bersama.
//
// Latar belakang: endpoint mikrostruktur (orderflow, tier-flow, volume
// profile, large trades, liq map) dipanggil dari frontend. Kalau tiap klien
// SSE menghitung sendiri, N tab browser = N hitung per 1.5 detik, dan
// hitungnya berat. Cache TTL pendek ini membuat satu perhitungan dipakai
// bersama oleh semua klien yang masih berada di dalam jendela.
//
// TTL sengaja pendek (default 1 detik) supaya data tetap "live" — tidak ada
// data basi yang lebih tua dari ~1 detik + interval push.

interface Entry<T> {
  at: number;
  value: T;
}

const store = new Map<string, Entry<unknown>>();
const inflightMap = new Map<string, Promise<unknown>>();

// 25 Okt 2026 (FASE 5, scan sistem): sebelumnya store TIDAK PERNAH menghapus
// entri — key dikontrol klien (simbol apa pun yang pernah dipakai SSE) dan
// tiap entri berisi snapshot besar -> memori tumbuh tanpa batas selama proses
// hidup. Sekarang: (a) sweep TTL keras MAX_AGE_MS (jauh di atas TTL pemakaian
// 1-2 dtk, jadi tidak ada data hidup yang terhapus), (b) batas jumlah entri
// dengan buang yang paling tua. Ini cache EFEKTER — bukan history; history
// tidak tersimpan di sini sehingga tidak ada riwayat yang hilang.
const MAX_AGE_MS = 60_000;
const MAX_ENTRIES = 200;

function sweep(now: number): void {
  for (const [k, e] of store) {
    if (now - e.at > MAX_AGE_MS) store.delete(k);
  }
  // Batas ukuran: Map berurutan sisip — buang yang paling lama.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Ambil nilai dari cache; kalau belum ada / sudah basi, hitung ulang via
 * `compute` lalu simpan.
 *
 * `compute` boleh async. Bila beberapa klien meminta key yang sama dalam
 * bersamaan, hanya SATU perhitungan yang jalan — yang lain menunggu hasil
 * yang sama (request coalescing). Tanpa ini, 3 tab browser yang terbuka
 * bersamaan = 3 hitung identik per tick.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  compute: () => T | Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < ttlMs) return hit.value;

  // Coalescing: kalau ada perhitungan yang sedang berjalan untuk key ini,
  // tunggu yang sama daripada menghitung ulang.
  const inflight = inflightMap.get(key) as Promise<T> | undefined;
  if (inflight) return inflight;

  const p = (async () => {
    // 26 Okt 2026 (TAHAP 3A): kegagalan compute TIDAK menimpa entri valid di
    // cache dan TIDAK memperbarui timestamp-nya. Dengan demikian pembaca
    // berikutnya masih melihat snapshot valid terakhir (dengan TTL yang sudah
    // lewat -> dicoba hitung ulang), bukan hasil error yang dianggap segar.
    const value = await compute();
    store.set(key, { at: Date.now(), value });
    sweep(Date.now());
    return value;
  })();

  inflightMap.set(key, p);
  try {
    return await p;
  } finally {
    inflightMap.delete(key);
  }
}

/** Bersihkan cache (dipakai test). */
export function clearMicrostructureCache(): void {
  store.clear();
  inflightMap.clear();
}

/** Jumlah entri cache (dipakai test/diagnostik). */
export function microstructureCacheSize(): number {
  return store.size;
}
