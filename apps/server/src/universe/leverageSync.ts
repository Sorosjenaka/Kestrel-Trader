// apps/server/src/universe/leverageSync.ts — Wiring sinkron snapshot max leverage
// (FR-16, US-14): sekali saat boot + timer 6 jam, sesuai desain asli T-1.5.
// Modul ini HANYA menjadwalkan pengisian data universe (leverageWatcher); tidak ada
// logika keputusan/eksekusi trading di sini. Gagal sync dicatat dan TIDAK menggagalkan
// boot — gate FR-16 sendiri tetap fail-closed terhadap data basi.
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";
import {
  DEFAULT_DIFF_INTERVAL_MS,
  leverageWatcher,
  type RawLeverageSymbol,
} from "./leverageWatcher.js";

const BASE_URL = "https://fapi.binance.com";

export type LeverageBracketFetcher = (pathWithQuery: string) => Promise<{ data: RawLeverageSymbol[] }>;
export type LeverageSyncFn = (fetcher: LeverageBracketFetcher) => Promise<{ updated: number; unchanged: number }>;

/**
 * Normalisasi payload GET /fapi/v1/leverageBracket.
 * Bentuk asli Binance = JSON array telanjang; bentuk wrapper/proxy = { data: [...] }.
 * Keduanya diterima. Tanpa ini, respons array telanjang menghasilkan 0 simbol
 * terproses SENYAP (updated:0/unchanged:0) — sinkron tidak pernah mengisi data.
 */
export function normalizeLeverageBracketPayload(json: unknown): RawLeverageSymbol[] {
  if (Array.isArray(json)) return json as RawLeverageSymbol[];
  if (json !== null && typeof json === "object") {
    const data = (json as { data?: unknown }).data;
    if (Array.isArray(data)) return data as RawLeverageSymbol[];
  }
  return [];
}

export function makeLeverageBracketFetcher(
  apiKey: string,
  doFetch: typeof fetch = fetch,
): LeverageBracketFetcher {
  return async (pathWithQuery: string) => {
    const res = await doFetch(`${BASE_URL}${pathWithQuery}`, {
      headers: { "X-MBX-APIKEY": apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`leverageBracket HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return { data: normalizeLeverageBracketPayload(await res.json()) };
  };
}

export interface LeverageSyncDeps {
  sync: LeverageSyncFn;
  fetcher: LeverageBracketFetcher;
  onEvent?: (payload: Record<string, unknown>, msg: string) => void;
}

export interface LeverageSyncOutcome {
  ok: boolean;
  updated?: number;
  unchanged?: number;
  error?: string;
}

/** Satu siklus sinkron. Tidak pernah melempar — kegagalan kembali sebagai hasil. */
export async function runLeverageSync(deps: LeverageSyncDeps): Promise<LeverageSyncOutcome> {
  try {
    const r = await deps.sync(deps.fetcher);
    deps.onEvent?.({ updated: r.updated, unchanged: r.unchanged }, "LEVERAGE_SYNC_OK");
    return { ok: true, updated: r.updated, unchanged: r.unchanged };
  } catch (e) {
    const msg = (e as Error).message;
    deps.onEvent?.({ err: msg }, "LEVERAGE_SYNC_FAIL");
    return { ok: false, error: msg };
  }
}

/** Nyalakan sinkron: 1x saat boot, lalu tiap interval (default 6 jam, US-14). */
export function startLeverageSync(intervalMs = DEFAULT_DIFF_INTERVAL_MS): void {
  const fetcher = makeLeverageBracketFetcher(env.BINANCE_API_KEY ?? "");
  const run = (): Promise<LeverageSyncOutcome> =>
    runLeverageSync({
      sync: (f) => leverageWatcher.syncSigned(f),
      fetcher,
      onEvent: (payload, msg) => logger.info(payload, msg),
    });
  void run();
  leverageWatcher.start(intervalMs, () => run());
}
