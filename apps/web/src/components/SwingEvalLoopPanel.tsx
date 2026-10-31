// apps/web/src/components/SwingEvalLoopPanel.tsx
// Read-only view of the Swing evaluation subjects (3 entry + 1 arsip riset). It never starts
// LLM/backtest/paper work from the browser; the server scheduler owns it.
// 23 Okt 2026: port ke gaya operator-console (workspace-table) + label alasan
// yang jelas ketika sebuah run dilewati SEBELUM LLM dipanggil (bukan "no model").
import React, { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { Panel, Badge } from "./ui.js";
import { DataTable } from "./DataTable.js";

interface Subject {
  strategyId: string;
  displayName: string;
  name: string;
  direction: string;
  aliases?: string[];
  fibo?: boolean;
  lifecycle: string;
  researchOnly: boolean;
  evidenceLimit: string;
}
interface Run {
  runId: string;
  strategyId: string;
  state: string;
  trigger: string;
  evidenceHash: string | null;
  feedbackSource: "LLM" | "DETERMINISTIC_FALLBACK" | null;
  aggregate?: { sampleCount: number; winRatePct: number | null; profitFactor: number | null; netPnlUsd: number; maxDrawdownUsd: number | null; feeCoverage: string; fundingCoverage?: string } | null;
  llm: { model: string | null; provider: string | null; durationMs: number; failureCode: string | null } | null;
  gate: { passed: boolean; verdict: string; reasons: string[] } | null;
  paper: { ok: boolean; mode: string; note: string; closedCount: number | null } | null;
  backtest: { sampleCount: number; winrate: number; evUsd: number } | null;
  backtestDiagnostics?: { fundingCoverage?: string; funnels?: Array<Record<string, unknown>> } | null;
  triggerReason?: string | null;
  nextEligibleAt?: string | null;
  roleRuns?: Array<{ role: string; status: string }>;
  lastError: string | null;
  updatedAt: string;
}
interface Payload { subjects: Subject[]; archivedStrategies?: Subject[]; loop: { runs: Run[] }; counts: { active: number; terminal: number; total: number }; archivedCandidates: Array<{ candidate: string; historicalLabel: string; runtimeStrategyId: string | null; reason: string }> }

/** Baris tabel yang sudah dirakit (subject + run terakhir + sel turunan).
 *  Struktur data tidak berubah, hanya diproyeksikan untuk DataTable. */
interface EvalRow {
  subject: Subject;
  run?: Run;
  llm: { main: string; sub: string };
  agg: Run["aggregate"];
  gateReasons: string | null;
  state: string;
  directionText: string;
}

const stateColor = (state: string) => {
  if (["PAPER_RUNNING", "OOS_GATE", "BACKTEST_COMPLETED"].includes(state)) return colors.up;
  if (["REJECTED", "FAILED", "NEEDS_OPERATOR"].includes(state)) return colors.down;
  if (["INSUFFICIENT_DATA", "NO_CHANGE", "ARCHIVED"].includes(state)) return colors.textMuted;
  return colors.warn;
};

const stateBadgeBg = (state: string) => {
  if (["PAPER_RUNNING", "OOS_GATE", "BACKTEST_COMPLETED"].includes(state)) return colors.upBg;
  if (["REJECTED", "FAILED", "NEEDS_OPERATOR"].includes(state)) return colors.downBg;
  if (["INSUFFICIENT_DATA", "NO_CHANGE", "ARCHIVED"].includes(state)) return colors.bgInput;
  return colors.warnBg;
};

const directionText = (s: Subject): string =>
  s.direction === "SHORT_ONLY" ? "LONG=N/A · SHORT" : s.direction === "LONG_ONLY" ? "LONG · SHORT=N/A" : "BOTH";

/** Umur report + status fresh/stale (bukti operator, wajib tetap terlihat). */
function ageCell(r: Run): React.ReactNode {
  const ageH = (Date.now() - new Date(r.updatedAt).getTime()) / 3.6e6;
  const fresh = Number.isFinite(ageH) && ageH < 24;
  return (
    <div>
      {r.updatedAt.slice(0, 16).replace("T", " ")}
      {" "}
      <span style={{ color: fresh ? colors.up : colors.warn, fontWeight: 650 }}>
        {Number.isFinite(ageH) ? `${ageH < 1 ? "<1" : Math.round(ageH)}j lalu` : "umur ?"}
        {" · "}
        {!Number.isFinite(ageH) ? "MISSING" : fresh ? "FRESH" : "STALE"}
      </span>
    </div>
  );
}

const fmtNum = (v: number | null | undefined, digits = 2): string =>
  v == null || !Number.isFinite(v) ? "·" : v.toFixed(digits);

/** Run tanpa LLM = loop short-circuit SEBELUM memanggil model (evidence kosong
 *  atau gagal deterministik). Jelaskan alasannya, jangan tulis "no model". */
function llmCell(r: Run | undefined): { main: string; sub: string } {
  if (!r) return { main: "·", sub: "belum pernah dijalankan" };
  if (r.feedbackSource === "LLM" && r.llm?.model) return { main: r.llm.model, sub: "via Xkiro" };
  if (r.feedbackSource === "DETERMINISTIC_FALLBACK") return { main: "fallback deterministik", sub: "LLM gagal; hasil bukan dari model" };
  const err = r.lastError ?? "";
  if (err.includes("NO_CLOSED_SWING_TRADES")) return { main: "dilewati", sub: "belum ada trade tertutup, LLM tidak dipanggil" };
  if (err) return { main: "dilewati", sub: err.split(",").slice(0, 2).join(", ") };
  return { main: "dilewati", sub: "tidak ada evidence untuk dievaluasi" };
}

export function SwingEvalLoopPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/swing-eval-loop/status", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
        if (alive) { setData(json as Payload); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "status gagal");
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const runs = data?.loop.runs ?? [];
  const latest = (id: string) => runs.find((r) => r.strategyId === id);
  const subjects = data?.subjects ?? [];

  // Tahap 3: proyeksi baris untuk DataTable. Nilai & urutan kolom tetap sama
  // seperti tabel lama (Strategi, Arah, State, Sampel, WR%, PF, Net USD, DD USD,
  // Evaluasi, Gate, Trigger / Next, Catatan).
  const rows: EvalRow[] = useMemo(() => subjects.map((s) => {
    const r = latest(s.strategyId);
    return {
      subject: s,
      run: r,
      llm: llmCell(r),
      agg: r?.aggregate,
      gateReasons: r?.gate && !r.gate.passed ? r.gate.reasons.join(", ") : null,
      state: r?.state ?? "NO_RUN",
      directionText: directionText(s),
    };
  }), [subjects, runs]);

  // Tahap 3: kolom DataTable. SEMUA kolom lama dipertahankan.
  const colsA: ColumnDef<EvalRow, any>[] = useMemo(() => [
    {
      id: "strategi",
      header: "Strategi",
      cell: (info) => {
        const s = info.row.original.subject;
        return (
          <div style={{ whiteSpace: "normal" }}>
            <span style={{ color: colors.textStrong, fontWeight: 650 }}>{s.displayName ?? s.name}</span>
            <div style={{ color: colors.textMuted, fontSize: 9 }}>{s.strategyId} · {s.name}{s.fibo ? " · arsip fibo" : ""}</div>
          </div>
        );
      },
    },
    {
      id: "arah",
      header: "Arah",
      cell: (info) => <span style={{ whiteSpace: "normal" }}>{info.row.original.directionText}</span>,
    },
    {
      id: "state",
      header: "State",
      cell: (info) => {
        const st = info.row.original.state;
        return <Badge bg={stateBadgeBg(st)} fg={stateColor(st)}>{st}</Badge>;
      },
    },
    {
      id: "sampel",
      header: "Sampel",
      meta: { align: "right" },
      cell: (info) => {
        const agg = info.row.original.agg;
        return <span style={{ fontVariantNumeric: "tabular-nums" }}>{agg ? agg.sampleCount : "·"}</span>;
      },
    },
    {
      id: "wr",
      header: "WR%",
      meta: { align: "right" },
      cell: (info) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtNum(info.row.original.agg?.winRatePct, 1)}</span>,
    },
    {
      id: "pf",
      header: "PF",
      meta: { align: "right" },
      cell: (info) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtNum(info.row.original.agg?.profitFactor)}</span>,
    },
    {
      id: "net",
      header: "Net USD",
      meta: { align: "right" },
      cell: (info) => {
        const agg = info.row.original.agg;
        if (!agg) return <span>·</span>;
        const v = agg.netPnlUsd;
        return <span style={{ color: v > 0 ? colors.up : v < 0 ? colors.down : colors.text, fontVariantNumeric: "tabular-nums" }}>{v.toFixed(2)}</span>;
      },
    },
    {
      id: "dd",
      header: "DD USD",
      meta: { align: "right" },
      cell: (info) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtNum(info.row.original.agg?.maxDrawdownUsd)}</span>,
    },
    {
      id: "evaluasi",
      header: "Evaluasi",
      cell: (info) => {
        const row = info.row.original;
        return (
          <div style={{ maxWidth: 210, whiteSpace: "normal" }}>
            <span style={{ color: row.run?.feedbackSource === "LLM" ? colors.text : colors.textMuted }}>{row.llm.main}</span>
            <div style={{ color: colors.textMuted, fontSize: 9 }}>{row.llm.sub}</div>
          </div>
        );
      },
    },
  ], []);

  const colsB: ColumnDef<EvalRow, any>[] = useMemo(() => [
    {
      id: "gate",
      header: "Gate",
      cell: (info) => {
        const row = info.row.original;
        const g = row.run?.gate;
        if (!g) return <span style={{ color: colors.textMuted }}>·</span>;
        return (
          <div style={{ whiteSpace: "normal" }}>
            <Badge bg={g.passed ? colors.upBg : colors.downBg} fg={g.passed ? colors.up : colors.down}>
              {g.passed ? "LOLOS" : "GAGAL"}
            </Badge>
            <div style={{ color: g.passed ? colors.up : colors.textMuted, fontSize: 9.5, marginTop: 2 }}>
              {g.verdict}{g.passed ? " · PASS" : ""}
            </div>
            {!g.passed && g.reasons.length ? (
              <div style={{ color: colors.textMuted, fontSize: 9, maxWidth: 200, whiteSpace: "normal" }}>{g.reasons.join(", ")}</div>
            ) : null}
            {row.run?.backtest && <div style={{ color: colors.textMuted, fontSize: 9 }}>bt n={row.run.backtest.sampleCount} ev={row.run.backtest.evUsd}</div>}
          </div>
        );
      },
    },
    {
      id: "trigger",
      header: "Trigger / Next",
      cell: (info) => {
        const r = info.row.original.run;
        if (!r) return <span style={{ color: colors.textMuted }}>·</span>;
        return (
          <div style={{ color: colors.textMuted, fontSize: 9.5, maxWidth: 190, whiteSpace: "normal" }}>
            {r.triggerReason ?? r.trigger ?? "·"}
            {r.updatedAt ? ageCell(r) : null}
            {r.roleRuns?.length ? <div>{r.roleRuns.map((x) => `${x.role}:${x.status}`).join(" · ")}</div> : null}
          </div>
        );
      },
    },
    {
      id: "catatan",
      header: "Catatan",
      cell: (info) => {
        const row = info.row.original;
        return (
          <div style={{ whiteSpace: "normal", maxWidth: 240 }}>
            {row.run?.lastError ?? row.gateReasons ?? row.subject.evidenceLimit}
            {row.run?.backtestDiagnostics?.fundingCoverage ? <div>funding={row.run.backtestDiagnostics.fundingCoverage}</div> : null}
          </div>
        );
      },
    },
  ], []);

  const cols: ColumnDef<EvalRow, any>[] = useMemo(() => [...colsA, ...colsB], [colsA, colsB]);

  return (
    <Panel
      title="SWING EVALUATION LOOP · 3 STRATEGI RISET + 1 ARSIP RISET"
      extra={<span className="mono" style={{ fontSize: 10, color: colors.textMuted }}>active {data?.counts.active ?? "·"} · terminal {data?.counts.terminal ?? "·"}</span>}
    >
      <p style={{ fontSize: 11, color: colors.textMuted, margin: "0 0 10px", lineHeight: 1.55, maxWidth: 980 }}>
        Evaluasi LLM → feedback schema → eksperimen allowlist → backtest → OOS gate → kontrak evaluasi → review.
        Tiga subjek entry aktif: Orion (RSW-01), Vega (RSW-02), Draco (RSW-03). Polaris (S-05) = ARSIP RISET
        (entry retired 20 Okt 2026, mesin replay tetap hidup). S-03/S-04 dihapus dari katalog aktif 20 Okt 2026.
        Gate menolak PASS selama sampel &lt; 500, state INSUFFICIENT_DATA dengan sampel kecil adalah perilaku
        yang diharapkan, bukan error. Tidak ada order exchange, ARM, atau perubahan LIVE/SCALP dari loop ini.
        <strong style={{ color: colors.text }}> Scope: status per COHORT STRATEGI (bukan posisi/record yang dipilih).</strong>
        Misal "NO_CLOSED_SWING_TRADES" berarti strategi itu belum punya trade tertutup pada cohort produksi,
        bukan status posisi terbuka. Umur report ditandai FRESH/STALE per baris.
      </p>
      {error && <div style={{ color: colors.down, fontSize: 11, marginBottom: 8 }}>{error}</div>}

      {subjects.length === 0 ? (
        <div className="ledger-empty">{error ? "Gagal memuat status loop." : "Memuat status loop…"}</div>
      ) : (
        <DataTable
          columns={cols}
          data={rows}
          emptyText="Belum ada strategi di loop evaluasi."
          maxHeight={520}
        />
      )}

      <div style={{ marginTop: 10, fontSize: 10.5, color: colors.textMuted, lineHeight: 1.5 }}>
        Arsip (entry baru nonaktif; histori/posisi lama tetap): {data?.archivedStrategies?.map((s) => `${s.strategyId} ${s.displayName}`).join(" · ") ?? "S-03 Atlas · S-05 Polaris"}.
        {" "}Kandidat historis tanpa ID runtime: {data?.archivedCandidates?.map((c) => c.candidate).join(" · ") ?? "·"}, tidak dipetakan paksa ke RSW.
      </div>
    </Panel>
  );
}