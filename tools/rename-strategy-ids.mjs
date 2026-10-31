// tools/rename-strategy-ids.mjs
// Renumber strategi aktif 29 Sep 2026 (perintah operator):
//   S-01 Squeeze Breakout Scalp      (tetap S-01)
//   S-02 FVG Continuation   -> S-02
//   S-03 Liquidity Sweep Reclaim  -> S-02
//   S-04 Age Adaptive Supertrend  -> S-04
//   S-05 HA Smooth Scalper        -> S-05
//
// Rename memakai placeholder supaya tidak ada tabrakan saat swap
// (S-02 -> S-02 sementara S-03 -> S-02, dst).
//
// PENGECUALIAN: file yang memuat peta/daftar strategi PENSIUNAN lama
// (S-02 Zona Rejection, S-04 Trend Pullback, S-05 ORB) TIDAK diubah oleh
// skrip ini — penanganannya manual karena ID-nya dipakai ulang.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("C:/Users/FATHUR/Documents/Baru");
const TARGET_DIRS = ["apps/server/src", "apps/server/tests", "apps/web/src", "tools"];
const EXT = new Set([".ts", ".tsx", ".mjs", ".js"]);

// Berkas yang menangani strategi pensiunan lama -> JANGAN diubah otomatis.
const SKIP_FILES = new Set([
  path.join(ROOT, "apps/server/src/strategies/strategyCatalog.ts"),
]);

const P3 = "S-02";
const P6 = "S-03";
const P7 = "S-04";
const P8 = "S-05";

const STEPS = [
  [/\bS-03\b/g, P3],
  [/\bS-06\b/g, P6],
  [/\bS-07\b/g, P7],
  [/\bS-08\b/g, P8],
  [new RegExp(P3, "g"), "S-02"],
  [new RegExp(P6, "g"), "S-02"],
  [new RegExp(P7, "g"), "S-04"],
  [new RegExp(P8, "g"), "S-05"],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const report = [];
for (const dir of TARGET_DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (SKIP_FILES.has(file)) { report.push(`SKIP  ${file}`); continue; }
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    for (const [re, to] of STEPS) after = after.replace(re, to);
    if (after !== before) {
      fs.writeFileSync(file, after);
      report.push(`EDIT  ${path.relative(ROOT, file)}`);
    }
  }
}
console.log(report.join("\n"));
console.log(`\nTotal file diubah: ${report.filter((l) => l.startsWith("EDIT")).length}`);