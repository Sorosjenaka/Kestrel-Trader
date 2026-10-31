// apps/web/src/pages/BacktestPage.tsx - Backtest Lab & Strategy Evaluator (FR-34, US-12).
// Design system "ArtaTrade Terminal" (gaya TradingView dark, 14 Okt 2026).
import React, { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, table, th, td, badge } from "../theme.js";
import { Panel, Badge, Btn, Select, Input, EmptyState } from "../components/ui.js";
import { SwingEvalLoopPanel } from "../components/SwingEvalLoopPanel.js";
import { DataTable } from "../components/DataTable.js";
import { EChart } from "../components/EChart.js";

interface StrategyItem {
  id: string;
  name: string;
  family: string;
  timeframeScalp: string;
  description: string;
  mode?: string;
}

/**
 * Bentuk baris riwayat dari GET /api/backtest/runs.
 *
 * 29 Okt 2026 (fix) — server mengembalikan angka di dalam `metrics`
 * (`{ sampleCount, winrate, evUsd, maxDdUsd, ... }`), BUKAN di level atas.
 * Versi lama (dan versi tahap-3 awal) membaca `r.winrate` langsung sehingga
 * nilainya undefined dan `undefined.toFixed(1)` melempar TypeError yang
 * menggagalkan seluruh halaman Backtest. Di sini kedua bentuk didukung
 * supaya aman terhadap data lama maupun baru.
 */
interface BacktestRunSummary {
  id: number;
  strategyId: string;
  mode: string;
  sampleCount: number;
  winrate: number;
  evUsd: number;
  maxDdUsd: number;
  status: string;
  createdAt: string;
}

/** Ambil angka metrik dari run baik bentuk datar (lama) maupun bersarang (sekarang). */
function runMetric(run: any, key: "sampleCount" | "winrate" | "evUsd" | "maxDdUsd"): number {
  const flat = run?.[key];
  if (typeof flat === "number" && Number.isFinite(flat)) return flat;
  const nested = run?.metrics?.[key];
  if (typeof nested === "number" && Number.isFinite(nested)) return nested;
  return 0;
}

function toRunSummary(run: any): BacktestRunSummary {
  return {
    id: Number(run?.id ?? 0),
    strategyId: String(run?.strategyId ?? "·"),
    mode: String(run?.mode ?? "·"),
    sampleCount: runMetric(run, "sampleCount"),
    winrate: runMetric(run, "winrate"),
    evUsd: runMetric(run, "evUsd"),
    maxDdUsd: runMetric(run, "maxDdUsd"),
    status: String(run?.status ?? "·"),
    createdAt: String(run?.createdAt ?? run?.toDate ?? ""),
  };
}

interface BacktestDetails {
  strategyId: string;
  strategyName: string;
  mode: string;
  metrics: {
    sampleCount: number;
    winCount: number;
    lossCount: number;
    winrate: number;
    evUsd: number;
    maxDdUsd: number;
    totalNetPnlUsd: number;
    totalFeesUsd: number;
  };
  distributionR: Array<{ label: string; count: number; pct: number }>;
  gatePassed: boolean;
  failedGateReasons: string[];
  provenance?: { kind: string; datasetHash?: string; outOfSampleFrom?: number; outOfSampleTo?: number; parametersApplied?: boolean; limitations: string[] };
}

interface HistoricalDatasetFile {
  schemaVersion: 1;
  source: string;
  downloadedAt: number;
  symbol: string;
  intervalMs: number;
  bars: Array<{ openTime: number; open: number; high: number; low: number; close: number; volume: number }>;
  funding: Array<{ time: number; rate: number; markPrice: number }>;
  fundingCoverage: { from: number; to: number };
  rules: { tickSize: number; stepSize: number; minQty: number; minNotional: number; maxLeverage: number };
  outOfSampleFrom: number;
  outOfSampleTo: number;
  trainingEndedAt: number;
  embargoMs: number;
  universeSelection: string;
}

interface ParameterVersionView { version: string; params: string; status: string; createdAt: string }
interface ParameterAuditResult { audit: { passed: boolean; status: string; sampleCount: number; winrate: number; evUsd: number; reason: string } }

const labelStyle: React.CSSProperties = { fontSize: 11, color: colors.textMuted, display: "block", marginBottom: 4, fontWeight: 600 };

export function BacktestPage() {
  const [strategies, setStrategies] = useState<StrategyItem[]>([]);
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState("RSW-01");
  // T-10 (13 Okt 2026): mode mengikuti katalog strategi terpilih — RSW-01 = SWING.
  // 20 Okt 2026 (D-3): default diganti dari S-05 ke RSW-01 karena S-05 sudah retired.
  // Katalog adalah sumber kebenaran (bukan hardcode di browser).
  const [selectedMode, setSelectedMode] = useState<"SCALP" | "SWING">("SWING");
  const [sampleCount, setSampleCount] = useState(1000);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<BacktestDetails | null>(null);
  const [dataset, setDataset] = useState<HistoricalDatasetFile | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [parameterVersions, setParameterVersions] = useState<ParameterVersionView[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditResult, setAuditResult] = useState<ParameterAuditResult | null>(null);

  const fetchCatalogAndRuns = async () => {
    try {
      const catRes = await fetch("/api/backtest/catalog");
      if (catRes.ok) {
        const catJson = await catRes.json();
        setStrategies(catJson.strategies || []);
      }
      const runsRes = await fetch("/api/backtest/runs");
      if (runsRes.ok) {
        const runsJson = await runsRes.json();
        const rows = Array.isArray(runsJson.runs) ? runsJson.runs : [];
        setRuns(rows.map(toRunSummary));
      }
      const paramsRes = await fetch("/api/parameters");
      if (paramsRes.ok) {
        const paramsJson = await paramsRes.json();
        const versions = (paramsJson.versions || []) as ParameterVersionView[];
        setParameterVersions(versions);
        if (!selectedVersion) setSelectedVersion(versions.find((v) => v.status === "CANDIDATE")?.version || "");
      }
    } catch (e) {
      console.error("Gagal load katalog/runs", e);
    }
  };

  useEffect(() => {
    fetchCatalogAndRuns();
  }, []);

  const handleRunBacktest = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    try {
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyId: selectedStrategy,
          mode: selectedMode,
          sampleCount,
          ...(dataset ? { dataset, minSamples: 500, minWinrate: 60, maxDrawdownUsd: 8 } : {}),
        }),
      });
      if (res.ok) {
        const json = await res.json();
        setLastResult(json);
        await fetchCatalogAndRuns();
      }
    } catch (err) {
      console.error("Gagal menjalankan backtest", err);
    } finally {
      setRunning(false);
    }
  };

  const handleDatasetFile = async (file: File | undefined) => {
    setDatasetError(null);
    setDataset(null);
    setAuditResult(null);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as HistoricalDatasetFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.bars) || !Array.isArray(parsed.funding)
        || !Number.isFinite(parsed.outOfSampleFrom) || !Number.isFinite(parsed.outOfSampleTo)) throw new Error("Format HistoricalDataset tidak valid.");
      setDataset(parsed);
    } catch (error) {
      setDatasetError(error instanceof Error ? error.message : "File JSON tidak dapat dibaca.");
    }
  };

  const auditSelectedVersion = async () => {
    if (!selectedVersion || !dataset || auditBusy) return;
    setAuditBusy(true);
    setAuditResult(null);
    try {
      const res = await fetch("/api/parameters/audit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: selectedVersion, strategyId: selectedStrategy, dataset, maxDrawdownUsd: 8 }),
      });
      const json = await res.json() as ParameterAuditResult;
      if (!res.ok) throw new Error((json as unknown as { error?: string }).error || "Audit parameter gagal.");
      setAuditResult(json);
      await fetchCatalogAndRuns();
    } catch (error) {
      setDatasetError(error instanceof Error ? error.message : "Audit parameter gagal.");
    } finally {
      setAuditBusy(false);
    }
  };
  // Tahap 3: kolom DataTable untuk riwayat pengujian.
  const historyColumns: ColumnDef<BacktestRunSummary, any>[] = useMemo(() => [
    { accessorKey: "id", header: "ID", cell: (info) => `#${info.getValue()}` },
    { accessorKey: "strategyId", header: "Strategi", cell: (info) => <span style={{ fontWeight: 700, color: colors.textStrong }}>{info.getValue() as string}</span> },
    { accessorKey: "mode", header: "Mode", cell: (info) => { const v = info.getValue() as string; return <span style={badge(v === "SWING" ? colors.upBg : colors.accentSoft, v === "SWING" ? colors.up : colors.purple)}>{v}</span>; } },
    { accessorKey: "sampleCount", header: "Sampel", meta: { align: "right" } },
    { accessorKey: "winrate", header: "Winrate", meta: { align: "right" }, cell: (info) => { const v = info.getValue() as number; return <span style={{ color: v >= 57 ? colors.up : colors.down, fontWeight: 700 }}>{v.toFixed(1)}%</span>; } },
    { accessorKey: "evUsd", header: "EV USD", meta: { align: "right" }, cell: (info) => { const v = info.getValue() as number; return <span style={{ color: v > 0 ? colors.up : colors.down, fontFamily: fonts.mono }}>${v.toFixed(2)}</span>; } },
    { accessorKey: "maxDdUsd", header: "Max DD", meta: { align: "right" }, cell: (info) => <span style={{ color: colors.warn }}>−${(info.getValue() as number).toFixed(2)}</span> },
    { accessorKey: "status", header: "Status", cell: (info) => { const v = info.getValue() as string; return <span style={badge(v === "PASSED" ? colors.upBg : colors.downBg, v === "PASSED" ? colors.up : colors.down)}>{v}</span>; } },
  ], []);

  // Tahap 3: EChart distribusi R dari hasil backtest.
  const distROption: EChartsOption = useMemo(() => {
    if (!lastResult) return {};
    return {
      grid: { top: 24, right: 12, bottom: 32, left: 44 },
      xAxis: {
        type: "category" as const,
        data: lastResult.distributionR.map((d) => d.label),
        axisLabel: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value" as const,
        axisLabel: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono },
        splitLine: { lineStyle: { color: colors.border } },
      },
      tooltip: { trigger: "axis" as const, backgroundColor: colors.card, borderColor: colors.borderLight, textStyle: { color: colors.text, fontSize: 11, fontFamily: fonts.mono } },
      series: [{
        type: "bar" as const,
        data: lastResult.distributionR.map((d) => ({
          value: d.count,
          itemStyle: { color: d.label.startsWith("−") || d.label.startsWith("-") ? colors.down : d.label === "0" ? colors.textDim : colors.up },
        })),
        barWidth: "55%",
      }],
    };
  }, [lastResult]);

  // Tahap 3: EChart winrate vs gate 60%.
  const winrateGateOption: EChartsOption = useMemo(() => {
    if (!lastResult) return {};
    const wr = lastResult.metrics.winrate;
    return {
      grid: { top: 24, right: 12, bottom: 32, left: 44 },
      xAxis: {
        type: "category" as const,
        data: [lastResult.strategyId],
        axisLabel: { color: colors.text, fontSize: 11, fontFamily: fonts.mono },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: "value" as const,
        min: 0,
        max: 100,
        axisLabel: { color: colors.textDim, fontSize: 10, fontFamily: fonts.mono, formatter: "{value}%" },
        splitLine: { lineStyle: { color: colors.border } },
      },
      tooltip: { trigger: "axis" as const, backgroundColor: colors.card, borderColor: colors.borderLight, textStyle: { color: colors.text, fontSize: 11 } },
      series: [{
        type: "bar" as const,
        data: [{ value: wr, itemStyle: { color: wr >= 60 ? colors.up : colors.down } }],
        barWidth: 48,
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: colors.accent, type: "dashed" as const, width: 1.5 },
          label: { formatter: "Gate 60%", color: colors.accent, fontSize: 10, fontFamily: fonts.mono },
          data: [{ yAxis: 60 }],
        },
      }],
    };
  }, [lastResult]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SwingEvalLoopPanel />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: "0 0 4px 0", fontSize: 18, color: colors.textStrong, fontWeight: 700 }}>Laboratorium Backtest & Gate 60% (FR-34, US-12)</h2>
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>
            Replay historis fee-aware; perubahan parameter hanya dipertimbangkan dari bukti OOS.
          </span>
        </div>
      </div>

      <Panel
        title="DATASET OHLC HISTORIS UNTUK AUDIT PARAMETER (RISET)"
        extra={dataset ? <Badge bg={colors.upBg} fg={colors.up}>DATASET OK</Badge> : undefined}
      >
        <p style={{ fontSize: 11, margin: "0 0 10px", lineHeight: 1.5, color: colors.textMuted }}>
          Pilih HistoricalDataset JSON berisi candle 1 menit, funding, aturan simbol, dan split kronologis OOS + embargo. Audit membandingkan baseline dan kandidat pada data yang sama; hash dataset hanya boleh dipakai sekali untuk seleksi parameter. Metadata sumber file tidak membuktikan keaslian secara kriptografis.
        </p>
        <input type="file" accept="application/json,.json" onChange={(event) => void handleDatasetFile(event.target.files?.[0])} style={{ color: colors.text, fontSize: 11, fontFamily: fonts.main }} />
        {dataset && <div style={{ marginTop: 8, color: colors.up, fontSize: 11, fontFamily: fonts.mono }}>{dataset.symbol} · {dataset.bars.length.toLocaleString()} candle · source {dataset.source} · OOS {new Date(dataset.outOfSampleFrom).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} · {new Date(dataset.outOfSampleTo).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</div>}
        {datasetError && <div style={{ marginTop: 8, color: colors.down, fontSize: 11, fontFamily: fonts.mono }}>{datasetError}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
          <label style={labelStyle}>Kandidat Laras / mode-strategi
            <Select value={selectedVersion} onChange={setSelectedVersion} style={{ display: "block", marginTop: 4, minWidth: 260 }}>
              <option value="">Pilih ParameterVersion kandidat</option>
              {parameterVersions.filter((version) => version.status === "CANDIDATE").map((version) => {
                let details = "parameter tidak terbaca";
                try { const params = JSON.parse(version.params) as { param?: string; from?: number; to?: number; mode?: string; strategyId?: string }; details = `${params.strategyId ?? "?"}/${params.mode ?? "?"} ${params.param} ${params.from}R→${params.to}R`; } catch { /* safe label */ }
                return <option key={version.version} value={version.version}>{details} · {version.version.slice(-8)}</option>;
              })}
            </Select>
          </label>
          <button type="button" onClick={() => void auditSelectedVersion()} disabled={!dataset || !selectedVersion || auditBusy}
            title="Audit OOS · aktifkan hanya bila semua gate lolos"
            style={{ padding: "7px 12px", background: colors.purple, color: "#fff", border: 0, borderRadius: 6, fontWeight: 700, fontSize: 11, fontFamily: fonts.main, cursor: !dataset || !selectedVersion || auditBusy ? "not-allowed" : "pointer", opacity: !dataset || !selectedVersion ? 0.55 : 1 }}>
            {auditBusy ? "Replay baseline & kandidat…" : "Audit OOS · aktifkan hanya bila semua gate lolos"}
          </button>
        </div>
        {auditResult && <div style={{ marginTop: 10, padding: 9, borderRadius: 6, background: auditResult.audit.status === "ACTIVE" ? colors.upBg : colors.downBg, color: colors.text, fontSize: 11, fontFamily: fonts.mono, border: `1px solid ${auditResult.audit.status === "ACTIVE" ? colors.up : colors.down}` }}>
          <strong style={{ color: auditResult.audit.status === "ACTIVE" ? colors.up : colors.down }}>{auditResult.audit.status}</strong> · {auditResult.audit.sampleCount} OOS trades · WR {auditResult.audit.winrate.toFixed(1)}% · EV ${auditResult.audit.evUsd.toFixed(4)}<br />{auditResult.audit.reason}
        </div>}
      </Panel>

      {/* Form Controls */}
      <Panel title="RUN BACKTEST">
        <form onSubmit={handleRunBacktest} style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label style={labelStyle}>Pilih Strategi</label>
            <Select value={selectedStrategy} onChange={(v) => {
              setSelectedStrategy(v);
              // Mode ikut katalog (bukan hardcode per ID): S-05 Polaris (arsip
              // replay) dan RSW-01/02/03 = SWING; S-01/S-02/S-04 = SCALP.
              const cat = strategies.find((s) => s.id === v);
              setSelectedMode(cat?.mode === "SWING" ? "SWING" : "SCALP");
            }} style={{ minWidth: 220 }}>
              {strategies.map((s) => <option key={s.id} value={s.id}>{s.id} - {s.name}{s.mode === "SWING" ? " [SWING]" : ""}</option>)}
            </Select>
          </div>
          <div>
            <label style={labelStyle}>Mode Trading</label>
            <Input readOnly value={selectedMode} style={{ width: 220, color: colors.textMuted }} />
          </div>
          <div>
            <label style={labelStyle}>Jumlah Sampel</label>
            <Input type="number" min={100} max={5000} value={sampleCount} onChange={(e) => setSampleCount(Number(e.target.value))} style={{ width: 120 }} />
          </div>
          <button type="submit" disabled={running}
            style={{ padding: "7px 18px", background: colors.accent, color: "#fff", border: "none", borderRadius: 6, cursor: running ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 12, fontFamily: fonts.main, opacity: running ? 0.6 : 1 }}>
            {running ? "Menjalankan..." : "Jalankan Gate Backtest"}
          </button>
        </form>
      </Panel>

      {/* Result Card */}
      {lastResult && (
        <Panel
          title={`HASIL: ${lastResult.strategyId} (${lastResult.strategyName} · ${lastResult.mode})`}
          extra={
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: colors.textMuted }}>
                {lastResult.metrics.sampleCount} sampel; {lastResult.provenance?.kind ?? "sumber tidak tercatat"}{lastResult.provenance?.parametersApplied ? " · override diterapkan" : " · tanpa override parameter"}
              </span>
              <Badge bg={lastResult.gatePassed ? colors.upBg : colors.downBg} fg={lastResult.gatePassed ? colors.up : colors.down}>
                {lastResult.gatePassed ? "LULUS GATE" : "GAGAL GATE"}
              </Badge>
            </span>
          }
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
            <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: 10, borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600 }}>Winrate</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: fonts.mono, color: lastResult.metrics.winrate >= 57 ? colors.up : colors.down }}>
                {lastResult.metrics.winrate.toFixed(1)}%
              </div>
            </div>
            <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: 10, borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600 }}>EV Bersih</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: fonts.mono, color: lastResult.metrics.evUsd > 0 ? colors.up : colors.down }}>
                +${lastResult.metrics.evUsd.toFixed(2)}
              </div>
            </div>
            <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: 10, borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600 }}>Net PnL</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: fonts.mono, color: colors.textStrong }}>
                ${lastResult.metrics.totalNetPnlUsd.toFixed(2)}
              </div>
            </div>
            <div style={{ background: colors.bgInput, border: `1px solid ${colors.border}`, padding: 10, borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: colors.textMuted, fontWeight: 600 }}>Max DD</span>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, fontFamily: fonts.mono, color: colors.warn }}>
                -${lastResult.metrics.maxDdUsd.toFixed(2)}
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 10, color: colors.textDim, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: fonts.mono, marginBottom: 8 }}>DISTRIBUSI R·MULTIPLE</div>
              <EChart option={distROption} style={{ height: 180 }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: colors.textDim, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: fonts.mono, marginBottom: 8 }}>WINRATE VS GATE 60%</div>
              <EChart option={winrateGateOption} style={{ height: 180 }} />
            </div>
          </div>
        </Panel>
      )}

      {/* History Table */}
      <Panel title="RIWAYAT PENGUJIAN GATE BACKTEST">
        {runs.length === 0 ? (
          <EmptyState>
            Belum ada data pengujian backtest.
          </EmptyState>
        ) : (
          <DataTable columns={historyColumns} data={runs} maxHeight={400} emptyText="Belum ada riwayat pengujian." />
        )}
      </Panel>
    </div>
  );
}
