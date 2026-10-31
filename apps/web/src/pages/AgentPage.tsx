// apps/web/src/pages/AgentPage.tsx · konsol riset read-only "Arta Agent".
//
// Tahap 3 redesign tema B "X / ink": judul -> <PageHead> (eyebrow mono +
// judul serif), tabel strategi & tape sinyal -> <DataTable> (sortable),
// badge status memakai token up (cyan) / down (merah) / warn, placeholder
// kosong "·" (bukan em dash). Class CSS (.agent-shell/.agent-card/.agent-step)
// TIDAK diubah karena sudah token tema B di pro.css; yang dirapikan hanya
// radius/label/warna.
//
// Data binding, endpoint, polling 30 detik, dan handler load() TIDAK diubah.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts } from "../theme.js";
import { Badge, Btn, EmptyState, PageHead } from "../components/ui.js";
import { noDashText } from "../lib/textDash.js";
import { DataTable } from "../components/DataTable.js";

interface Subject {
  strategyId: string;
  displayName: string;
  direction: string;
  lifecycle: string;
  evidenceLimit?: string;
}
interface Run {
  strategyId: string;
  state: string;
  trigger?: string;
  updatedAt?: string;
  gate?: { passed: boolean; verdict: string; reasons?: string[] } | null;
  backtest?: { sampleCount: number; winrate: number; evUsd: number } | null;
  lastError?: string | null;
}
interface Worker { initialBalanceUsd?: number; cashUsd?: number; closedCount?: number; mode?: string }
interface StatusPayload {
  subjects: Subject[];
  paperWorkers?: Record<string, Worker>;
  loop?: { runs: Run[]; updatedAt?: string };
  counts?: { active: number; terminal: number; total: number };
}
interface Signal { id: number; symbol: string; side: string; strategyId: string; decision: string; reason?: string | null; createdAt: string }
interface AnalystDay { day: string; updatedAt: string }

/** Placeholder kosong tema B: titik tengah, bukan em dash. */
const DOT = "·";

/** Baris tabel strategi: subjek + run terakhir + worker paper. */
interface SubjectRow extends Subject {
  run: Run | undefined;
  worker: Worker | undefined;
}

/**
 * Token warna badge status tema B:
 * - up (cyan)   = berhasil
 * - down (merah) = gagal
 * - warn (pink) = sisanya (netral / belum dijalankan / di-skip)
 */
const statusTone = (s: string): { bg: string; fg: string } => {
  if (["PASS", "PAPER_RUNNING", "BACKTEST_COMPLETED"].includes(s)) return { bg: colors.upBg, fg: colors.up };
  if (["REJECTED", "FAILED", "NEEDS_OPERATOR"].includes(s)) return { bg: colors.downBg, fg: colors.down };
  return { bg: colors.warnBg, fg: colors.warn };
};

/** Badge keputusan sinyal: ENTRY_OPENED berhasil, ENTRY_REJECTED gagal, sisanya warn. */
const decisionTone = (d: string): { bg: string; fg: string } => {
  if (d === "ENTRY_OPENED") return { bg: colors.upBg, fg: colors.up };
  if (d === "ENTRY_REJECTED") return { bg: colors.downBg, fg: colors.down };
  return { bg: colors.warnBg, fg: colors.warn };
};

const lifecycleLabel = (l: string): string =>
  l === "REGISTERED_PAPER" ? "REGISTERED" : l === "FORWARD_PAPER" ? "FORWARD RISET" : l.replaceAll("_", " ");

const money = (n?: number) => `$${Number(n ?? 0).toFixed(2)}`;
const when = (iso?: string) => {
  if (!iso) return DOT;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" }) + " WIB" : iso;
};

export function AgentPage() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [days, setDays] = useState<AnalystDay[]>([]);
  const [report, setReport] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [s, g, a] = await Promise.all([
        fetch("/api/swing-eval-loop/status", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))),
        fetch("/api/swing/signals?limit=80", { cache: "no-store" }).then((r) => r.ok ? r.json() : { signals: [] }),
        fetch("/api/research/analyst", { cache: "no-store" }).then((r) => r.ok ? r.json() : { days: [] }),
      ]);
      setStatus(s);
      setSignals(Array.isArray(g.signals) ? g.signals : []);
      const nextDays: AnalystDay[] = Array.isArray(a.days) ? a.days : [];
      setDays(nextDays);
      if (nextDays[0]?.day) {
        const r = await fetch(`/api/research/analyst?day=${encodeURIComponent(nextDays[0].day)}`, { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        setReport(typeof j.content === "string" ? j.content : "");
      } else setReport("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent data tidak tersedia");
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(id); }, [load]);

  const runs = status?.loop?.runs ?? [];
  const latestFor = (id: string) => runs.find((r) => r.strategyId === id);
  const naturalSignals = useMemo(() => signals.filter((s) => s.strategyId !== "PORTFOLIO").slice(0, 12), [signals]);
  const active = status?.counts?.active ?? 0;
  const worker = (id: string) => status?.paperWorkers?.[id];

  // Tahap 3: baris tabel strategi (subjek + run terakhir + worker paper).
  const subjectRows = useMemo<SubjectRow[]>(
    () => (status?.subjects ?? []).map((s) => ({ ...s, run: latestFor(s.strategyId), worker: worker(s.strategyId) })),
    [status],
  );

  // Tahap 3: kolom DataTable "Tiga strategi SWING PAPER".
  const subjectColumns = useMemo<ColumnDef<SubjectRow, any>[]>(() => [
    {
      id: "agent", header: "Agent", accessorFn: (r) => r.displayName,
      cell: ({ row }) => (
        <span>
          <span style={{ color: colors.textStrong, fontWeight: 650 }}>{row.original.displayName}</span>
          <br />
          <span className="tiny muted">{row.original.strategyId}</span>
        </span>
      ),
    },
    {
      id: "direction", header: "Direction", accessorFn: (r) => r.direction,
      cell: ({ row }) => (
        <span className="mono">{row.original.direction === "SHORT_ONLY" ? "SHORT ONLY" : row.original.direction}</span>
      ),
    },
    {
      id: "lifecycle", header: "Lifecycle", accessorFn: (r) => r.lifecycle,
      cell: ({ row }) => (
        <span className="mono tiny" style={{ color: colors.textMuted }}>{lifecycleLabel(row.original.lifecycle)}</span>
      ),
    },
    {
      id: "worker", header: "Worker", accessorFn: (r) => r.worker?.initialBalanceUsd ?? null,
      cell: ({ row }) => {
        const w = row.original.worker;
        if (!w) return <span style={{ color: colors.textMuted }}>{DOT}</span>;
        return (
          <span className="mono tiny">
            {money(w.initialBalanceUsd)} / {money(w.cashUsd)}
            <br />
            <span className="muted">{w.closedCount ?? 0} closed</span>
          </span>
        );
      },
    },
    {
      id: "latestRun", header: "Latest run", accessorFn: (r) => r.run?.state ?? "NO_RUN",
      cell: ({ row }) => {
        const state = row.original.run?.state ?? "NO_RUN";
        const tone = statusTone(state);
        return <Badge bg={tone.bg} fg={tone.fg}>{state.replaceAll("_", " ")}</Badge>;
      },
    },
    {
      id: "sample", header: "Sample", meta: { align: "right" },
      accessorFn: (r) => r.run?.backtest?.sampleCount ?? null,
      cell: ({ row }) => {
        const v = row.original.run?.backtest?.sampleCount;
        return v == null ? <span style={{ color: colors.textMuted }}>{DOT}</span> : <span className="mono">{v}</span>;
      },
    },
    {
      id: "ev", header: "EV", meta: { align: "right" },
      accessorFn: (r) => r.run?.backtest?.evUsd ?? null,
      cell: ({ row }) => {
        const bt = row.original.run?.backtest;
        if (!bt) return <span style={{ color: colors.textMuted }}>{DOT}</span>;
        return (
          <span className="mono" style={{ color: bt.evUsd >= 0 ? colors.up : colors.down }}>
            {bt.evUsd >= 0 ? "+" : ""}{bt.evUsd.toFixed(2)}
          </span>
        );
      },
    },
  ], []);

  // Tahap 3: kolom DataTable "SIGNAL TAPE".
  const signalColumns = useMemo<ColumnDef<Signal, any>[]>(() => [
    {
      accessorKey: "createdAt", header: "Time",
      cell: (i) => <span className="mono tiny muted">{when(i.getValue() as string)}</span>,
    },
    {
      accessorKey: "symbol", header: "Symbol",
      cell: (i) => <span className="mono" style={{ color: colors.textStrong }}>{i.getValue() as string}</span>,
    },
    {
      accessorKey: "strategyId", header: "Agent",
      cell: (i) => <span className="mono">{i.getValue() as string}</span>,
    },
    {
      accessorKey: "side", header: "Side",
      cell: (i) => {
        const v = i.getValue() as string;
        return <span style={{ color: v === "LONG" ? colors.up : colors.down, fontWeight: 600 }}>{v}</span>;
      },
    },
    {
      accessorKey: "decision", header: "Decision",
      cell: (i) => {
        const v = i.getValue() as string;
        const tone = decisionTone(v);
        return <Badge bg={tone.bg} fg={tone.fg}>{v}</Badge>;
      },
    },
    {
      accessorKey: "reason", header: "Reason",
      cell: (i) => {
        const v = i.getValue() as string | null | undefined;
        if (!v) return <span style={{ color: colors.textMuted }}>{DOT}</span>;
        return (
          <span className="tiny muted" style={{ display: "inline-block", maxWidth: 260, whiteSpace: "normal" }}>{v}</span>
        );
      },
    },
  ], []);

  return (
    <div className="page agent-page">
      <PageHead
        eyebrow="AGENT / BRIEFING"
        title="Arta Agent"
        desc="Read-only research console · evidence SWING RISET · deterministic execution"
        right={
          <Badge bg={busy ? colors.warnBg : colors.upBg} fg={busy ? colors.warn : colors.up}>
            {busy ? "SYNCING" : "READ ONLY"}
          </Badge>
        }
      />
      <div className="agent-shell">
      <section className="agent-glow">
        <div className="agent-card">
          <div className="agent-head">
            <div className="agent-id">
              <div>
                <div className="agent-name">Arta Agent <Badge bg={colors.accentSoft} fg={colors.accent}>AGENT</Badge></div>
                <div className="agent-sub">{busy ? "Membaca evidence PAPER…" : `Tiga subjek SWING · ${active} run aktif · PAPER only`}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="agent-progress" aria-label="agent progress">
                {[0, 1, 2].map((i) => <span key={i} className={i === 0 ? "on" : ""} />)}
              </div>
              <span className="tiny mono muted">30s</span>
              <Btn tone="ghost" onClick={() => void load()} disabled={busy}>{busy ? "..." : "REPLAY"}</Btn>
            </div>
          </div>

          <div className="agent-body">
            <div className="agent-prompt">
              Audit scope: tiga subjek SWING · Orion, Vega, Draco. (S-05 Polaris dipindahkan ke arsip riset 21 Okt 2026: replay/histori saja, tanpa entry baru.) Evidence, sinyal natural, dan gate dibaca read-only; entry tetap ditentukan mesin deterministik.
              <small>BRIEFING · READ ONLY</small>
            </div>

            <div className="agent-plan">
              <span className="tiny mono muted" style={{ marginRight: 2 }}>PLAN</span>
              {["3 SWING PAPER", "500-sample gate", "RR23 50/2R/3R", "25x CROSS", "LIVE untouched"].map((x) => <span key={x} className="agent-chip" style={{ borderRadius: 2 }}>{x}</span>)}
            </div>

            <div className="agent-summary">
              <div><div className="k">Subjects</div><div className="v">3</div><div className="s">SWING PAPER</div></div>
              <div><div className="k">Active runs</div><div className="v">{active}</div><div className="s">{runs.length} total runs</div></div>
              <div><div className="k">Natural signals</div><div className="v">{naturalSignals.length}</div><div className="s">not portfolio placeholders</div></div>
              <div><div className="k">Gate</div><div className="v" style={{ color: colors.warn }}>WAIT</div><div className="s">500 samples + positive EV</div></div>
            </div>

            <div className="agent-step active" style={{ borderRadius: 2 }}>
              <div className="agent-step-head"><span>STEP 1 · EVALUATION</span><span>{status?.subjects?.length ?? 3} SUBJECTS · {busy ? "SCANNING" : "READY"}</span></div>
              <div className="agent-step-body">
                <div className="agent-step-title">Tiga strategi SWING PAPER</div>
                <div className="agent-step-desc">Saldo $200 per studi · keputusan tetap deterministik · LLM hanya membaca dan menjelaskan.</div>
                <DataTable
                  columns={subjectColumns}
                  data={subjectRows}
                  maxHeight={360}
                  emptyText="Belum ada subjek evaluasi."
                />
              </div>
            </div>

            <div className="agent-step" style={{ borderRadius: 2 }}>
              <div className="agent-step-head"><span>STEP 2 · SIGNAL TAPE</span><span>{naturalSignals.length} NATURAL SIGNALS</span></div>
              <div className="agent-step-body">
                <div className="agent-step-title">Sinyal yang benar-benar muncul</div>
                <div className="agent-step-desc">Hanya sinyal natural; bukan portfolio placeholder, bukan trade yang dibuat untuk memenuhi dashboard.</div>
                {naturalSignals.length === 0 ? <div className="agent-empty" style={{ padding: "18px 0" }}>Belum ada sinyal SWING natural sejak snapshot.<br /><span className="tiny">Tidak ada trade yang dibuat untuk mengisi dashboard.</span></div> : (
                  <DataTable
                    columns={signalColumns}
                    data={naturalSignals}
                    maxHeight={420}
                    emptyText="Belum ada sinyal SWING natural sejak snapshot."
                  />
                )}
              </div>
            </div>

            <div className="agent-step" style={{ borderRadius: 2 }}>
              <div className="agent-step-head"><span>STEP 3 · ANALYST BRIEF</span><span>{days[0]?.day ?? "NO REPORT"}</span></div>
              <div className="agent-step-body">
                <div className="agent-step-title">Briefing pasar terakhir</div>
                <div className="agent-step-desc">Read-only. Angka entry, SL, TP, dan keputusan eksekusi tetap berasal dari mesin deterministik.</div>
                {report ? <div className="agent-markdown">{noDashText(report.slice(0, 5000))}</div> : <EmptyState>Belum ada laporan analyst untuk ditampilkan.</EmptyState>}
              </div>
            </div>
          </div>
        </div>
      </section>
      {error && <div style={{ color: colors.down, fontSize: 11, fontFamily: fonts.mono }}>AGENT ERROR: {error}</div>}
      </div>
    </div>
  );
}
