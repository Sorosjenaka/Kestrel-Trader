// tools/db-path.mjs — SATU-SATUNYA sumber kebenaran path DB untuk semua tools.
//
// MASALAH YANG DIPERBAIKI (25 Okt 2026):
//   17 tools menulis/membaca DB di path yang SALAH karena ada 3 interpretasi
//   path berbeda di repo, dan tidak satu pun sesuai DB aktif:
//
//   1. `path.resolve("prisma/data/artatrade.db")`  -> prisma/data/artatrade.db
//      File itu 0 BYTE (sisa migrasi lama). 9 tools .mjs kena ini.
//
//   2. `datasourceUrl: "file:./data/artatrade.db"` -> prisma/data/artatrade.db
//      PRISMA resolve path relatif terhadap DIREKTORI SCHEMA (prisma/),
//      BUKAN cwd! Bukti: query ke URL ini mengembalikan 0 tabel, sedangkan
//      path absolut mengembalikan 55 tabel. 7 tools .ts kena ini — dan
//      2 di antaranya tools RESET yang menghapus history trading.
//      ('tools/reset-keep-eval.ts' sudah dikoreksi manual 3 Okt 2026 dengan
//       path absolut; ketiadaan koreksi di 6 tool lain = bug yang sama berulang.)
//
//   3. `new PrismaClient()` tanpa datasourceUrl -> pakai DATABASE_URL dari
//      environment proses. Kalau .env tidak termuat, Prisma fallback ke
//      default schema-relative juga salah.
//
//   DB AKTIF SEBENARNYA: /opt/kestrel/data/artatrade.db
//      (DATABASE_URL=file:/opt/kestrel/data/artatrade.db di .env root
//       DAN apps/server/.env)
//
// ATURAN PEMAKAIAN:
//   import { resolveDbPath, resolveDbUrl, describeDb } from "./db-path.mjs";
//   const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
//   const prisma = new PrismaClient({ datasourceUrl: resolveDbUrl() });
//
// JANGAN pernah menulis path DB literal lagi di tool. Kalau butuh override:
//   ARTATRADE_DB=/path/ke/db.db node tools/foo.mjs
//
// PENTING: helper ini SENGAJA read-only. Ia tidak pernah membuka/menulis DB
// dan tidak pernah membuat file baru — hanya menentukan location path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/** Buang tanda kutip, kurung, dan query string dari sebuah DATABASE_URL. */
function stripUrl(url) {
  let s = url.trim().replace(/^["']|["']$/g, "");
  s = s.replace(/^file:/i, "");
  s = s.split("?")[0];
  // sqlite: "file:(...)" — kurung optional.
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  return s;
}

/**
 * Baca DATABASE_URL dari chain env yang SAMA dengan aplikasi:
 * apps/server/.env dulu (prioritas tinggi), lalu .env root — first-write-wins.
 * TIDAK memakai dotenv supaya helper tetap dependency-free dan bisa dipakai
 * dari tool node:sqlite tanpa install apa pun.
 */
function readEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (!val) continue;
    // Buang komentar di luar kutip.
    if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val) out[m[1]] = val;
  }
  return out;
}

function envChain() {
  const merged = {};
  // Prioritas TINGGI lebih dulu; first-write-wins seperti apps/server/src/core/env.ts.
  for (const file of [
    path.join(REPO_ROOT, "apps", "server", ".env"),
    path.join(REPO_ROOT, ".env"),
  ]) {
    for (const [k, v] of Object.entries(readEnvFile(file))) {
      if (merged[k] === undefined) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Path absolut file DB aktif.
 * Prioritas:
 *   1. ARTATRADE_DB (env proses) — override eksplisit
 *   2. DATABASE_URL dari chain .env aplikasi
 *   3. DATABASE_URL dari env proses
 *   4. fallback <repo>/data/artatrade.db (lokasi DB aktif yang CONFIRMED)
 */
export function resolveDbPath() {
  const override = process.env.ARTATRADE_DB?.trim();
  if (override) return path.resolve(stripUrl(override));

  const chain = envChain();
  const url = chain.DATABASE_URL || process.env.DATABASE_URL?.trim();
  if (url) {
    const raw = stripUrl(url);
    if (raw) {
      // Path relatif di URL Prisma = relatif ke direktori schema (prisma/).
      // Kita TIDAK menirukan itu; DB aktif selalu absolut dari .env.
      return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(REPO_ROOT, raw);
    }
  }
  return path.join(REPO_ROOT, "data", "artatrade.db");
}

/** URL Prisma yang BENAR untuk `new PrismaClient({ datasourceUrl })`. */
export function resolveDbUrl() {
  const override = process.env.ARTATRADE_DB?.trim();
  const file = override ? path.resolve(stripUrl(override)) : resolveDbPath();
  return "file:" + file.replace(/\\/g, "/");
}

/**
 * Guard: fail-closed kalau path hasil resolusi menunjuk ke DB yang tidak ada.
 * Dipakai tool yang mau meyakinkan diri bahwa ia menulis ke DB yang benar.
 */
export function assertDbExists(label = "database") {
  const file = resolveDbPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `DB_TIDAK_DITEMUKAN:${label}:${file} — set DATABASE_URL di .env atau ARTATRADE_DB=<path>`,
    );
  }
  return file;
}

/** Ringkasan untuk log/diagnostic. */
export function describeDb() {
  const file = resolveDbPath();
  const exists = fs.existsSync(file);
  return {
    path: file,
    url: resolveDbUrl(),
    exists,
    sizeBytes: exists ? fs.statSync(file).size : 0,
  };
}
