// apps/web/src/pages/LiveMirrorPage.tsx — Dashboard perbandingan LIVE (11 Okt 2026).
// Tampilan READ-ONLY: posisi & order dari exchange Binance vs catatan DB, untuk
// cross-check manual dengan website Binance. Auto-refresh 10 detik.
// 11 Okt 2026 (perintah operator): label PAPER dihapus dari tabel, baris posisi
// BISA DIKLIK -> chart TradingView terbuka dengan garis ENTRY/SL/TP posisi itu.
import { useEffect, useState } from "react";
import type React from "react";
import { colors, fonts, table, th, td } from "../theme.js";
import { Panel, PageHead, Btn } from "../components/ui.js";
import { TradingViewEmbed } from "../components/TradingViewEmbed";

interface MirrorPos {
  symbol: string;
  db: { id: number; side: string; qty: number; entryPrice: number; slPrice: number; tp1Price: number; source: string } | null;
  exchange: { positionAmt: number; entryPrice: number | null; markPrice: number | null; leverage: string | null; marginType: string | null } | null;
  status: string;
  note: string;
}

interface MirrorOrder {
  key: string;
  db: { clientOrderId: string; type: string; side: string; price: number; qty: number; reduceOnly: boolean; status: string } | null;
  exchange: { type: string; side: string; price: number | null; triggerPrice: number | null; qty: number | null; status: string; kind: string } | null;
  status: string;
  note: string;
}

interface MirrorReport {
  generatedAt: string;
  exchange: {
    status: string; error?: string;
    walletBalance: number | null; availableBalance: number | null;
  };
  db: {
    equityUsd: number; executionMode: string; armed: boolean;
    positions: Array<{ id: number; symbol: string }>;
  };
  positions: MirrorPos[];
  orders: MirrorOrder[];
}

const STATUS_STYLE: Record<string, { bg: string; fg: string }> = {
  COCOK: { bg: colors.upBg, fg: colors.up },
  BEDA_QTY: { bg: colors.warnBg, fg: colors.warn },
  BEDA_SISI: { bg: colors.warnBg, fg: colors.warn },
  HANYA_DB: { bg: colors.downBg, fg: colors.down },
  HANYA_EXCHANGE: { bg: colors.downBg, fg: colors.down },
};

function statusBadge(status: string): { bg: string; fg: string } {
  return STATUS_STYLE[status] ?? { bg: "rgba(120,123,134,0.15)", fg: colors.textMuted };
}

function fmt(n: number | null, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "·" : n.toFixed(digits);
}

interface ChartState {
  symbol: string;
  entry: number;
  sl: number;
  tp: number;
  side: string;
  qty: number;
}

const statCard: React.CSSProperties = {
  background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 8, padding: "10px 14px", minWidth: 150,
};

export function LiveMirrorPage() {
  const [report, setReport] = useState<MirrorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [chart, setChart] = useState<ChartState | null>(null);

  const fetchReport = async () => {
    try {
      const res = await fetch("/api/live/mirror");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReport(data);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    fetchReport();
    const id = setInterval(fetchReport, 10000);
    return () => clearInterval(id);
  }, []);

  // Klik baris posisi -> buka chart (klik lagi = tutup).
  const openChart = (p: MirrorPos) => {
    if (chart && chart.symbol === p.symbol) {
      setChart(null);
      return;
    }
    const side = p.db?.side ?? ((p.exchange?.positionAmt ?? 0) > 0 ? "LONG" : "SHORT");
    const entry = p.db?.entryPrice ?? p.exchange?.entryPrice ?? 0;
    const sl = p.db?.slPrice ?? (side === "LONG" ? entry * 0.98 : entry * 1.02);
    const tp = p.db?.tp1Price ?? (side === "LONG" ? entry * 1.03 : entry * 0.97);
    const qty = p.db?.qty ?? Math.abs(p.exchange?.positionAmt ?? 0);
    setChart({ symbol: p.symbol, entry, sl, tp, side, qty });
  };

  const posTh: React.CSSProperties = { ...th };
  const posTd: React.CSSProperties = { ...td };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <PageHead
        title="Live Mirror"
        desc="Perbandingan read-only posisi & order Binance vs DB lokal · cross-check manual, refresh otomatis 10 detik."
        right={
          <Btn onClick={fetchReport}>REFRESH</Btn>
        }
      />

      {/* HEADER STATUS */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={statCard}>
          <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>BALANCE EXCHANGE</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.mono, color: colors.textStrong, margin: "2px 0" }}>${fmt(report?.exchange.walletBalance ?? null)}</div>
          <div style={{ fontSize: 11, color: colors.textMuted }}>avail ${fmt(report?.exchange.availableBalance ?? null)}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>EQUITY DB</div>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: fonts.mono, color: colors.textStrong, margin: "2px 0" }}>${fmt(report?.db.equityUsd ?? null)}</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>EXCHANGE FEED</div>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: fonts.mono, margin: "2px 0", color: report?.exchange.status === "OK" ? colors.up : colors.down }}>
            {report?.exchange.status ?? "…"}
          </div>
          {report?.exchange.error && <div style={{ fontSize: 10, color: colors.down, maxWidth: 220 }}>{report.exchange.error}</div>}
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>ARM</div>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: fonts.mono, margin: "2px 0", color: report?.db.armed ? colors.up : colors.textMuted }}>
            {report?.db.armed ? "ON" : "OFF"}
          </div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 600, letterSpacing: "0.4px" }}>UPDATE</div>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: fonts.mono, color: colors.text, margin: "2px 0" }}>{updatedAt || "…"}</div>
        </div>
      </div>

      {error && (
        <div style={{ background: colors.downBg, border: `1px solid ${colors.down}`, borderRadius: 6, padding: "10px 14px", color: colors.down, fontSize: 12 }}>
          Gagal mengambil data: {error}
        </div>
      )}

      {/* CHART · terbuka saat baris posisi diklik */}
      {chart && (
        <Panel
          title={`CHART ${chart.symbol}`}
          extra={
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: chart.side === "LONG" ? colors.up : colors.down, fontWeight: 700, fontFamily: fonts.mono }}>
                {chart.side} x{fmt(chart.qty, 4)}
              </span>
              <span style={{ fontSize: 10.5, color: colors.textMuted }}>level ENTRY/SL/TP ada di strip chart di bawah</span>
              <Btn tone="ghost" onClick={() => setChart(null)}>TUTUP CHART</Btn>
            </span>
          }
          bodyStyle={{ padding: 0 }}
        >
          <div style={{ height: 460 }}>
            <TradingViewEmbed
              symbol={chart.symbol}
              timeframe="5"
              entryPrice={chart.entry}
              slPrice={chart.sl}
              tp1Price={chart.tp}
              posQty={chart.qty}
            />
          </div>
        </Panel>
      )}

      {/* TABEL POSISI */}
      <Panel title="POSISI · DB vs EXCHANGE (klik baris untuk buka chart)" bodyStyle={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={posTh}>SYMBOL</th>
                <th style={posTh}>SIDE</th>
                <th style={posTh}>QTY DB / EXCH</th>
                <th style={posTh}>ENTRY DB / EXCH</th>
                <th style={posTh}>SL / TP (DB)</th>
                <th style={posTh}>MARK (EXCH)</th>
                <th style={posTh}>LEV/MARGIN</th>
                <th style={posTh}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {(report?.positions ?? []).length === 0 && (
                <tr><td style={posTd} colSpan={8}>Tidak ada posisi terbuka (DB maupun exchange).</td></tr>
              )}
              {(report?.positions ?? []).map((p, i) => {
                const open = chart?.symbol === p.symbol;
                const side = p.db?.side ?? ((p.exchange?.positionAmt ?? 0) > 0 ? "LONG" : "SHORT");
                const sb = statusBadge(p.status);
                return (
                  <tr
                    key={p.symbol + i}
                    onClick={() => openChart(p)}
                    style={{
                      cursor: "pointer",
                      background: open ? colors.accentSoft : "transparent",
                      boxShadow: open ? `inset 2px 0 0 ${colors.accent}` : undefined,
                    }}
                  >
                    <td style={{ ...posTd, fontWeight: 700, color: colors.textStrong }}>
                      {open ? "▾ " : "▸ "}{p.symbol}
                    </td>
                    <td style={{ ...posTd, color: side === "LONG" ? colors.up : colors.down, fontWeight: 700 }}>{side}</td>
                    <td style={posTd}>{fmt(p.db?.qty ?? null, 4)} / {fmt(p.exchange ? Math.abs(p.exchange.positionAmt) : null, 4)}</td>
                    <td style={posTd}>{fmt(p.db?.entryPrice ?? null, 6)} / {fmt(p.exchange?.entryPrice ?? null, 6)}</td>
                    <td style={posTd}>{p.db ? `${fmt(p.db.slPrice, 6)} / ${fmt(p.db.tp1Price, 6)}` : "·"}</td>
                    <td style={posTd}>{fmt(p.exchange?.markPrice ?? null, 6)}</td>
                    <td style={posTd}>{p.exchange ? `${p.exchange.leverage ?? "?"}x ${p.exchange.marginType ?? "?"}` : "·"}</td>
                    <td style={posTd}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        background: sb.bg, color: sb.fg, letterSpacing: "0.4px", whiteSpace: "nowrap",
                      }}>{p.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* TABEL ORDER */}
      <Panel title="ORDER TERBUKA · DB vs EXCHANGE (SL algo & TP limit)" bodyStyle={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={posTh}>CLIENT ORDER ID</th>
                <th style={posTh}>DB: TYPE/SIDE/PRICE/QTY</th>
                <th style={posTh}>EXCHANGE: TYPE/PRICE/TRIGGER/QTY</th>
                <th style={posTh}>STATUS</th>
                <th style={posTh}>CATATAN</th>
              </tr>
            </thead>
            <tbody>
              {(report?.orders ?? []).length === 0 && (
                <tr><td style={posTd} colSpan={5}>Tidak ada order terbuka (DB maupun exchange).</td></tr>
              )}
              {(report?.orders ?? []).map((o, i) => {
                const sb = statusBadge(o.status);
                return (
                  <tr key={o.key + i}>
                    <td style={{ ...posTd, fontWeight: 600, color: colors.textStrong, fontSize: 11 }}>{o.key}</td>
                    <td style={posTd}>
                      {o.db ? `${o.db.type} ${o.db.side} ${o.db.price}${o.db.reduceOnly ? " (reduceOnly)" : ""} x${o.db.qty} [${o.db.status}]` : "·"}
                    </td>
                    <td style={posTd}>
                      {o.exchange
                        ? `${o.exchange.type}${o.exchange.kind === "ALGO" ? " (algo)" : ""} ${o.exchange.side} price ${fmt(o.exchange.price, 6)} trigger ${fmt(o.exchange.triggerPrice, 6)} x${fmt(o.exchange.qty, 4)} [${o.exchange.status}]`
                        : "·"}
                    </td>
                    <td style={posTd}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4,
                        background: sb.bg, color: sb.fg, letterSpacing: "0.4px", whiteSpace: "nowrap",
                      }}>{o.status}</span>
                    </td>
                    <td style={{ ...posTd, fontSize: 11, color: colors.textMuted, whiteSpace: "normal" }}>{o.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div style={{ fontSize: 10.5, color: colors.textMuted, fontFamily: fonts.mono }}>
        LIVE MIRROR • READ-ONLY • data langsung dari GET signed Binance (balance, positionRisk, openOrders, openAlgoOrders) + DB lokal •
        status HANYA_DB / HANYA_EXCHANGE = anomali yang perlu dicek manual • refresh otomatis 10 detik • klik baris posisi = buka chart
      </div>
    </div>
  );
}
