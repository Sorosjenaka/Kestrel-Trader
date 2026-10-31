// apps/web/src/components/AnalysisPanel.tsx - Panel analisis market flow.
// 23 Okt 2026 (Tahap 8). Read-only: hanya membaca /api/analysis/*.
//
// Bahasa UI: STATUS / ALASAN / PEMICU / BATAL — tanpa "confidence 87%".
// Setiap angka yang TIDAK ADA ditampilkan sebagai "—", bukan 0.

import React, { useEffect, useMemo, useState } from "react";

interface DeltaWindow {
  window: string;
  buyNotional: number;
  sellNotional: number;
  buyRatio: number | null;
  totalNotional: number;
  tradeCount: number;
  deltaNotional: number;
  cvdSession: number | null;
  rollingDelta: number;
  warmup: boolean;
  reconnectCount: number;
}
interface DataStatusInfo {
  status: string; ageMs: number | null; ttlMs: number;
  missing: string[]; present: string[]; reason: string | null;
}
interface Snapshot {
  snapshotId: string;
  builtAt: number;
  instrument: { venue: string; marketType: string; instrumentId: string; base: string; quote: string; contractType: string };
  dataStatus: Record<string, DataStatusInfo>;
  coverage: Record<string, { present: number; total: number }>;
  features: {
    deltaByWindow: Record<string, DeltaWindow>;
    deltaByVenue?: Record<string, Record<string, DeltaWindow>>;
    bookBand: unknown | null;
    liquidationEvent: unknown | null;
    positionLevelMap: unknown | null;
    oiFunding: {
      venue: string; symbol: string;
      openInterest: number; openInterestContracts: number | null;
      openInterestUsdChange: number | null;
      fundingRate: number | null; fundingIntervalMinutes: number | null;
      fundingNextAt: number | null; capturedAt: number;
    } | null;
  };
  limitations: string[];
  influenceTrading: boolean;
  serviceStarted: boolean;
}

const VENUE_LABEL: Record<string, string> = {
  BINANCE: "BINANCE",
  HYPERLIQUID: "HYPERLIQUID",
  COINBASE: "COINBASE",
};
/**
 * Venue yang hanya memberi MAKER side (bukan taker). Delta-nya proksi taker,
 * jadi harus diberi label eksplisit di UI — bukan disamakan dengan taker.
 */
const MAKER_SIDE_VENUES = new Set(["COINBASE"]);

const STATUS_UI: Record<string, { label: string; color: string; icon: string }> = {
  LOADING: { label: "MEMUAT", color: "var(--text-muted)", icon: "◌" },
  WARMUP: { label: "PEMANASAN", color: "var(--info)", icon: "◐" },
  COMPLETE: { label: "LENKAP", color: "var(--up)", icon: "●" },
  PARTIAL: { label: "SEBAGIAN", color: "var(--warn)", icon: "◐" },
  STALE: { label: "BASI", color: "var(--warn)", icon: "◔" },
  DISCONNECTED: { label: "TERPUTUS", color: "var(--down)", icon: "○" },
  UNSUPPORTED: { label: "TIDAK DIDUKUNG", color: "var(--text-muted)", icon: "·" },
  NO_DATA: { label: "TIDAK ADA DATA", color: "var(--text-muted)", icon: "·" },
};

const WINDOW_ORDER = ["5m", "15m", "1h", "4h"];
const WINDOW_LABEL: Record<string, string> = {
  "5m": "5 MENIT", "15m": "15 MENIT", "1h": "1 JAM", "4h": "4 JAM",
};

/** Format USD ringkas. 0 pada input yang valid tetap tampil $0 (bukan "—"). */
function fmtUsd(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "·";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(digits)}`;
}
/**
 * Format bilangan bulat dengan pemisah ribuan gaya trading (koma).
 * "1,878" — bukan "1.878" yang bisa salah dibaca sebagai 1.878 (=desimal
 * dalam bahasa Indonesia). IniUI${\an} trading, bukan teks biasa.
 */
function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "·";
  return Math.round(v).toLocaleString("en-US");
}
function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "·";
  return `${(v * 100).toFixed(1)}%`;
}
function age(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "·";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  return `${Math.round(s / 3600)} jam`;
}

/** Bar imbalance: visual proporsi beli vs jual agresif. */
function DeltaBar({ buy, sell, warmup }: { buy: number; sell: number; warmup: boolean }) {
  const total = buy + sell;
  if (total <= 0) return <div className="delta-bar empty"><i /></div>;
  const buyPct = (buy / total) * 100;
  return (
    <div className={`delta-bar${warmup ? " warming" : ""}`} title={warmup ? "Histori belum menutup jendela ini" : undefined}>
      <i className="buy" style={{ width: `${buyPct}%` }} />
      <i className="sell" style={{ width: `${100 - buyPct}%` }} />
    </div>
  );
}

export function AnalysisPanel() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/analysis/snapshot", { cache: "no-store" });
        if (!r.ok) throw new Error(`snapshot ${r.status}`);
        const j = (await r.json()) as Snapshot;
        if (alive) { setSnap(j); setErr(null); }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const feedStatus = useMemo(() => {
    const out: { key: string; info: DataStatusInfo }[] = [];
    for (const [k, v] of Object.entries(snap?.dataStatus ?? {})) out.push({ key: k, info: v });
    return out;
  }, [snap]);

  if (loading && !snap) {
    return <div className="analysis-panel"><div className="ledger-empty">Memuat data analisis…</div></div>;
  }
  if (err && !snap) {
    return <div className="analysis-panel"><div className="ledger-empty">Data analisis tidak terbaca: {err}</div></div>;
  }
  if (!snap) return null;

  const deltas = snap.features.deltaByWindow ?? {};
  const present = WINDOW_ORDER.filter((w) => deltas[w]);
  const cvdUnavailable = present.length > 0 && present.every((w) => deltas[w]!.cvdSession === null);
  // Jendela yang isinya identik = feed belum cukup lama untuk memisahkannya.
  const identicalWindows = present.length > 1 &&
    present.every((w) => deltas[w]!.tradeCount === deltas[present[0]!]!.tradeCount);

  // Per venue: untuk perbandingan cross-venue.
  const byVenue = snap.features.deltaByVenue ?? {};
  const venueKeys = Object.keys(byVenue);
  const venueRows = venueKeys.map((k) => {
    const parts = k.split(":");
    return { key: k, venue: parts[0] ?? k, market: parts[1] ?? "", symbol: parts[2] ?? "" };
  });
  const oi = snap.features.oiFunding;

  return (
    <section className="analysis-panel" aria-label="Analisis market flow">
      <header className="analysis-head">
        <div>
          <div className="analysis-title">ANALISIS ALIRAN PASAR</div>
          <div className="analysis-sub">
            {snap.instrument.venue} · {snap.instrument.instrumentId} · {snap.instrument.contractType}
          </div>
        </div>
        <div className="analysis-head-right">
          <span className={`context-pill ${snap.influenceTrading ? "paper" : "locked"}`}>
            PENGARUH TRADING: {snap.influenceTrading ? "MENYALA" : "MATI"}
          </span>
          <span className="mono tiny muted">BUILD {new Date(snap.builtAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })} WIB</span>
        </div>
      </header>

      {/* Status data per feed */}
      <div className="analysis-feeds">
        {feedStatus.length === 0 && <span className="muted tiny">Belum ada feed aktif (ANALYTICS_ENABLED=false).</span>}
        {feedStatus.map(({ key, info }) => {
          const ui = STATUS_UI[info.status] ?? STATUS_UI.NO_DATA!;
          return (
            <div key={key} className="feed-chip" style={{ borderColor: ui.color }}>
              <i style={{ color: ui.color }}>{ui.icon}</i>
              <div>
                <b style={{ color: ui.color }}>{ui.label}</b>
                <span>{key} · {age(info.ageMs)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {identicalWindows && (
        <p className="analysis-note">
          Keempat jendela menunjukkan angka yang sama karena feed baru berjalan sebentar ·
          historinya belum cukup panjang untuk memisahkan jendela 5 menit dari 1 jam. Angka akan
          berbeda sendiri setelah feed berjalan lebih lama.
        </p>
      )}

      {/* Matriks perbandingan lintas jendela */}
      {present.length > 0 && (
        <div className="analysis-matrix-wrap">
          <table className="analysis-matrix">
            <caption className="sr-only">Perbandingan metrik aliran pasar antar jendela waktu</caption>
            <thead>
              <tr>
                <th scope="col">METRIK</th>
                {present.map((w) => (
                  <th key={w} scope="col" className="num">{WINDOW_LABEL[w]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {([
                ["DELTA AGRESIF", (d: DeltaWindow) => (
                  <span className={d.rollingDelta > 0 ? "up" : d.rollingDelta < 0 ? "down" : "muted"}>
                    {d.rollingDelta > 0 ? "+" : ""}{fmtUsd(d.rollingDelta)}
                  </span>
                )],
                ["BELI AGRESIF", (d: DeltaWindow) => <span className="up">{fmtUsd(d.buyNotional)}</span>],
                ["JUAL AGRESIF", (d: DeltaWindow) => <span className="down">{fmtUsd(d.sellNotional)}</span>],
                ["RASIO BELI", (d: DeltaWindow) => fmtPct(d.buyRatio)],
                ["TRANSAKSI", (d: DeltaWindow) => fmtCount(d.tradeCount)],
                ["VOLUME", (d: DeltaWindow) => fmtUsd(d.totalNotional)],
                ["CVD SESI", (d: DeltaWindow) => (
                  d.cvdSession === null
                    ? <span className="muted">TIDAK TERSEDIA</span>
                    : <span className={d.cvdSession > 0 ? "up" : "down"}>{fmtUsd(d.cvdSession)}</span>
                )],
                ["KELENGKAPAN", (d: DeltaWindow) => (
                  d.warmup ? <span className="window-flag">PEMANASAN</span> : <span className="ok-flag">TERLENGKAP</span>
                )],
              ] as [string, (d: DeltaWindow) => React.ReactNode][]).map(([label, render]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {present.map((w) => <td key={w} className="num">{render(deltas[w]!)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Rincian per jendela */}
      <div className="analysis-windows">
        {WINDOW_ORDER.map((w) => {
          const d = deltas[w];
          if (!d) {
            return (
              <div key={w} className="window-card empty">
                <div className="window-label">{WINDOW_LABEL[w]}</div>
                <div className="ledger-empty small">Belum ada data.</div>
              </div>
            );
          }
          const net = d.rollingDelta;
          const netColor = net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : "var(--text-muted)";
          return (
            <div key={w} className={`window-card${d.warmup ? " warming" : ""}`}>
              <div className="window-label">
                <b>{WINDOW_LABEL[w]}</b>
                {d.warmup
                  ? <span className="window-flag">PEMANASAN</span>
                  : <span className="ok-flag">TERLENGKAP</span>}
              </div>
              <div className="window-delta" style={{ color: netColor }}>
                {net > 0 ? "+" : ""}{fmtUsd(net)}
              </div>
              <div className="window-caption">DELTA AGRESIF · NET BUY MINUS SELL</div>
              <DeltaBar buy={d.buyNotional} sell={d.sellNotional} warmup={d.warmup} />
              <dl className="window-stats">
                <div><dt>BELI AGRESIF</dt><dd className="up">{fmtUsd(d.buyNotional)}</dd></div>
                <div><dt>JUAL AGRESIF</dt><dd className="down">{fmtUsd(d.sellNotional)}</dd></div>
                <div><dt>RAZIO BELI</dt><dd>{fmtPct(d.buyRatio)}</dd></div>
                <div><dt>TRANSAKSI</dt><dd>{fmtCount(d.tradeCount)}</dd></div>
                <div><dt>VOLUME</dt><dd>{fmtUsd(d.totalNotional)}</dd></div>
                <div>
                  <dt>CVD SESI</dt>
                  <dd className={d.cvdSession === null ? "muted" : (d.cvdSession > 0 ? "up" : "down")}>
                    {d.cvdSession === null ? "TIDAK TERSEDIA" : fmtUsd(d.cvdSession)}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      {cvdUnavailable && (
        <p className="analysis-note">
          CVD sesi belum dihitung untuk jendela mana pun: pengamatan belum mencakup awal sesi WIB
          (00:00). Angka delta antar jendela tetap sahih karena diukur utuh di dalam jendela.
        </p>
      )}

      {oi && (
        <div className="analysis-oi">
          <div className="analysis-oi-head">
            <div className="eyebrow">POSISI TERBUKA &amp; FUNDING</div>
            <span className="mono tiny muted">{oi.venue} · {oi.symbol}</span>
          </div>
          <dl className="analysis-oi-grid">
            <div>
              <dt>OPEN INTEREST</dt>
              <dd className="num">{fmtUsd(oi.openInterest)}</dd>
              <dd className="tiny muted sub">
                {oi.openInterestContracts !== null
                  ? `${fmtCount(oi.openInterestContracts)} kontrak`
                  : "jumlah kontrak tidak tersedia"}
              </dd>
            </div>
            <div>
              <dt>FUNDING</dt>
              <dd className={`num ${oi.fundingRate !== null && oi.fundingRate > 0 ? "up" : oi.fundingRate !== null && oi.fundingRate < 0 ? "down" : "muted"}`}>
                {oi.fundingRate !== null ? `${(oi.fundingRate * 100).toFixed(4)}%` : "·"}
              </dd>
              <dd className="tiny muted sub">
                {oi.fundingIntervalMinutes !== null ? `per ${oi.fundingIntervalMinutes} menit` : "periode tidak diketahui"}
              </dd>
            </div>
            <div>
              <dt>PERUBAHAN OI</dt>
              <dd className={`num ${oi.openInterestUsdChange !== null ? "" : "absent"}`}>
                {oi.openInterestUsdChange !== null ? fmtUsd(oi.openInterestUsdChange) : "TIDAK TERSEDIA"}
              </dd>
              <dd className="tiny muted sub">perubahan jumlah kontrak tidak dibedakan dari perubahan harga</dd>
            </div>
          </dl>
        </div>
      )}

      {/* Perbandingan antar venue */}
      {venueRows.length > 1 && (
        <div className="analysis-matrix-wrap">
          <table className="analysis-matrix">
            <caption className="sr-only">Perbandingan delta antar venue untuk jendela 15 menit</caption>
            <thead>
              <tr>
                <th scope="col">VENUE</th>
                <th scope="col" className="num">DELTA 15M</th>
                <th scope="col" className="num">RASIO BELI</th>
                <th scope="col" className="num">TRANSAKSI</th>
                <th scope="col" className="num">VOLUME</th>
                <th scope="col">SISI AGRESOR</th>
              </tr>
            </thead>
            <tbody>
              {venueRows.map((v) => {
                const w = byVenue[v.key]?.["15m"];
                return (
                  <tr key={v.key}>
                    <th scope="row">
                      {VENUE_LABEL[v.venue] ?? v.venue}
                      <span className="tiny muted venue-sub">{v.market}</span>
                    </th>
                    <td className="num">
                      {w ? (
                        <span className={w.rollingDelta > 0 ? "up" : w.rollingDelta < 0 ? "down" : "muted"}>
                          {w.rollingDelta > 0 ? "+" : ""}{fmtUsd(w.rollingDelta)}
                        </span>
                      ) : "·"}
                    </td>
                    <td className="num">{w ? fmtPct(w.buyRatio) : "·"}</td>
                    <td className="num">{w ? fmtCount(w.tradeCount) : "·"}</td>
                    <td className="num">{w ? fmtUsd(w.totalNotional) : "·"}</td>
                    <td>
                      {MAKER_SIDE_VENUES.has(v.venue)
                        ? <span className="window-flag">PROKSI TAKER (MAKER SIDE)</span>
                        : <span className="ok-flag">TAKER ASLI</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="analysis-note">
            Angka antar venue TIDAK dijumlahkan: cakupan likuiditas dan definisi sisi agresor berbeda.
            Venue berlabel proksi taker hanya memberi sisi maker, sehingga nilainya tidak sebanding
            langsung dengan venue yang memberi sisi taker.
          </p>
        </div>
      )}

      {/* Cakupan & batasan · wajib terlihat, jangan disembunyikan */}
      <div className="analysis-limits">
        <div className="eyebrow">CAKUPAN &amp; BATASAN</div>
        <ul>
          {Object.entries(snap.coverage).map(([k, v]) => (
            <li key={k}>
              {k}: {v.total > 0 ? `${v.present}/${v.total}` : "denominator tidak diketahui"} · bukan 100%
            </li>
          ))}
          {snap.limitations.map((l, i) => <li key={`lim-${i}`}>{l}</li>)}
        </ul>
      </div>
    </section>
  );
}
