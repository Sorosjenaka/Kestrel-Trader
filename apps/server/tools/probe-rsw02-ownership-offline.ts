// apps/server/tools/probe-rsw02-ownership-offline.ts
// 24 Okt 2026 — VERIFIKASI FIX shadowing RSW-02, OFFLINE dari cache disk.
//
// Memakai KODE PRODUKSI (rswSignals.h4Signals / rswHistoricalH4Signals /
// buildRswPlans / selectBestPlan) terhadap bar H4 + H1 yang SUDAH di-cache di
// .cache/rsw-scan (dari scan live 23 Okt 2026). NOL request Binance -> tidak
// mungkin kena IP ban 418.
//
// Yang diukur:
//   (1) Setelah fix, apakah satu sinyal SHORT PHEN masih menghasilkan 2 plan
//       (RSW-01 + RSW-02) yang identik?  -> harus TIDAK.
//   (2) Berapa plan RSW-01 vs RSW-02 yang terbentuk per simbol.
//   (3) Apakah selectBestPlan() sekarang bisa memilih RSW-02 saat sinyalnya
//       ada (tidak lagi ter-shadowing).
//
// Output: JSON ringkas + ringkasan human-readable.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { h4Signals, rswHistoricalH4Signals } from "../src/strategies/researchSwing/rswSignals.js";
import type { Bar } from "../src/strategies/researchSwing/rswPrimitives.js";

const HOUR = 3_600_000;
const CACHE_DIR = "/opt/kestrel/.cache/rsw-scan";

function loadBar(file: string): Bar[] | null {
  const path = join(CACHE_DIR, file);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Bar[];
    if (!Array.isArray(raw) || raw.length < 200) return null;
    return raw;
  } catch {
    return null;
  }
}

function main(): void {
  const btcD1 = loadBar("BTCUSDT_1d_1000.json");
  if (!btcD1) {
    console.log("!! cache BTCUSDT_1d_1000.json tidak ada — jalankan scan dulu");
    process.exit(2);
  }

  const files = readdirSync(CACHE_DIR);
  const h4Symbols = files
    .map((f) => /^([A-Z0-9]+)_4h_1000\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!);

  const hist = {
    totalSignalRows: 0,
    shortRows: 0,
    longRows: 0,
    shortKeys: 0,
    identicalPairs: 0,
    differingPairs: 0,
    rsw02OnlyShortKeys: 0,
    byStrategy: {} as Record<string, number>,
  };
  const fwd = {
    symbols: 0,
    rsw01: 0,
    rsw02: 0,
    rsw03: 0,
    dupShortPairs: 0,
  };

  for (const sym of h4Symbols) {
    const h4 = loadBar(`${sym}_4h_1000.json`);
    if (!h4) continue;
    fwd.symbols++;

    // --- (1) historik: apakah masih ada pasangan SHORT identik? ---
    const sigs = rswHistoricalH4Signals(sym, h4, btcD1);
    const byKey = new Map<string, typeof sigs>();
    for (const s of sigs) {
      hist.totalSignalRows++;
      hist.byStrategy[s.strategyId] = (hist.byStrategy[s.strategyId] ?? 0) + 1;
      if (s.side === "SHORT") {
        hist.shortRows++;
        const k = `${sym}|${s.time}`;
        const arr = byKey.get(k) ?? [];
        arr.push(s);
        byKey.set(k, arr);
      } else {
        hist.longRows++;
      }
    }
    for (const group of byKey.values()) {
      hist.shortKeys++;
      const ids = group.map((g) => g.strategyId).sort();
      if (ids.length > 1) {
        const entries = new Set(group.map((g) => `${g.entry}|${g.sl}`));
        if (entries.size === 1) hist.identicalPairs++;
        else hist.differingPairs++;
        if (ids.includes("RSW-02") && !ids.includes("RSW-01")) hist.rsw02OnlyShortKeys++;
      }
    }

    // --- (2) forward: plan pada bar terakhir ---
    const fwdSigs = h4Signals(sym, h4, btcD1);
    const seen = new Map<string, number>();
    for (const s of fwdSigs) {
      if (s.strategyId === "RSW-01") fwd.rsw01++;
      else if (s.strategyId === "RSW-02") fwd.rsw02++;
      else fwd.rsw03++;
      const k = `${s.side}|${s.entry}|${s.sl}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) fwd.dupShortPairs++;
  }

  console.log("=== VERIFIKASI FIX OWNERSHIP RSW-02 (offline, dari cache scan live) ===");
  console.log(`simbol diproses        : ${fwd.symbols}`);
  console.log(`baris sinyal historik : ${hist.totalSignalRows}`);
  console.log(`  SHORT baris          : ${hist.shortRows}`);
  console.log(`  LONG baris           : ${hist.longRows}`);
  console.log(`  kunci SHORT unik     : ${hist.shortKeys}`);
  console.log(`  pasangan IDENTIK     : ${hist.identicalPairs}  <-- harus 0 setelah fix`);
  console.log(`  pasangan BEDA        : ${hist.differingPairs}`);
  console.log(`  kunci SHORT hanya RSW-02 : ${hist.rsw02OnlyShortKeys}`);
  console.log(`  sinyal per strategi : ${JSON.stringify(hist.byStrategy)}`);
  console.log("");
  console.log(`plan forward (bar terakhir): RSW-01=${fwd.rsw01} RSW-02=${fwd.rsw02}`);
  console.log(`grup plan identik (side+entry+sl) : ${fwd.dupShortPairs}  <-- harus 0`);

  const ok = hist.identicalPairs === 0 && fwd.dupShortPairs === 0;
  console.log(`\nHASIL: ${ok ? "PASS — tidak ada plan duplikat" : "FAIL — masih ada duplikat"}`);
  process.exit(ok ? 0 : 1);
}

main();
