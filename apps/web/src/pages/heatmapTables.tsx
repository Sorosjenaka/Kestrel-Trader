// apps/web/src/pages/heatmapTables.tsx
// 24 Okt 2026 — bagian "tabel" dari dashboard mikrostruktur yang dipisah
// supaya bisa diuji langsung (renderToStaticMarkup) tanpa membuka SSE.
//
// Alasan pemisahan: BUG kolom kosong pada tabel divergensi (nama field API
// sebenarnya buyerExchange/sellerExchange/spreadUsd, bukan exchangeA/
// exchangeB/note) DAN cluster likuidasi yang tidak pernah ditampilkan —
// keduanya adalah bagian yang paling sulit dideteksi kalau hanya lewat
// pemeriksaan visual.

import { colors, fonts } from "../theme.js";

// ── Formatter (diekspor agar konsisten di seluruh dashboard) ───────────────

export const fmtUsd = (n: number) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "·";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

/** Versi penuh (tanpa pembulatan K/M) — untuk tooltip & tabel angka. */
export const fmtUsdFull = (n: number) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "·";
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

/**
 * Nilai bertanda. Tanda_minus diletakkan SEBELUM simbol dolar ("-$1.20M"),
 * bukan sesudahnya ("$-1.20M") — yang terakhir jauh lebih sulit dibaca sekilas.
 */
export const fmtSigned = (n: number) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "·";
  if (v === 0) return "$0";
  return `${v > 0 ? "+" : "-"}${fmtUsd(Math.abs(v))}`;
};

export const fmtPrice = (n: number | null) =>
  n == null ? "·" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export const fmtPct = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(Number(n)) ? "·" : `${Number(n).toFixed(digits)}%`;

/**
 * 25 Okt 2026 — guard "Invalid time value". Frame SSE/REST bisa datang
 * dengan field waktu kosong (undefined/null/NaN) sesaat setelah backend
 * restart; `new Date(undefined).toISOString()` melempar RangeError dan
 * mematikan SELURUH halaman. Sekarang kembali "—".
 */
export const hhmmss = (t: number | null | undefined) => {
  const d = new Date(Number(t));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 19) : "·";
};
export const hhmm = (t: number | null | undefined) => {
  const d = new Date(Number(t));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) : "·";
};

/** Warna tanda tema B: cyan = net buy, merah = net sell. */
export const signColor = (n: number) => (n > 0 ? colors.up : n < 0 ? colors.down : colors.textMuted);

// ── Gaya tabel (satu sumber kebenaran untuk semua tabel dashboard) ─────────

export const TH = {
  padding: "6px 8px", textAlign: "left" as const, color: colors.textMuted,
  fontWeight: 700, fontSize: 10.5, letterSpacing: "0.07em",
  borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap" as const,
};
export const TD = {
  padding: "5px 8px", fontSize: 12, borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap" as const,
};
export const TD_R = { ...TD, textAlign: "right" as const };
export const TH_R = { ...TH, textAlign: "right" as const };

/** Baris keterangan: label kiri, nilai kanan (rata kanan, tabular). */
export function KeyRow({ label, value, color, mono = true }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, lineHeight: 1.85 }}>
      <span style={{ color: colors.textMuted, fontFamily: mono ? fonts.mono : fonts.main }}>{label}</span>
      <span style={{ color: color ?? colors.text, fontWeight: 700, fontFamily: mono ? fonts.mono : fonts.main }}>{value}</span>
    </div>
  );
}

// ── Tabel divergensi antar exchange ────────────────────────────────────────

export interface DivergenceRow {
  t: number;
  buyerExchange: string;
  buyerDelta: number;
  sellerExchange: string;
  sellerDelta: number;
  spreadUsd: number;
}

/**
 * Tabel divergensi: dua exchange berlawanan arah.
 *
 * PERBAIKAN BUG 24 Okt 2026: versi lama membaca `a.exchangeA`,
 * `a.exchangeB`, `a.note` —_field yang TIDAK ADA di API_ sehingga ketiga
 * kolom render kosong. Field sebenarnya: buyerExchange, sellerExchange,
 * buyerDelta, sellerDelta, spreadUsd.
 */
export function DivergenceTable({ alerts, minSpreadUsd }: { alerts: DivergenceRow[]; minSpreadUsd?: number }) {
  if (!alerts.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
        DIVERGensi ANTAR EXCHANGE (beda arah, selisih ≥ {minSpreadUsd != null ? fmtUsd(minSpreadUsd) : "·"})
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: fonts.mono }}>
          <thead>
            <tr>
              <th style={TH}>WAKTU</th>
              <th style={TH}>PEMBELI (NET BUY)</th>
              <th style={TH_R}>DELTA</th>
              <th style={TH}>PENAJUAL (NET SELL)</th>
              <th style={TH_R}>DELTA</th>
              <th style={TH_R}>SELISIH</th>
            </tr>
          </thead>
          <tbody>
            {alerts.slice(0, 8).map((a, i) => (
              <tr key={`${a.t}-${i}`}>
                <td style={{ ...TD, color: colors.textMuted }}>{hhmmss(a.t)}</td>
                <td style={{ ...TD, color: colors.up, fontWeight: 700 }}>{a.buyerExchange}</td>
                <td style={{ ...TD_R, color: colors.up }}>{fmtSigned(a.buyerDelta)}</td>
                <td style={{ ...TD, color: colors.down, fontWeight: 700 }}>{a.sellerExchange}</td>
                <td style={{ ...TD_R, color: colors.down }}>{fmtSigned(a.sellerDelta)}</td>
                <td style={{ ...TD_R, color: colors.warn, fontWeight: 700 }}>{fmtUsd(a.spreadUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Cluster likuidasi teratas ──────────────────────────────────────────────

export interface ClusterRow {
  price: number;
  distPct: number;
  liqUsd: number;
  positions: number;
}

/**
 * Dua kolom cluster likuidasi teratas.
 * PERBAIKAN 24 Okt 2026: `topLongClustersBelow` / `topShortClustersAbove`
 * ada di API tapi TIDAK PERNAH ditampilkan — magnet likuidasi yang
 * sebenarnya bisa dilihat, disembunyikan.
 */
export function ClusterColumns({ below, above }: { below: ClusterRow[]; above: ClusterRow[] }) {
  if (!below.length && !above.length) return null;
  return (
    <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px" }}>
        <div style={{ fontSize: 11, color: colors.down, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
          ▼ CLUSTER LONG TERBESAR (DI BAWAH MARK)
        </div>
        {below.length === 0 && (
          <div style={{ fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono }}>Tidak ada cluster long.</div>
        )}
        {below.map((c, i) => (
          <KeyRow key={i} label={`${fmtPrice(c.price)}  (${fmtPct(c.distPct, 2)})`} value={fmtUsd(c.liqUsd)} color={colors.down} />
        ))}
      </div>
      <div style={{ flex: "1 1 320px" }}>
        <div style={{ fontSize: 11, color: colors.up, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
          ▲ CLUSTER SHORT TERBESAR (DI ATAS MARK)
        </div>
        {above.length === 0 && (
          <div style={{ fontSize: 11.5, color: colors.textMuted, fontFamily: fonts.mono }}>Tidak ada cluster short.</div>
        )}
        {above.map((c, i) => (
          <KeyRow key={i} label={`${fmtPrice(c.price)}  (${fmtPct(c.distPct, 2)})`} value={fmtUsd(c.liqUsd)} color={colors.up} />
        ))}
      </div>
    </div>
  );
}

// ── Tabel akumulasi likuidasi per pita ─────────────────────────────────────

export function LiqCumTable({ cum }: { cum: { pct: number; longsUsd: number; shortsUsd: number; skewPct: number }[] }) {
  if (!cum.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono, fontWeight: 700, letterSpacing: "0.08em", marginBottom: 6 }}>
        AKUMULASI PER PITA
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: fonts.mono }}>
          <thead>
            <tr>
              <th style={TH}>PITA</th>
              <th style={TH_R}>LONG</th>
              <th style={TH_R}>SHORT</th>
              <th style={TH_R}>SKEW</th>
              <th style={TH_R}>DOMINAN</th>
            </tr>
          </thead>
          <tbody>
            {cum.map((c) => (
              <tr key={c.pct}>
                <td style={{ ...TD, color: colors.text, fontWeight: 700 }}>±{c.pct}%</td>
                <td style={{ ...TD_R, color: colors.down }}>{fmtUsd(c.longsUsd)}</td>
                <td style={{ ...TD_R, color: colors.up }}>{fmtUsd(c.shortsUsd)}</td>
                <td style={{ ...TD_R, color: colors.text }}>{fmtPct(c.skewPct)}</td>
                <td style={{ ...TD_R, color: c.skewPct > 0 ? colors.down : c.skewPct < 0 ? colors.up : colors.textMuted, fontWeight: 700 }}>
                  {c.skewPct > 0 ? "LONG" : c.skewPct < 0 ? "SHORT" : "SEIMBANG"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
