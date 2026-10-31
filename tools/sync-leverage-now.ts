// tools/sync-leverage-now.ts — Sinkron snapshot max leverage SEKALI JALAN (operasi data).
// Latar: 4 Okt 2026 — seluruh Symbol.maxLeverageUpdatedAt basi serentak (27 Sep 07:37 UTC)
// sehingga gate FR-16 (>7 hari => STALE_LEVERAGE_SNAPSHOT) menolak SEMUA entry final risk plan.
// Tool ini memakai modul resmi leverageWatcher.syncSigned (endpoint signed
// /fapi/v1/leverageBracket) — TIDAK mengubah gate, parameter, atau kode trading path.
// Jalankan: npx tsx tools/sync-leverage-now.ts
import { db } from "../apps/server/src/core/db.js";
import { env } from "../apps/server/src/core/env.js";
import { leverageWatcher, type RawLeverageSymbol } from "../apps/server/src/universe/leverageWatcher.js";
import { normalizeLeverageBracketPayload } from "../apps/server/src/universe/leverageSync.js";

const BASE_URL = "https://fapi.binance.com";

async function fetchLeverageBracket(pathWithQuery: string): Promise<{ data: RawLeverageSymbol[] }> {
  const res = await fetch(`${BASE_URL}${pathWithQuery}`, {
    headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY ?? "" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`leverageBracket HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return { data: normalizeLeverageBracketPayload(await res.json()) };
}

async function freshness() {
  const now = Date.now();
  const all = await db.symbol.findMany({
    select: { symbol: true, maxLeverageUpdatedAt: true },
    where: { isBlacklisted: false },
  });
  let ok = 0, stale = 0, missing = 0;
  for (const s of all) {
    const t = s.maxLeverageUpdatedAt?.getTime();
    if (t === undefined || t === null) missing += 1;
    else if (now - t > 7 * 24 * 60 * 60 * 1000) stale += 1;
    else ok += 1;
  }
  return { tradeable: all.length, fresh: ok, stale, missing };
}

async function main() {
  // Mode seed manual (persetujuan operator 4 Okt 2026, pola seed 27 Sep):
  // npx tsx tools/sync-leverage-now.ts --seed-25
  // Dipakai hanya saat endpoint signed tidak terjangkau (key/IP) — nilai seed
  // = konstanta 25x (TARGET_LEVERAGE), BUKAN hasil pengamatan Binance.
  if (process.argv.includes("--seed-25")) {
    console.log("DB:", env.DATABASE_URL);
    console.log("SEBELUM:", await freshness());
    const rows = await db.symbol.findMany({ select: { symbol: true } });
    const map: Record<string, number> = {};
    for (const r of rows) map[r.symbol] = 25;
    const res = await leverageWatcher.seedManual(map);
    console.log("SEED 25x:", res, "| simbol:", Object.keys(map).length);
    console.log("SESUDAH:", await freshness());
    await db.$disconnect();
    process.exit(0);
  }

  if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
    throw new Error("BATAL: BINANCE_API_KEY / BINANCE_API_SECRET tidak tersedia di env");
  }
  console.log("DB:", env.DATABASE_URL);
  console.log("SEBELUM:", await freshness());

  const res = await leverageWatcher.syncSigned(fetchLeverageBracket);
  console.log("SYNC:", { updated: res.updated, unchanged: res.unchanged, diffs: res.diffs.length });

  console.log("SESUDAH:", await freshness());
  await db.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("GAGAL:", (e as Error).message);
  process.exit(1);
});
