// apps/server/src/lab/labRepo.ts — Penyimpanan riwayat eksperimen Lab (CP-7, T-22).
// Keputusan: JSON-file store di sisi data (saudaraan artatrade.db), BUKAN tabel baru
// di DB trading live — nol risiko ke jalur trading (fail-closed), cukup untuk riset.
import * as fs from "node:fs";
import * as path from "node:path";
import type { LabExperimentRecord, LabSpec, LabStats } from "./labTypes.js";

function storePath(): string {
  const dbUrl = process.env.DATABASE_URL ?? "file:../data/artatrade.db";
  const m = dbUrl.match(/file:(.+)$/);
  const dbFile = m ? m[1] : "../data/artatrade.db";
  return path.join(path.dirname(path.resolve(dbFile)), "lab", "experiments.json");
}

function loadAll(): LabExperimentRecord[] {
  const p = storePath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(rows: LabExperimentRecord[]): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

export function listExperiments(limit = 50): LabExperimentRecord[] {
  return loadAll().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function saveExperiment(spec: LabSpec, stats: LabStats, notes?: string): LabExperimentRecord {
  const rows = loadAll();
  const rec: LabExperimentRecord = {
    id: `lab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    spec,
    stats,
    notes,
  };
  rows.push(rec);
  // batasi 500 entri terakhir
  saveAll(rows.slice(-500));
  return rec;
}
