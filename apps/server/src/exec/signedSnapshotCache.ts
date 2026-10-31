// apps/server/src/exec/signedSnapshotCache.ts — A4 (30 Okt 2026).
//
// Latar: badai 429/418 per jam di IP Binance shared (audit
// docs/audit-badai-429-2026-10-30.md). Salah satu penyumbang adalah panggilan
// signed REDUNDAN: snapshot posisi/order yang sama diambil terpisah oleh
// watcher (3 dtk), mirror dashboard, dan monitor proteksi.
//
// Modul ini = cache snapshot READ-ONLY pendek + in-flight sharing + timeout
// keras (pola inFlightCache.ts, fix mirrorInFlight f918498):
//   - TTL default 3 dtk (<= cadence watcher) -> duplikasi antar konsumen
//     dalam jendela itu berbagi SATU panggilan.
//   - Gagal/timeout TIDAK disimpan -> panggilan berikutnya segar (self-healing).
//   - ttlMs <= 0 = cache MATI, panggil langsung (dipakai test / jalur segar).
//
// HANYA untuk jalur DISPLAY/ALARM (mirror, monitor) dan polling berkala
// watcher. Jalur yang memicu AKSI tetap memanggil langsung tanpa cache:
// ladder queryAlgo / BE move / bracket cleanup / emergency flatten / reconciler
// boot / bukti fill exitAccounting — kesegaran di sana = logika eksekusi.
import { withTimeout } from "./inFlightCache.js";

export interface SnapshotCacheOptions {
  ttlMs?: number;
  timeoutMs?: number;
}

const DEFAULT_TTL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 8_000;

interface Entry {
  at: number;
  value?: unknown;
  inflight?: Promise<unknown>;
}

// Per-klien (WeakMap) supaya fake client di test tidak berbagi cache dengan
// klien lain dan tidak ada leak antar test.
const stores = new WeakMap<object, Map<string, Entry>>();

function cached<T>(client: object, key: string, fetch: () => Promise<T>, opts?: SnapshotCacheOptions): Promise<T> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  if (ttlMs <= 0) return fetch(); // cache dimatikan: panggil langsung
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let store = stores.get(client);
  if (!store) {
    store = new Map<string, Entry>();
    stores.set(client, store);
  }
  const now = Date.now();
  const entry = store.get(key);
  if (entry && entry.value !== undefined && now - entry.at < ttlMs) return Promise.resolve(entry.value as T);
  if (entry?.inflight) return entry.inflight as Promise<T>; // berbagi panggilan berjalan
  const p = withTimeout(fetch(), timeoutMs, `signedSnapshot:${key}`)
    .then((value) => {
      store!.set(key, { at: Date.now(), value }); // hanya sukses yang di-cache
      return value;
    })
    .finally(() => {
      const cur = store!.get(key);
      if (cur?.inflight) store!.set(key, { at: cur.at, value: cur.value });
    });
  store.set(key, { at: entry?.at ?? 0, value: entry?.value, inflight: p });
  return p;
}

type PositionRiskClient<T> = { getPositionRiskAll(): Promise<T[]> };
type AlgoListClient = { getOpenAlgoOrders(): Promise<unknown[]> };
type OpenOrdersClient = { getOpenOrders(symbol?: string): Promise<unknown[]> };

/** Snapshot posisi exchange (GET /fapi/v2/positionRisk) — display/alarm/watcher. */
export function cachedPositionRiskAll<T>(client: PositionRiskClient<T>, opts?: SnapshotCacheOptions): Promise<T[]> {
  return cached<T[]>(client, "positionRisk", () => client.getPositionRiskAll(), opts);
}

/** Snapshot algo order terbuka (GET /fapi/v1/openAlgoOrders) — display/alarm. */
export function cachedOpenAlgoOrders(client: AlgoListClient, opts?: SnapshotCacheOptions): Promise<unknown[]> {
  return cached<unknown[]>(client, "openAlgoOrders", () => client.getOpenAlgoOrders(), opts);
}

/** Snapshot open orders (GET /fapi/v1/openOrders) — display/alarm. */
export function cachedOpenOrders(client: OpenOrdersClient, opts?: SnapshotCacheOptions): Promise<unknown[]> {
  return cached<unknown[]>(client, "openOrders", () => client.getOpenOrders(), opts);
}
