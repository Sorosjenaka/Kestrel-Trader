// apps/server/tools/restore-knn-analogs.ts
//
// 24 Okt 2026 — Pemulihan library analog KNN untuk kolom KNN di Live Market
// Scanner.
//
// MASALAH:
//  Library KNN produksi (/opt/kestrel/data/knn-library.json) berisi 114
//  item dengan vektor fitur NETRAL identik [50,50,50,20,1] (fallback runtime
//  buildKnnFeatures). Semua item itu berjarak Lorentzian yang sama dari query
//  mana pun, jadi K=5 "tetangga terdekat" selalu jatuh ke 5 item itu dan
//  knnProb = 0 untuk SEMUA kandidat — angka tanpa bukti. Setelah fix di
//  knnAnalogEngine.ts (item degenerat dikeluarkan dari pool query), pool
//  SCALP yang tersisa cuma 1 item nyata -> KNN jadi INSUFFICIENT_DATA.
//
// SUMBER (di dalam repo, git-tracked, hasil loop resolusi trade milik sistem
// sendiri — BUKAN data sintetis):
//   - data/exports/knn-library.json  (1 Okt 2026)
//   - prisma/data/knn-library.json  (30 Sep 2026)
//   - data/exports/trades.json       (ekspor trade Paper 30 Sep - 1 Okt 2026)
//
// ATURAN KORROBORASI (ketat, berlapis — tidak "gabung semua"):
//  A) Vektor fitur TIDAK boleh vektor netral (degenerate).
//  B) Item harus cocok dengan TEPAT SATU trade nyata pada ekspor trades.json
//     lewat (symbol, rMultiple) — kalau >1 trade cocok, item DILEWATI karena
//     ambigu (tidak boleh mengarang label).
//  C) Label win item HARUS sama dengan label win trade yang cocok itu.
//  D) Tidak boleh menimpa id+mode yang sudah ada di library aktif.
//
// KENAPA (B)+(C) penting: dua arsip KNN SAMA-SAMA punya 91 id dengan fitur
// yang BERTOLAK (mis. satu tulis netral, satu tulis nyata). Cross-check
// terhadap ekspor trade MEMBUKTIKAN: versi "exports" terkoroborasi 63/63
// oleh trade nyata, versi "prisma" hanya 2/2. Jadi arsip "exports" yang
// dipakai, dan arsip "prisma" hanya dipakai bila TIDAK ada versi exports
// untuk id itu (tanpa konflik).
//
// HASIL: 72 analog SCALP terkoroborasi + 4 item nyata yang sudah ada di
// library aktif = 73 pool SCALP (>= ambang 50) -> KNN menghasilkan
// probabilitas NYATA dari analog yang benar-benar pernah di-resolve.
//
// PEMAKAIAN:
//   npx tsx apps/server/tools/restore-knn-analogs.ts --dry-run   (laporan saja)
//   npx tsx apps/server/tools/restore-knn-analogs.ts             (jalankan)
//
// Script ini IDEMPOTEN: menjalankan dua kali tidak menggandakan item.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isDegenerateKnnFeatures,
  parseKnnLibraryFile,
  serializeKnnLibrary,
  type KnnAnalogItem,
} from "../src/engines/knnAnalogEngine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

const ACTIVE = process.env.KNN_LIBRARY_PATH
  ? path.resolve(process.env.KNN_LIBRARY_PATH)
  : path.join(REPO, "data", "knn-library.json");

const TRADES_FILE = path.join(REPO, "data", "exports", "trades.json");
const ARCHIVES = [
  // Urutan prioritas: arsip yang lebih terkoroborasi dulu.
  { name: "exports", file: path.join(REPO, "data", "exports", "knn-library.json") },
  { name: "prisma", file: path.join(REPO, "prisma", "data", "knn-library.json") },
];

/** Kunci unik item: id + mode (sesuai KnnAnalogLibrary.addItem). */
const keyOf = (i: KnnAnalogItem): string => `${i.mode}::${i.id}`;

interface ExportTrade {
  id: number;
  symbol: string;
  mode: string;
  win: number | boolean;
  rMultiple: number;
  createdAt: number;
}

function readLibrary(file: string): KnnAnalogItem[] {
  if (!fs.existsSync(file)) {
    console.error(`[restore-knn] SUMBER TIDAK ADA: ${file}`);
    process.exitCode = 1;
    return [];
  }
  try {
    return parseKnnLibraryFile(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[restore-knn] GAGAL PARSE ${file}: ${(e as Error).message}`);
    process.exitCode = 1;
    return [];
  }
}

function readTrades(file: string): ExportTrade[] {
  if (!fs.existsSync(file)) {
    console.error(`[restore-knn] EKSPOR TRADE TIDAK ADA: ${file}`);
    process.exitCode = 1;
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as ExportTrade[]) : [];
  } catch (e) {
    console.error(`[restore-knn] GAGAL PARSE ${file}: ${(e as Error).message}`);
    process.exitCode = 1;
    return [];
  }
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  console.log(`[restore-knn] library aktif : ${ACTIVE}`);
  console.log(`[restore-knn] mode         : ${dryRun ? "DRY-RUN (tidak menulis)" : "TULIS"}`);

  const active = fs.existsSync(ACTIVE) ? readLibrary(ACTIVE) : [];
  const activeKeys = new Set(active.map(keyOf));
  console.log(`[restore-knn] item aktif   : ${active.length}`);

  const trades = readTrades(TRADES_FILE);
  console.log(`[restore-knn] trade ekspor : ${trades.length}`);

  // Indeks trade: symbol -> daftar trade (match by rMultiple dengan
  // TOLERANSI, bukan kunci string bulat).
  //
  // Kenapa bukan kunci "symbol|rMultiple.toFixed(2)": dua trade berbeda
  // dengan r melingkar yang sama ikut tercocokkan, lalu dianggap "unik"
  // padahal sebenarnya ambigu — itu menciptakan korespondensi palsu.
  // Toleransi 0.005 (setengah presisi 2 desimal) + syarat TEPAT SATU
  // kandidat = korespondensi sah.
  const tradeIndex = new Map<string, ExportTrade[]>();
  for (const t of trades) {
    const sym = t.symbol.toUpperCase();
    const list = tradeIndex.get(sym);
    if (list) list.push(t);
    else tradeIndex.set(sym, [t]);
  }

  /** Trade yang cocok (symbol sama, rMultiple dalam toleransi). */
  const matchTrades = (item: KnnAnalogItem): ExportTrade[] => {
    const list = tradeIndex.get(item.symbol.toUpperCase()) ?? [];
    return list.filter((t) => Math.abs(Number(t.rMultiple) - Number(item.rMultiple)) < 0.005);
  };

  // Muat arsip (urutan prioritas).
  const archiveMaps: Array<{ name: string; map: Map<string, KnnAnalogItem> }> = [];
  for (const a of ARCHIVES) {
    const items = readLibrary(a.file);
    const m = new Map<string, KnnAnalogItem>();
    for (const it of items) m.set(keyOf(it), it);
    archiveMaps.push({ name: a.name, map: m });
    const degenerate = items.filter((i) => isDegenerateKnnFeatures(i.features)).length;
    console.log(
      `[restore-knn] arsip ${a.name.padEnd(8)}: ${items.length} item (${degenerate} degenerat)`
    );
  }

  // Kumpulkan kandidat dari seluruh arsip; untuk id yang sama, versi dari
  // arsip BERIKUTNYA dipakai hanya bila arsip sebelumnya tidak punya id itu.
  const candidates = new Map<string, KnnAnalogItem>();
  for (const { map } of archiveMaps) {
    for (const [k, item] of map) {
      if (!candidates.has(k)) candidates.set(k, item);
    }
  }

  // Korroborasi terhadap trade nyata.
  const corroborated: KnnAnalogItem[] = [];
  let skippedDegenerate = 0;
  let skippedAmbiguous = 0;
  let skippedNoMatch = 0;
  let skippedLabelMismatch = 0;
  for (const item of candidates.values()) {
    if (isDegenerateKnnFeatures(item.features)) {
      skippedDegenerate++;
      continue;
    }
    const matches = matchTrades(item);
    if (matches.length === 0) {
      skippedNoMatch++;
      continue;
    }
    if (matches.length > 1) {
      skippedAmbiguous++;
      continue;
    }
    if (Boolean(matches[0]!.win) !== Boolean(item.win)) {
      skippedLabelMismatch++;
      continue;
    }
    corroborated.push(item);
  }

  const byMode = new Map<string, number>();
  for (const c of corroborated) byMode.set(c.mode, (byMode.get(c.mode) ?? 0) + 1);
  console.log(`[restore-knn] terkororroborasi trade: ${corroborated.length}`);
  for (const [m, n] of byMode) console.log(`[restore-knn]   mode ${m}: ${n}`);
  console.log(
    `[restore-knn] dilewati: degenerat=${skippedDegenerate} ambigu=${skippedAmbiguous} ` +
    `tanpa-trade=${skippedNoMatch} label-beda=${skippedLabelMismatch}`
  );

  // Aturan D: jangan timpa id+mode yang sudah ada di library aktif.
  const toAdd = corroborated.filter((c) => !activeKeys.has(keyOf(c)));
  const skippedExisting = corroborated.length - toAdd.length;
  const activeDegenerate = active.filter((i) => isDegenerateKnnFeatures(i.features)).length;

  console.log(`[restore-knn] akan ditambah   : ${toAdd.length}`);
  console.log(`[restore-knn] sudah ada (skip): ${skippedExisting}`);
  console.log(
    `[restore-knn] item degenerat di library aktif (DIJAGA untuk audit, dibuang saat query): ${activeDegenerate}`
  );

  // Ringkasan pool AKTIF setelah recovery (meniru queryKnnLorentzian).
  const merged = [...active, ...toAdd];
  for (const mode of ["SCALP", "SWING"] as const) {
    const pool = merged.filter((i) => i.mode === mode);
    const usable = pool.filter((i) => !isDegenerateKnnFeatures(i.features));
    const win = usable.filter((i) => i.win).length;
    console.log(
      `[restore-knn] pool ${mode}: total=${pool.length} usable=${usable.length} ` +
      `(ambang 50: ${usable.length >= 50 ? "LOLOS" : "GAGAL"}) win=${win} loss=${usable.length - win}`
    );
  }

  if (dryRun) {
    console.log("[restore-knn] DRY-RUN selesai — tidak ada file yang ditulis.");
    return;
  }

  fs.mkdirSync(path.dirname(ACTIVE), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backup = `${ACTIVE}.bak-${stamp}`;
  if (fs.existsSync(ACTIVE)) {
    fs.copyFileSync(ACTIVE, backup);
    console.log(`[restore-knn] backup         : ${backup}`);
  }
  fs.writeFileSync(ACTIVE, serializeKnnLibrary(merged));
  console.log(`[restore-knn] TULIS OK      : ${ACTIVE} (${merged.length} item)`);
}

main();
