// apps/web/src/pages/SettingsPage.tsx - Settings & Security (FR-35, NFR-08, US-15).
// Redo tema B "X / ink": token dari theme.ts, PageHead serif + eyebrow, DataTable
// untuk editor blacklist, modal konfirmasi ARM bergaya prototype.
// 29 Okt 2026 (tahap 3 redesign): restyle saja. Endpoint, polling, alur konfirmasi
// ARM, kill switch, dan mutasi blacklist TIDAK diubah.
import React, { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { colors, fonts, card } from "../theme.js";
import { Panel, Badge, Btn, Input, EmptyState, PageHead } from "../components/ui.js";
import { DataTable } from "../components/DataTable.js";
import { shutdownTerminal } from "../lib/terminalActions";
import { enabledTradingModes } from "../lib/modePresentation";
import { apiFetch } from "../lib/api.js";

interface BlacklistEntry {
  symbol: string;
  blacklistReason: string | null;
}

interface SettingsData {
  arm: boolean;
  executionMode: "PAPER" | "LIVE";
  liveReady: boolean;
  keys: {
    binance: "SET" | "MISSING";
    xkiro: "SET" | "MISSING";
    llm: "SET" | "MISSING";
    llmProvider: "XKIRO";
  };
  modes: {
    scalp: boolean;
    swing: boolean;
  };
  tradingStyle?: string;
  blacklistManual: BlacklistEntry[];
  thresholds: {
    riskPerTradeUsd: number;
    leverageTarget: number;
    marginCapPct: number;
    dailyStopUsd: number;
    autoDisarmDdUsd: number;
    maxOpenPositions: number;
  };
}

interface LlmStatusData {
  provider: string;
  modelFast: string;
  modelReason: string;
  modelReasonFallbacks: string[];
  reasoningEffortRequested: string;
  lastSuccessModel: string;
  totalCalls: number;
  fallbackCalls: number;
  modelSwitchCount: number;
  lastModelSwitch: string;
  monthlyBudgetUsd: number;
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmArmModal, setConfirmArmModal] = useState(false);
  const [newBlacklistSymbol, setNewBlacklistSymbol] = useState("");
  const [newBlacklistReason, setNewBlacklistReason] = useState("");
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        setActionMsg(`Pengaturan tidak dapat dimuat (HTTP ${res.status}).`);
      }
    } catch (e) {
      setActionMsg("Koneksi pengaturan terputus.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
    const settingsTimer = setInterval(fetchSettings, 5000);
    const refreshLlm = () => fetch("/api/llm/status")
      .then((res) => res.ok ? res.json() : null)
      .then((json) => setLlmStatus(json?.status ?? null))
      .catch(() => setLlmStatus(null));
    refreshLlm();
    const timer = setInterval(refreshLlm, 15_000);
    return () => { clearInterval(timer); clearInterval(settingsTimer); };
  }, []);

  const handleToggleArm = async (targetArm: boolean) => {
    if (targetArm) {
      if (data?.executionMode !== "PAPER") {
        setActionMsg("Aktivasi ARM dari UI dinonaktifkan. Emergency exit menghentikan bot dan mematikan ARM.");
        return;
      }
      // Buka modal konfirmasi (NFR-10)
      setConfirmArmModal(true);
      return;
    }
    // Langsung disarm tanpa hambatan
    await executeArmToggle(false);
  };

  const executeArmToggle = async (armed: boolean) => {
    if (armed && data?.executionMode !== "PAPER") return;
    setBusy(true);
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arm: armed }),
      });
      if (res.ok) {
        setActionMsg(armed ? "ARM diaktifkan. Status eksekusi mengikuti mode yang ditampilkan di bawah." : "Sistem dalam status DISARMED.");
        setConfirmArmModal(false);
        await fetchSettings();
      } else {
        setActionMsg(`Perubahan ARM ditolak (HTTP ${res.status}).`);
      }
    } catch (e) {
      setActionMsg("Perubahan ARM belum terkonfirmasi: koneksi terputus.");
    } finally {
      setBusy(false);
    }
  };

  const handleKillSwitch = async () => {
    if (!confirm("PERINGATAN: Eksekusi Global Kill Switch akan menutup SELURUH posisi terbuka dan mematikan status ARM. Lanjutkan?")) {
      return;
    }
    setBusy(true);
    try {
      await shutdownTerminal();
      setActionMsg("Terverifikasi: posisi aplikasi kosong, bot berhenti, ARM OFF.");
      await fetchSettings();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Penutupan belum terkonfirmasi.");
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMode = async (mode: "scalp") => {
    if (!data) return;
    const newModes = { ...data.modes, [mode]: !data.modes[mode] };
    try {
      await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modes: newModes }),
      });
      await fetchSettings();
    } catch (e) {
      console.error("Gagal update mode", e);
    }
  };

  const handleAddBlacklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBlacklistSymbol.trim()) return;
    try {
      const res = await apiFetch("/api/settings/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: newBlacklistSymbol.trim().toUpperCase(),
          reason: newBlacklistReason.trim() || "Manual Blacklist",
        }),
      });
      if (res.ok) {
        setNewBlacklistSymbol("");
        setNewBlacklistReason("");
        await fetchSettings();
      }
    } catch (e) {
      console.error("Gagal menambah blacklist", e);
    }
  };

  const handleRemoveBlacklist = async (sym: string) => {
    try {
      const res = await apiFetch(`/api/settings/blacklist/${sym}`, { method: "DELETE" });
      if (res.ok) {
        await fetchSettings();
      }
    } catch (e) {
      console.error("Gagal menghapus blacklist", e);
    }
  };

  // Tahap 3: editor blacklist memakai DataTable (kolom Simbol, Alasan, Aksi).
  // Aksi "Hapus" tetap memanggil handleRemoveBlacklist yang sudah ada.
  const blacklistColumns: ColumnDef<BlacklistEntry, any>[] = useMemo(() => [
    {
      accessorKey: "symbol",
      header: "Simbol",
      cell: (info) => (
        <span style={{ fontWeight: 700, color: colors.textStrong }}>{info.getValue() as string}</span>
      ),
    },
    {
      accessorKey: "blacklistReason",
      header: "Alasan",
      cell: (info) => {
        const v = info.getValue() as string | null;
        return <span style={{ color: colors.textMuted }}>{v || "Manual"}</span>;
      },
    },
    {
      id: "aksi",
      header: "Aksi",
      cell: (info) => (
        <button
          onClick={() => handleRemoveBlacklist(info.row.original.symbol)}
          style={{
            padding: "2px 8px", background: colors.downBg, color: colors.down,
            border: `1px solid ${colors.down}`, borderRadius: 0, cursor: "pointer",
            fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", fontFamily: fonts.mono,
          }}
        >
          Hapus
        </button>
      ),
    },
  ], []);

  if (loading && !data) {
    return <div style={{ padding: 40, textAlign: "center", color: colors.textMuted, fontSize: 12.5 }}>Memuat Pengaturan...</div>;
  }

  if (!data) return <div role="alert" style={{ color: colors.down, padding: 24 }}>{actionMsg ?? "Pengaturan belum tersedia."}</div>;
  const { arm, keys, modes, blacklistManual, thresholds, executionMode, liveReady } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        eyebrow="SETTINGS / SYSTEM"
        title="Pengaturan & Keamanan"
        desc="Kontrol status ARM, sakelar darurat kill switch, proteksi rahasia API key, dan editor blacklist manual."
      />

      {actionMsg && (
        <div
          style={{
            background: colors.accentSoft,
            border: `1px solid ${colors.accent}`,
            color: colors.textStrong,
            padding: "10px 14px",
            borderRadius: 6,
            fontSize: 12,
            fontFamily: fonts.mono,
          }}
        >
          {actionMsg}
        </div>
      )}

      {/* Row 1: ARM Control & Emergency Kill Switch */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <Panel title="STATUS EKSEKUSI ARM (US-15)" extra={
          <Badge
            bg={arm ? colors.upBg : colors.bgInput}
            fg={arm ? colors.up : colors.textMuted}
          >
            {arm ? `ARMED (${executionMode}${liveReady ? "" : " · BLOCKED"})` : "DISARMED (OFF)"}
          </Badge>
        }>
          <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Aktivasi ARM dari UI dinonaktifkan. Emergency exit menghentikan bot dan mematikan ARM.
          </div>
          <div style={{ marginTop: 4, marginBottom: 12 }}>
            {arm ? (
              <Btn onClick={() => handleToggleArm(false)} tone="default" disabled={busy}>Matikan ARM</Btn>
            ) : (
              <Btn onClick={() => handleToggleArm(true)} tone="primary" disabled={busy || executionMode !== "PAPER"}>Aktifkan ARM &rarr;</Btn>
            )}
          </div>
          <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
            Mode order: {executionMode}. {executionMode === "PAPER"
              ? "Order diproses sebagai simulasi internal."
              : "Entry LIVE mengikuti gate server; ARM tidak membuka order tanpa gate."}
          </div>
        </Panel>

        <Panel
          title="GLOBAL EMERGENCY KILL SWITCH"
          style={{ borderColor: colors.down }}
        >
          <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Tutup posisi yang tercatat di aplikasi & matikan ARM
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Btn onClick={handleKillSwitch} tone="danger" disabled={busy}>{busy ? "MEMVERIFIKASI…" : "EKSEKUSI GLOBAL KILL SWITCH"}</Btn>
            <span style={{ fontSize: 10, color: colors.down, fontWeight: 700, letterSpacing: "0.14em", fontFamily: fonts.mono }}>
              TINDAKAN PERMANEN
            </span>
          </div>
        </Panel>
      </div>

      {/* Row 2: Security & Trading Modes */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
        <Panel title="KEAMANAN KREDENSIAL & KUNCI (NFR-08)">
          <div style={{ fontSize: 11.5, color: colors.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
            Kunci API disimpan strictly di server (.env). Status SET/MISSING tanpa kebocoran secret.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 }}>
            {[
              { label: "Binance Futures API Key", status: keys.binance },
              { label: "Xkiro API Key", status: keys.llm },
            ].map((k) => (
              <div
                key={k.label}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  background: colors.bgInput, padding: "8px 12px", borderRadius: 0,
                  border: `1px solid ${colors.border}`,
                }}
              >
                <span style={{ color: colors.text }}>{k.label}</span>
                <span style={{ fontWeight: 700, fontFamily: fonts.mono, color: k.status === "SET" ? colors.up : colors.down, letterSpacing: "0.08em" }}>
                  {k.status === "SET" ? "SET (AMAN)" : "MISSING"}
                </span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="KONFIGURASI MODE TRADING">
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 2 }}>
            {(["SCALP", "SWING"] as const).map(mode => (
              <label key={mode} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: colors.text }}>
                <input type="checkbox" checked={enabledTradingModes(modes).includes(mode)} disabled style={{ marginTop: 3, accentColor: colors.accent }} />
                <span><strong>{mode === "SWING" ? "SWING 1h" : "SCALP 5m"}</strong> · {enabledTradingModes(modes).includes(mode) ? "lane aktif" : "lane nonaktif"}</span>
              </label>
            ))}
            <div style={{ fontSize: 11, color: colors.textMuted, lineHeight: 1.5 }}>
              Konfigurasi runtime: {data.tradingStyle ?? (enabledTradingModes(modes).join(" + ") || "tidak tersedia")}. Batas akun {thresholds.maxOpenPositions} posisi. TP mengikuti rencana dan ledger server.
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="STATUS MODEL LLM">
        {llmStatus ? (
          <>
            <div
              style={{
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8,
                fontSize: 11.5, fontFamily: fonts.mono, color: colors.textMuted,
              }}
            >
              <div>FAST: <strong style={{ color: colors.text }}>{llmStatus.modelFast}</strong></div>
              <div>REASON: <strong style={{ color: colors.text }}>{llmStatus.modelReason}</strong></div>
              <div>Fallback REASON: <strong style={{ color: colors.text }}>{llmStatus.modelReasonFallbacks.join(" → ") || "tidak diatur"}</strong></div>
              <div>Intent reasoning: <strong style={{ color: colors.text }}>{llmStatus.reasoningEffortRequested}</strong></div>
              <div>Model terakhir menjawab: <strong style={{ color: colors.purple }}>{llmStatus.lastSuccessModel || "belum ada"}</strong></div>
              <div>Respons berhasil: <strong style={{ color: colors.up }}>{llmStatus.totalCalls}</strong></div>
              <div>Panggilan gagal: <strong style={{ color: colors.down }}>{llmStatus.fallbackCalls}</strong></div>
              <div>Pindah model: <strong style={{ color: colors.text }}>{llmStatus.modelSwitchCount}</strong>{llmStatus.lastModelSwitch ? ` · terakhir ${llmStatus.lastModelSwitch}` : ""}</div>
            </div>
            <div style={{ marginTop: 10, color: colors.textMuted, fontSize: 11, lineHeight: 1.5 }}>
              Provider {llmStatus.provider}. Intent reasoning {llmStatus.reasoningEffortRequested} adalah permintaan dan provider/model dapat menyesuaikan atau mengabaikannya. Nama terakhir menunjukkan model yang benar-benar menjawab. {llmStatus.monthlyBudgetUsd <= 0 ? "Batas biaya lokal aplikasi tidak aktif; tagihan provider tetap berlaku." : `Batas lokal yang dikonfigurasi: $${llmStatus.monthlyBudgetUsd.toFixed(2)} (estimasi aplikasi; cek tagihan aktual di provider).`}
            </div>
          </>
        ) : <EmptyState>Belum dapat membaca status LLM dari server.</EmptyState>}
      </Panel>

      {/* Row 3: Manual Blacklist Editor */}
      <Panel title="EDITOR BLACKLIST MANUAL SIMBOL (RULES §1.8)">
        <div style={{ fontSize: 11, color: colors.warn, marginBottom: 12, lineHeight: 1.5 }}>
          Blacklist manual mengalahkan semua filter lain (deny-by-default).
        </div>

        <form onSubmit={handleAddBlacklist} style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <Input
            type="text"
            placeholder="Simbol (mis. DOGEUSDT)"
            value={newBlacklistSymbol}
            onChange={(e) => setNewBlacklistSymbol(e.target.value)}
            style={{ width: 180 }}
          />
          <Input
            type="text"
            placeholder="Alasan blacklist..."
            value={newBlacklistReason}
            onChange={(e) => setNewBlacklistReason(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <button
            type="submit"
            style={{
              padding: "6px 14px", background: colors.accent, color: "#fff", border: "none",
              borderRadius: 0, cursor: "pointer", fontWeight: 600, fontSize: 11.5,
              letterSpacing: "0.08em", fontFamily: fonts.mono,
            }}
          >
            + Tambah Blacklist
          </button>
        </form>

        <DataTable
          columns={blacklistColumns}
          data={blacklistManual}
          emptyText="Tidak ada simbol yang diblacklist secara manual."
          maxHeight={320}
        />
      </Panel>

      {/* Row 4: Risk Parameters */}
      <Panel title="PLAFON RISIKO DETERMINISTIK (RULES §4 & §5)">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {[
            { label: "Target Risiko:", value: `$${thresholds.riskPerTradeUsd}`, color: colors.textStrong as string },
            { label: "Leverage Cap:", value: `${thresholds.leverageTarget}x`, color: colors.accent as string },
            { label: "Margin Cap:", value: `${thresholds.marginCapPct}%`, color: colors.textStrong as string },
            { label: "Daily Stop:", value: thresholds.dailyStopUsd === 0 ? "NONAKTIF" : `-$${thresholds.dailyStopUsd}`, color: colors.down as string },
            { label: "Auto-disarm DD:", value: thresholds.autoDisarmDdUsd === 0 ? "NONAKTIF" : `-$${thresholds.autoDisarmDdUsd}`, color: colors.down as string },
          ].map((r) => (
            <div
              key={r.label}
              style={{ ...card, background: colors.bgInput, padding: 10, borderRadius: 0, fontFamily: fonts.mono }}
            >
              <div style={{ fontSize: 10, color: colors.textDim, fontWeight: 600, letterSpacing: "0.12em", marginBottom: 3, textTransform: "uppercase" }}>{r.label}</div>
              <div style={{ fontWeight: 700, color: r.color, fontSize: 14 }}>{r.value}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* Modal Konfirmasi ARM (NFR-10): gaya prototype, perilaku tetap sama */}
      {confirmArmModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(4,5,15,0.78)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999, padding: 16 }}>
          <div style={{
            ...card,
            background: colors.bgPanel,
            border: `1px solid ${colors.down}`,
            boxShadow: "0 0 0 1px rgba(224,34,44,.12), 0 30px 80px rgba(0,0,0,.6)",
            padding: 20, maxWidth: 420, width: "100%",
          }}>
            <h3 style={{ margin: "0 0 10px 0", color: colors.down, fontSize: 14, fontWeight: 700, fontFamily: fonts.mono, letterSpacing: "0.14em", textTransform: "uppercase" }}>Konfirmasi Aktivasi ARM</h3>
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: colors.text }}>
              {executionMode === "PAPER"
                ? "ARM akan mengizinkan bot membuka posisi simulasi. Tidak ada order yang dikirim ke akun Binance."
                : "Mode LIVE saat ini diblokir oleh server; mengaktifkan ARM tidak akan mengirim order ke Binance."}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
              <Btn onClick={() => setConfirmArmModal(false)} tone="default">Batal</Btn>
              <Btn onClick={() => executeArmToggle(true)} tone="primary" disabled={busy || executionMode !== "PAPER"}>Ya, Aktifkan ARM</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
