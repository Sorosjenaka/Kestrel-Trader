// apps/web/src/components/ui.tsx
// Primitive operator-console UI. Keep the public API used by all pages stable.
import React from "react";
import { colors, fonts, card, cardHead } from "../theme.js";

export function Panel({ title, extra, children, style, bodyStyle }: {
  title?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", minWidth: 0, ...style }}>
      {title && (
        <div style={cardHead}>
          <span>{title}</span>
          {extra}
        </div>
      )}
      <div style={{ padding: title ? "10px 12px" : 0, flex: 1, minWidth: 0, ...bodyStyle }}>{children}</div>
    </section>
  );
}

export function Badge({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 8px", borderRadius: 3, background: bg, color: fg, letterSpacing: "0.05em", whiteSpace: "nowrap", fontFamily: fonts.mono }}>
      {children}
    </span>
  );
}

export function Delta({ value, suffix = "%", digits = 2 }: { value: number; suffix?: string; digits?: number }) {
  const color = value > 0 ? colors.up : value < 0 ? colors.down : colors.textMuted;
  return (
    <span style={{ color, fontFamily: fonts.mono, fontWeight: 600 }}>
      {value > 0 ? "+" : ""}{value.toFixed(digits)}{suffix}
    </span>
  );
}

export function StatCell({ label, value, sub, valueColor }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; valueColor?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: colors.textMuted, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 650, fontFamily: fonts.mono, color: valueColor ?? colors.textStrong, margin: "3px 0 1px", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: colors.textMuted }}>{sub}</div>}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "18px 2px", color: colors.textMuted, fontSize: 12 }}>{children}</div>;
}

export function Btn({ onClick, children, tone = "default", disabled, title }: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "default" | "primary" | "danger" | "ghost";
  disabled?: boolean;
  title?: string;
}) {
  const tones: Record<string, React.CSSProperties> = {
    default: { background: colors.bgInput, color: colors.text, border: `1px solid ${colors.borderLight}` },
    primary: { background: colors.accent, color: "#07110d", border: "1px solid transparent" },
    danger: { background: colors.down, color: "#1a0707", border: "1px solid transparent" },
    ghost: { background: "transparent", color: colors.textMuted, border: `1px solid ${colors.border}` },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{ fontSize: 12, fontWeight: 600, padding: "8px 12px", borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, fontFamily: fonts.main, lineHeight: 1.2, ...tones[tone] }}
    >
      {children}
    </button>
  );
}

export function Select({ value, onChange, children, style }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ background: colors.bgInput, color: colors.text, border: `1px solid ${colors.borderLight}`, padding: "6px 8px", fontSize: 12, borderRadius: 6, fontFamily: fonts.main, ...style }}
    >
      {children}
    </select>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{ background: colors.bgInput, color: colors.textStrong, border: `1px solid ${colors.borderLight}`, padding: "6px 9px", fontSize: 12, borderRadius: 6, outline: "none", fontFamily: fonts.main, ...(props.style ?? {}) }}
    />
  );
}

export function PageHead({ title, desc, right, eyebrow }: { title: string; desc?: string; right?: React.ReactNode; eyebrow?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
      <div>
        {eyebrow && <div style={{ fontSize: 10, color: colors.textDim, fontFamily: fonts.mono, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 6 }}>{eyebrow}</div>}
        <h1 className="pagehead-title" style={{ margin: 0, fontSize: 26, color: colors.textStrong, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: fonts.disp, textTransform: "uppercase" }}>{title}</h1>
        {desc && <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 6, lineHeight: 1.45, maxWidth: 820 }}>{desc}</div>}
      </div>
      {right && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{right}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: Array<{ id: T; label: string; note?: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2, borderBottom: `1px solid ${colors.border}`, marginBottom: 12, overflowX: "auto" }}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            className={`subtab${active ? " active" : ""}`}
            onClick={() => onChange(t.id)}
            style={{
              appearance: "none", background: "transparent", border: 0,
              color: active ? colors.textStrong : colors.textMuted,
              fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
              padding: "9px 11px", cursor: "pointer", fontFamily: fonts.mono, whiteSpace: "nowrap",
            }}
          >
            {t.label}
            {t.note && <span style={{ color: active ? colors.accent : colors.textMuted, marginLeft: 7, fontWeight: 500 }}>{t.note}</span>}
          </button>
        );
      })}
    </div>
  );
}
