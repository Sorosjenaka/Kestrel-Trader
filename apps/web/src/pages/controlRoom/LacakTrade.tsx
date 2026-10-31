// apps/web/src/pages/controlRoom/LacakTrade.tsx
// 29 Okt 2026 · Tahap 5 redesign Tema B — timeline satu trade (READ-ONLY).
//
// Sumber: EventLog via snapshot Control Room (/api/events sudah diadaptasi di
// controlRoomAdapter). DecisionLog per-trade BELUM terekspos sebagai endpoint
// (hanya agregat di /api/research/market-monitor), sesuai brief bagian 8:
// "kalau tidak ada, Lacak Trade memakai EventLog saja dan tandai 'detail
// keputusan butuh tahap 7'".
//
// Tidak ada tombol mutasi di sini: murni membaca dan menampilkan.
import { useEffect, useMemo, useState } from "react";
import { colors, fonts } from "../../theme.js";
import type { ControlEvent, ControlSnapshot } from "../../lib/controlRoomAdapter.js";
import { useMarkPrices } from "../../lib/useMarkPrices.js";
import { FlashValue } from "../../components/FlashValue.js";
import { FeedBadge } from "../../components/FeedBadge.js";

/** Baris posisi OPEN dari /api/positions (read-only, subset yang dipakai). */
interface OpenPosition {
  id: number; symbol: string; side: string; qty: number; entryPrice: number;
  markPrice?: number | null; slPrice?: number | null; tp1Price?: number | null;
  leverage?: number | null; marginUsd?: number | null; status?: string;
}

/** Tahapan pipeline sesuai brief: scanner → analis → thesis → referee → judge → council → exec → posisi. */
const STAGES: Array<{ key: string; label: string; actors: string[]; types: string[] }> = [
  { key: "scanner", label: "SCANNER", actors: ["scanner", "scanner-supervisor"], types: ["SCAN_CANDIDATE", "SCAN_SKIP"] },
  { key: "analis", label: "ANALIS", actors: ["macro-scout", "regime-analyst", "market-context", "signal-analyst", "funnel-analyst"], types: ["AGENT_DIALOG"] },
  { key: "thesis", label: "THESIS ARENA", actors: ["thesis-long", "thesis-short"], types: ["THESIS_ARENA", "DIRECTION_BATTLE"] },
  { key: "referee", label: "REFEREE", actors: ["thesis-referee"], types: [] },
  { key: "judge", label: "JUDGES", actors: ["setup-judge", "drex"], types: ["DREX_SWING_SHADOW_COMPARE", "LLM_SWEEP_VERDICT"] },
  { key: "council", label: "COUNCIL / RISK", actors: ["risk-officer", "daily-guard"], types: ["COUNCIL_DECISION"] },
  { key: "exec", label: "EXEC", actors: ["order-executor", "position-supervisor", "trade-supervisor"], types: ["ORDER_SUBMITTED", "ORDER_FILLED"] },
  { key: "posisi", label: "POSISI", actors: [], types: ["POSITION_OPENED", "SL_MOVED_BE", "EXIT_FILL_APPLIED", "POSITION_CLOSED"] },
];

function stageOf(event: ControlEvent): string {
  for (const s of STAGES) {
    if (s.actors.includes(event.actorId)) return s.key;
    if (s.types.some((t) => event.type.startsWith(t))) return s.key;
  }
  return "analis";
}

const stageLabel = (key: string) => STAGES.find((s) => s.key === key)?.label ?? key.toUpperCase();

function eventTime(at: string): string {
  try {
    return new Date(at).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "·";
  }
}

export function LacakTrade({ snapshot, target, onChangeTarget, onClose }: {
  snapshot: ControlSnapshot;
  /** Simbol atau traceId yang sedang di-lacak. */
  target: string;
  onChangeTarget: (t: string) => void;
  onClose: () => void;
}) {
  // Simbol target (bila operator mengetik simbol, bukan trace id).
  const symbolTarget = /^[A-Z0-9]{3,20}$/i.test(target.trim()) ? target.trim().toUpperCase() : "";
  const [pos, setPos] = useState<OpenPosition | null>(null);

  // Inspector posisi Control Room: bila target adalah simbol yang sedang OPEN,
  // tampilkan level + uPnL/ROI realtime. READ-ONLY (GET saja), refresh 15 dtk —
  // sengaja lambat supaya tidak membebani endpoint posisi.
  useEffect(() => {
    if (!symbolTarget) {
      setPos(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/positions?status=OPEN&symbol=${encodeURIComponent(symbolTarget)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;
        const hit = (data?.positions ?? []).find((p: OpenPosition) => p.symbol === symbolTarget && p.status === "OPEN");
        setPos(hit ?? null);
      } catch {
        /* data lama dipertahankan; kartu hilang bila tidak ada posisi */
      }
    };
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [symbolTarget]);

  const { marks, status } = useMarkPrices(symbolTarget ? [symbolTarget] : []);

  const livePos = useMemo(() => {
    if (!pos) return null;
    const mark = marks.get(pos.symbol)?.mark ?? (Number(pos.markPrice) > 0 ? Number(pos.markPrice) : null);
    const qty = Number(pos.qty);
    const pnl = mark != null && Number.isFinite(qty)
      ? (pos.side === "LONG" ? mark - pos.entryPrice : pos.entryPrice - mark) * qty
      : null;
    const margin = Number(pos.marginUsd);
    const roi = pnl != null && Number.isFinite(margin) && margin > 0 ? (pnl / margin) * 100 : null;
    return { ...pos, mark, pnl, roi };
  }, [pos, marks]);

  // Filter EventLog: cocok traceId ATAU symbol (payload). Urut naik waktu.
  const trace = useMemo(() => {
    const q = target.trim().toLowerCase();
    if (!q) return [];
    return snapshot.events
      .filter((e) =>
        (e.traceId ?? "").toLowerCase().includes(q) ||
        (e.symbol ?? "").toLowerCase() === q ||
        e.message.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.at.localeCompare(b.at));
  }, [snapshot.events, target]);

  const byStage = useMemo(() => {
    const map = new Map<string, ControlEvent[]>();
    for (const e of trace) {
      const key = stageOf(e);
      const list = map.get(key) ?? [];
      list.push(e);
      map.set(key, list);
    }
    return map;
  }, [trace]);

  // Simbol unik untuk pilihan cepat dari event yang ada.
  const symbols = useMemo(() => {
    const set = new Set<string>();
    for (const e of snapshot.events) if (e.symbol) set.add(e.symbol);
    return [...set].sort();
  }, [snapshot.events]);

  return (
    <section className="lacak-trade" aria-label="Lacak trade (read-only)">
      <div className="lacak-head">
        <div>
          <div className="control-crumb">CONTROL ROOM / LACAK TRADE</div>
          <h2 style={{ margin: "6px 0 0", font: `700 22px ${fonts.disp}`, color: colors.textStrong, letterSpacing: "-0.02em", textTransform: "uppercase" }}>
            Jejak Trade
          </h2>
          <p style={{ margin: "6px 0 0", fontSize: 12, color: colors.textMuted, lineHeight: 1.5, maxWidth: 640 }}>
            Timeline satu trade dari EventLog: scanner → analis → thesis → referee → judge → council → exec → posisi.
            Detail keputusan per-trade (DecisionLog) butuh tahap 7. Semua tampilan read-only.
          </p>
        </div>
        <button className="control-refresh" onClick={onClose} type="button">TUTUP</button>
      </div>

      <div className="lacak-toolbar">
        <span className="control-section-label">TARGET</span>
        <input
          value={target}
          onChange={(e) => onChangeTarget(e.target.value)}
          placeholder="simbol (mis. SOLUSDT) atau trace id…"
          aria-label="Target lacak trade"
          style={{
            background: colors.bgInput, border: `1px solid ${colors.borderLight}`, color: colors.text,
            borderRadius: 2, padding: "6px 9px", fontSize: 12, fontFamily: fonts.mono, minWidth: 220,
          }}
        />
        {symbols.slice(0, 10).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChangeTarget(s)}
            style={{
              background: target === s ? colors.up : "transparent",
              color: target === s ? "#052030" : colors.textMuted,
              border: `1px solid ${target === s ? colors.up : colors.border}`,
              borderRadius: 2, cursor: "pointer", fontSize: 10, fontWeight: 700,
              padding: "4px 8px", fontFamily: fonts.mono,
            }}
          >
            {s}
          </button>
        ))}
        <span className="control-readonly">READ-ONLY · {trace.length} EVENTLOG</span>
      </div>

      {livePos && (
        <div style={{ border: `1px solid ${colors.borderLight}`, borderRadius: 4, background: colors.card, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="control-section-label">INSPECTOR POSISI · {livePos.symbol}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: livePos.side === "LONG" ? colors.up : colors.down, fontFamily: fonts.mono }}>{livePos.side}</span>
            <span style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>#{livePos.id}</span>
            <FeedBadge status={status} />
            <span style={{ fontSize: 9.5, color: colors.textDim, fontFamily: fonts.mono }}>READ-ONLY · uPnL/ROI DIHITUNG DI BROWSER</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "8px 14px", fontFamily: fonts.mono }}>
            {([
              ["QTY", String(livePos.qty)],
              ["ENTRY", String(livePos.entryPrice)],
              ["MARK", livePos.mark != null ? livePos.mark.toFixed(6) : "·"],
              ["SL", livePos.slPrice != null ? String(livePos.slPrice) : "·"],
              ["TP1", livePos.tp1Price != null ? String(livePos.tp1Price) : "·"],
              ["LEVERAGE", livePos.leverage != null ? `${livePos.leverage}x` : "·"],
              ["MARGIN", livePos.marginUsd != null ? `$${Number(livePos.marginUsd).toFixed(2)}` : "·"],
            ] as Array<[string, string]>).map(([k, v]) => (
              <div key={k}>
                <div style={{ fontSize: 9, letterSpacing: "0.12em", color: colors.textDim }}>{k}</div>
                <div style={{ fontSize: 13, color: colors.textStrong }}>{v}</div>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.12em", color: colors.textDim }}>uPnL</div>
              <FlashValue value={livePos.pnl} style={{ fontSize: 13, fontWeight: 700, color: (livePos.pnl ?? 0) >= 0 ? colors.up : colors.down }}>
                {livePos.pnl == null ? "·" : `${livePos.pnl >= 0 ? "+" : ""}$${livePos.pnl.toFixed(2)}`}
              </FlashValue>
            </div>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.12em", color: colors.textDim }}>ROI</div>
              <FlashValue value={livePos.roi} style={{ fontSize: 13, fontWeight: 700, color: (livePos.roi ?? 0) >= 0 ? colors.up : colors.down }}>
                {livePos.roi == null ? "·" : `${livePos.roi >= 0 ? "+" : ""}${livePos.roi.toFixed(2)}%`}
              </FlashValue>
            </div>
          </div>
        </div>
      )}

      {trace.length === 0 ? (
        <div className="lacak-empty">
          {target.trim()
            ? `Tidak ada event di EventLog untuk "${target.trim()}". Event hanya tersedia bila jejak trade tercatat di EventLog.`
            : "Masukkan simbol atau trace id untuk melihat jejak trade."}
        </div>
      ) : (
        <div className="lacak-timeline">
          {STAGES.map((stage) => {
            const list = byStage.get(stage.key) ?? [];
            return (
              <div className="lacak-stage" key={stage.key}>
                <div className="lacak-stage-label">
                  <span>{stage.label}</span>
                  <b>{list.length ? `${list.length} event` : "·"}</b>
                </div>
                <div className="lacak-stage-events">
                  {list.length === 0 ? (
                    <div className="lacak-noevent">tidak ada event tercatat</div>
                  ) : list.map((e) => (
                    <article className="lacak-event" key={e.id}>
                      <time>{eventTime(e.at)}</time>
                      <b>{e.actor}</b>
                      <span className="event-type">{e.type}</span>
                      {e.traceId && <code>{e.traceId}</code>}
                      <p>{e.message}</p>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
