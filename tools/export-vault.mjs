#!/usr/bin/env node
// tools/export-vault.mjs — Ekspor statistik & jurnal trading dari DB ke vault/ (markdown Obsidian).
// DB READ-ONLY. Dipanggil tools/vault-sync.sh (timer per jam) atau manual: node tools/export-vault.mjs
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new DatabaseSync(process.env.VAULT_DB_PATH || path.join(ROOT, "data/artatrade.db"), { readOnly: true });
const VAULT = path.join(ROOT, "vault");
const DAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
const one = (s, ...p) => db.prepare(s).get(...p);
const rows = (s, ...p) => db.prepare(s).all(...p);
const f2 = (n) => (n == null || Number.isNaN(Number(n)) ? "–" : Number(n).toFixed(2));
const f3 = (n) => (n == null || Number.isNaN(Number(n)) ? "–" : Number(n).toFixed(3));

// ---------- Agregat ----------
const tot = one(`SELECT COUNT(*) total, SUM(status='OPEN') openN, SUM(status='CLOSED') closedN,
    SUM(status='CLOSED' AND pnlUsd>0) wins,
    ROUND(SUM(CASE WHEN status='CLOSED' THEN pnlUsd END),3) net,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN pnlR END),2) avgR,
    COUNT(DISTINCT symbol) symbols FROM Position`);
const closed = Number(tot.closedN ?? 0), wins = Number(tot.wins ?? 0);
const wr = closed > 0 ? `${((wins / closed) * 100).toFixed(1)}%` : "–";
const exp = closed > 0 ? f2(Number(tot.net ?? 0) / closed) : "–";
const rOf = (cond) => {
  const r = rows(`SELECT pnlR FROM Position WHERE status='CLOSED' AND ${cond}`);
  return r.length ? f2(r.reduce((a, x) => a + Number(x.pnlR || 0), 0) / r.length) : "–";
};
const winAvgR = rOf("pnlUsd>0"), lossAvgR = rOf("pnlUsd<=0");

const grp = (key) => rows(`SELECT ${key} k, COUNT(*) trades, SUM(status='CLOSED') c,
    SUM(status='CLOSED' AND pnlUsd>0) w,
    ROUND(SUM(CASE WHEN status='CLOSED' THEN pnlUsd ELSE 0 END),3) net,
    ROUND(AVG(CASE WHEN status='CLOSED' THEN pnlR END),2) avgR
  FROM Position GROUP BY ${key} ORDER BY ${key}`);
const byStrat = grp("strategyId"), bySide = grp("side");
const causes = rows(`SELECT causeCode, COUNT(*) n FROM LearningEntry GROUP BY causeCode ORDER BY n DESC LIMIT 12`);

// ---------- vault/data/stats.md ----------
const mdTable = (rws) => rws.map((r) => `| ${r.k} | ${r.trades} | ${r.c ?? 0} | ${r.w ?? 0} | ${f3(r.net)} | ${f2(r.avgR)} |`).join("\n") || "| – | – | – | – | – | – |";
const openRows = rows(`SELECT id, symbol, side, strategyId, entryPrice, slPrice, tp1Price, openedAt
  FROM Position WHERE status='OPEN' ORDER BY id DESC LIMIT 25`);
const stats = `---
tags: [artatrade, data, auto]
generated: ${NOW}
source: data/artatrade.db (read-only export)
---
# Statistik Trading (auto-export)

> ⚙️ Di-generate \`tools/export-vault.mjs\` tiap jam. Jangan edit manual — ubah [[RULES]]/[[BEHAVIOR]] untuk memengaruhi bot.

## Ringkasan (per ${NOW})

| Metrik | Nilai |
|---|---|
| Total posisi | ${tot.total} |
| OPEN / CLOSED | ${tot.openN ?? 0} / ${closed} |
| Win rate | ${wr} (${wins}/${closed}) |
| Net PnL realized | $${f3(tot.net)} |
| Expectancy | $${exp} / trade |
| Avg win R / loss R | ${winAvgR} / ${lossAvgR} |
| Simbol unik | ${tot.symbols} |

## Per Strategi

| Strategi | Trades | Closed | Wins | Net $ | Avg R |
|---|---|---|---|---|---|
${mdTable(byStrat)}

## Per Side

| Side | Trades | Closed | Wins | Net $ | Avg R |
|---|---|---|---|---|---|
${mdTable(bySide)}

## Distribusi LearningEntry

| Cause | N |
|---|---|
${causes.map((r) => `| ${r.causeCode} | ${r.n} |`).join("\n") || "| – | – |"}

## Posisi OPEN

| # | Symbol | Side | Strat | Entry | SL | TP1 | Dibuka |
|---|---|---|---|---|---|---|---|
${openRows.map((r) => `| ${r.id} | ${r.symbol} | ${r.side} | ${r.strategyId} | ${r.entryPrice} | ${r.slPrice} | ${r.tp1Price} | ${String(r.openedAt ?? "").slice(0, 16)} |`).join("\n") || "| – | tidak ada posisi | – | – | – | – | – | – |"}
`;
fs.mkdirSync(path.join(VAULT, "data"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "data", "stats.md"), stats);

// ---------- vault/journal/YYYY-MM-DD.md ----------
const closedToday = rows(`SELECT id, symbol, side, strategyId, entryPrice, qty, pnlUsd, pnlR, closeReason, closedAt
  FROM Position WHERE status='CLOSED' AND closedAt IS NOT NULL
    AND (typeof(closedAt)='text' AND COALESCE(closedAt,'') LIKE ?
     OR typeof(closedAt)='integer' AND closedAt >= ? AND closedAt < ?)
  ORDER BY id DESC LIMIT 30`,
  `${DAY}%`,
  Date.parse(`${DAY}T00:00:00Z`),
  Date.parse(`${DAY}T00:00:00Z`) + 86400000
);
const lessons = rows(`SELECT tradeId, causeCode, outcome, narrative, lesson, proposal
  FROM LearningEntry ORDER BY rowid DESC LIMIT 15`);
const txt = (r) => String(r.lesson || r.narrative || r.proposal || "").replace(/\s+/g, " ").slice(0, 200);

const journal = `---
tags: [artatrade, journal, auto]
generated: ${NOW}
---
# Jurnal Trading ${DAY} (auto-export)

## Trade CLOSED hari ini (${closedToday.length})

| # | Symbol | Side | Strat | Entry | PnL $ | PnL R | Alasan |
|---|---|---|---|---|---|---|---|
${closedToday.map((r) => `| ${r.id} | ${r.symbol} | ${r.side} | ${r.strategyId} | ${r.entryPrice} | ${f3(r.pnlUsd)} | ${f2(r.pnlR)} | ${r.closeReason} |`).join("\n") || "| – | belum ada | – | – | – | – | – | – |"}

## Posisi OPEN saat export (${tot.openN ?? 0})

${openRows.map((r) => `- **#${r.id} ${r.symbol}** ${r.side} ${r.strategyId} — entry ${r.entryPrice}, SL ${r.slPrice}, TP1 ${r.tp1Price}`).join("\n") || "- tidak ada"}

## Lessons terbaru (LearningEntry)

| Trade | Cause | Outcome | Lesson |
|---|---|---|---|
${lessons.map((r) => `| #${r.tradeId ?? "–"} | ${r.causeCode} | ${r.outcome} | ${txt(r)} |`).join("\n") || "| – | – | – | – |"}
`;
fs.mkdirSync(path.join(VAULT, "journal"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "journal", `${DAY}.md`), journal);

db.close();
console.log(`[export-vault] OK → vault/data/stats.md + vault/journal/${DAY}.md (total=${tot.total}, closed=${closed}, WR=${wr})`);

