import type React from "react";

// ArtaTrade Tema B "X / ink" (29 Okt 2026): merah primer untuk brand/aksi,
// cyan untuk state aktif/info, profit = cyan, loss = merah.
export const colors = {
  bg: "#04050F",
  bgPanel: "#080A17",
  bgPanelHover: "#111427",
  bgInput: "#111427",
  border: "#161727",
  borderLight: "#262A44",
  text: "#DCE1F6",
  textMuted: "#97A7D0",
  textStrong: "#DCE1F6",
  textDim: "#5C6890",
  up: "#3AA8F2",
  upBg: "rgba(58,168,242,0.10)",
  down: "#F2414A",
  downBg: "rgba(242,65,74,0.10)",
  accent: "#E0222C",
  accentSoft: "rgba(224,34,44,0.10)",
  warn: "#D0628A",
  warnBg: "rgba(208,98,138,0.10)",
  sand: "#9AB2E4",
  sandBg: "rgba(154,178,228,0.10)",
  purple: "#9AB2E4",
  card: "#0C0E1E",
} as const;

export const fonts = {
  main: "'Inter', 'Geist', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Geist Mono', ui-monospace, monospace",
  disp: "'Noto Serif CJK JP', 'Noto Serif', serif",
} as const;

export const spacing = (n: number) => n * 4;

// Prototype card: #0C0E1E on 1px #262A44 hairline, 6px radius.
export const card: React.CSSProperties = {
  background: "#0C0E1E",
  border: `1px solid ${colors.borderLight}`,
  borderRadius: 6,
};

// Prototype section head: mono 10px, .16em tracking, uppercase, hairline under.
export const cardHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: `1px solid ${colors.border}`,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: "0.16em",
  color: colors.textMuted,
  textTransform: "uppercase",
  fontFamily: fonts.mono,
};

export const tableWrap: React.CSSProperties = { overflowX: "auto", width: "100%" };
export const table: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 11,
  fontFamily: fonts.mono,
};
export const th: React.CSSProperties = {
  padding: "7px 10px",
  textAlign: "left",
  color: colors.textDim,
  fontWeight: 500,
  fontSize: 9,
  letterSpacing: "0.14em",
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: "nowrap",
  textTransform: "uppercase",
};
export const td: React.CSSProperties = {
  padding: "7px 10px",
  color: colors.text,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: "nowrap",
};

export const pctColor = (v: number) => (v > 0 ? colors.up : v < 0 ? colors.down : colors.textMuted);
export const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export const badge = (bg: string, fg: string): React.CSSProperties => ({
  fontSize: 10,
  fontWeight: 500,
  padding: "2px 8px",
  borderRadius: 0,
  background: bg,
  color: fg,
  letterSpacing: "0.1em",
  whiteSpace: "nowrap",
  fontFamily: fonts.mono,
});
