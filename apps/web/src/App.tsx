import { Suspense, lazy, useEffect, useState } from "react";
import type { MarketSub } from "./pages/MarketHubPage";
import type { ResearchSub } from "./pages/ResearchPage";
import type { SettingsSub } from "./pages/SettingsHubPage";
import { colors, fonts } from "./theme.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { ChartErrorBoundary } from "./components/ChartErrorBoundary.js";

// 24 Okt 2026 — pemuatan cepat: setiap halaman dimuat terpisah (code split).
// Sebelumnya semua halaman ikut di bundle awal (691 kB) walau operator hanya
// membuka satu tab. Sekarang hanya tab aktif yang diunduh, sisanya lazy.
const TradingTerminalPage = lazy(() => import("./pages/TradingTerminalPage").then((m) => ({ default: m.TradingTerminalPage })));
const TerminalWorkspacePage = lazy(() => import("./pages/TerminalWorkspacePage").then((m) => ({ default: m.TerminalWorkspacePage })));
const PortfolioPage = lazy(() => import("./pages/PortfolioPage").then((m) => ({ default: m.PortfolioPage })));
const MarketHubPage = lazy(() => import("./pages/MarketHubPage").then((m) => ({ default: m.MarketHubPage })));
const AgentPage = lazy(() => import("./pages/AgentPage").then((m) => ({ default: m.AgentPage })));
const ResearchPage = lazy(() => import("./pages/ResearchPage").then((m) => ({ default: m.ResearchPage })));
const SettingsHubPage = lazy(() => import("./pages/SettingsHubPage").then((m) => ({ default: m.SettingsHubPage })));
// 27 Okt 2026 — tab LIVE di navigasi utama (dashboard LIVE-only: exposure
// riil di exchange). Simulasi pindah ke tab PAPER terpisah.
// 30 Okt 2026 (B2, perintah operator): paper trading dimatikan — halaman Paper
// DISEMBUNYIKAN dari menu dan rute #/paper diarahkan ke Live (Hanya LIVE yang
// tampil). Kode PaperDashboardPage TIDAK dihapus, hanya tidak ditautkan.
const LiveLiveOnlyPage = lazy(() => import("./pages/LiveLiveOnlyPage").then((m) => ({ default: m.LiveLiveOnlyPage })));

type TabId = "market" | "terminal" | "portfolio" | "agent" | "research" | "live" | "settings";
type Route = { tab: TabId; sub: string };

const NAV: Array<{ id: Exclude<TabId, "settings">; label: string; shortLabel: string }> = [
  { id: "market", label: "Markets", shortLabel: "Markets" },
  { id: "terminal", label: "Terminal", shortLabel: "Terminal" },
  { id: "portfolio", label: "Portfolio", shortLabel: "Portfolio" },
  { id: "agent", label: "Agents", shortLabel: "Agents" },
  { id: "research", label: "Research", shortLabel: "Research" },
  { id: "live", label: "Live", shortLabel: "Live" },
];

const ALIASES: Record<string, Route> = {
  "": { tab: "market", sub: "overview" },
  overview: { tab: "market", sub: "overview" },
  markets: { tab: "market", sub: "overview" },
  market: { tab: "market", sub: "overview" },
  screener: { tab: "market", sub: "screener" },
  heatmap: { tab: "market", sub: "heatmap" },
  terminal: { tab: "terminal", sub: "" },
  positions: { tab: "terminal", sub: "" },
  portfolio: { tab: "portfolio", sub: "" },
  history: { tab: "portfolio", sub: "history" },
  agent: { tab: "agent", sub: "briefing" },
  agents: { tab: "agent", sub: "briefing" },
  analysis: { tab: "agent", sub: "briefing" },
  research: { tab: "research", sub: "evaluation" },
  backtest: { tab: "research", sub: "backtest" },
  lab: { tab: "research", sub: "lab" },
  learning: { tab: "research", sub: "learning" },
  settings: { tab: "settings", sub: "settings" },
  universe: { tab: "settings", sub: "universe" },
  // 27 Okt 2026 — alias "live" menunjuk ke tab LIVE di navigasi utama
  // (sebelumnya -> sub-tab "live" di Settings yang menampilkan locked page).
  live: { tab: "live", sub: "" },
  "live-dashboard": { tab: "live", sub: "" },
  // 27 Okt 2026 sore — tab PAPER terpisah untuk semua simulasi.
  // 30 Okt 2026 (B2): paper disembunyikan — rute lama diarahkan ke Live.
  paper: { tab: "live", sub: "" },
  "paper-dashboard": { tab: "live", sub: "" },
  control: { tab: "live", sub: "" },
  // 29 Okt 2026 (tahap 2 redesign) — alias "#/control-room" sesuai brief paket
  // desain; sebelumnya hanya "#/control" yang terdaftar.
  // 30 Okt 2026 (koreksi poin 3): Control Room DIGABUNG ke Live — rute lama
  // hanya redirect ke #/live (lihat App useEffect), tab ada di halaman Live.
  "control-room": { tab: "live", sub: "" },
};

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  const [root, sub] = raw.split("/");
  const hit = ALIASES[root] ?? ALIASES[""];
  if (!hit) return { tab: "market", sub: "overview" };
  return sub ? { tab: hit.tab, sub } : hit;
}

function go(tab: TabId, sub?: string) {
  window.location.hash = `#/${tab}${sub ? `/${sub}` : ""}`;
}

/**
 * Jam WIB (Asia/Jakarta) terisolasi di komponen sendiri.
 * SEBELUMNYA state `utcTime` ada di App sehingga tick 1 detik me-render ulang
 * seluruh pohon halaman (termasuk canvas microstructure) 1×/detik, sumber
 * utama "jank". Sekarang hanya daun kecil ini yang berubah.
 */
function WibClock() {
  const [wibTime, setWibTime] = useState("");
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const update = () => setWibTime(fmt.format(new Date()) + " WIB");
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock">{wibTime}</span>;
}

/**
 * Status ARM + mode eksekusi — satu poller untuk seluruh header (brand +
 * pills), dan berhenti polling saat tab browser tidak terlihat (hemat CPU).
 * Store modul-level supaya brand dan pills tidak memicu dua request.
 */
type HeaderStatus = { armed: boolean | null; executionMode: string };
type HeaderSub = (s: HeaderStatus) => void;

const headerStatus: HeaderStatus = { armed: null, executionMode: "" };
const headerSubs = new Set<HeaderSub>();
let headerTimer: ReturnType<typeof setInterval> | null = null;
/** true = listener visibilitychange sudah terpasang (satu saja untuk semua consumer). */
let visibilityListenerAttached = false;

function publishHeaderStatus(next: HeaderStatus) {
  // PENTING: objek BARU setiap publish. Kalau objek yang sama yang di-mutate
  // lalu diteruskan ke setSnap(), React membandingkan dengan Object.is dan
  // MENOLAK re-render — header tetap menampilkan "…" selamanya padahal
  // fetch berhasil (BUG 27 Okt 2026, ketahuan lewat verifikasi browser).
  const snapshot: HeaderStatus = {
    armed: next.armed,
    executionMode: next.executionMode,
  };
  headerStatus.armed = snapshot.armed;
  headerStatus.executionMode = snapshot.executionMode;
  for (const fn of headerSubs) fn(snapshot);
}

function startHeaderPolling() {
  if (headerTimer !== null) return;
  const poll = () => fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      publishHeaderStatus({
        armed: typeof d.arm === "boolean" ? d.arm : headerStatus.armed,
        executionMode: typeof d.executionMode === "string" ? d.executionMode : headerStatus.executionMode,
      });
    })
    .catch(() => {});
  poll();
  headerTimer = setInterval(poll, 5000);
}

function stopHeaderPolling() {
  if (headerTimer !== null) {
    clearInterval(headerTimer);
    headerTimer = null;
  }
}

function useHeaderStatus(): HeaderStatus {
  const [snap, setSnap] = useState<HeaderStatus>(headerStatus);
  useEffect(() => {
    const sub: HeaderSub = (s) => setSnap(s);
    headerSubs.add(sub);
    // Polling globale dikelola SATU listener, bukan per-komponen: BrandMode dan
    // StatusPills sama-sama memanggil hook ini. Kalau tiap komponen
    // pasang/hapus listener sendiri, satu komponen yang unmount akan
    // mematikan polling milik yang lain -> header macet di "…".
    const onVis = () => {
      if (document.visibilityState === "visible") startHeaderPolling();
      else stopHeaderPolling();
    };
    if (!visibilityListenerAttached) {
      document.addEventListener("visibilitychange", onVis);
      visibilityListenerAttached = true;
    }
    if (document.visibilityState === "visible") startHeaderPolling();
    else stopHeaderPolling();
    return () => {
      headerSubs.delete(sub);
      if (headerSubs.size === 0) {
        stopHeaderPolling();
        if (visibilityListenerAttached) {
          document.removeEventListener("visibilitychange", onVis);
          visibilityListenerAttached = false;
        }
      }
    };
  }, []);
  return snap;
}

/** Mode eksekusi aktif — dipakai brand di header (bukan hardcode "PAPER"). */
function BrandMode() {
  const { executionMode } = useHeaderStatus();
  const label = executionMode || "…";
  return (
    <span className="brand-sub" style={executionMode === "LIVE" ? { color: colors.warn } : undefined}>
      {label}
    </span>
  );
}

function StatusPills() {
  const { armed, executionMode } = useHeaderStatus();
  return (
    <>
      <span className={`status-pill ${armed ? "good" : ""}`} title="ARM entry interlock">
        <span className="status-dot" />
        {armed === null ? "…" : armed ? "ARMED" : "DISARMED"}
      </span>
      <span className={`status-pill ${executionMode === "LIVE" ? "warn" : ""}`} title="Execution mode">
        {executionMode || "…"}
      </span>
    </>
  );
}

/** Placeholder ringan saat chunk halaman sedang diunduh. */
function PageFallback() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="page-loading-bar" aria-hidden="true" />
      <span>Loading workspace…</span>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onHash = () => {
      // Rute Control Room lama -> Live (satu halaman, tab NETWORK/GRID/LACAK).
      const root = window.location.hash.replace(/^#\/?/, "").split("/")[0]?.toLowerCase();
      if (root === "control" || root === "control-room") {
        window.location.replace("#/live");
        return;
      }
      setRoute(routeFromHash());
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = search.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{2,15}$/.test(raw)) return;
    const symbol = raw.endsWith("USDT") ? raw : `${raw}USDT`;
    localStorage.setItem("privatetrade_selected_symbol", symbol);
    setSearch("");
    window.location.hash = `#/terminal/${symbol}`;
  };

  const sub = route.sub;
  const content = (() => {
    switch (route.tab) {
      case "terminal": return sub === "legacy" ? <TradingTerminalPage /> : <TerminalWorkspacePage requestedSymbol={sub && /^[A-Z0-9]{2,15}$/.test(sub) ? sub : undefined} />;
      case "portfolio": return <PortfolioPage sub={sub} onSub={(s) => go("portfolio", s)} />;
      case "agent": return <AgentPage />;
      case "research": return <ResearchPage sub={sub} onSub={(s: ResearchSub) => go("research", s)} />;
      case "live": return <LiveLiveOnlyPage />;
      case "settings": return <SettingsHubPage sub={sub} onSub={(s: SettingsSub) => go("settings", s)} />;
      default: return <MarketHubPage sub={sub} onSub={(s: MarketSub) => go("market", s)} />;
    }
  })();

  return (
    <AppErrorBoundary>
      <div className="app-shell" style={{ background: colors.bg, minHeight: "100vh", fontFamily: fonts.main }}>
      <header className="topbar">
        <a className="brand" href="#/market" aria-label="ArtaTrade market">
          <span className="brand-name">ArtaTrade</span>
          <BrandMode />
        </a>

        <nav className="nav" aria-label="Primary">
          {NAV.map((d) => (
            <a key={d.id} className={`nav-tab${route.tab === d.id ? " active" : ""}`} href={`#/${d.id}`}>
              <span className="nav-label-full">{d.label}</span>
              <span className="nav-label-short">{d.shortLabel}</span>
            </a>
          ))}
        </nav>

        <div className="topbar-right">
          <form className="search-box" onSubmit={submitSearch} role="search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search symbol…"
              aria-label="Search a symbol and open its terminal"
              spellCheck={false}
            />
            <span style={{ opacity: 0.7 }}>/</span>
          </form>
          <StatusPills />
          <WibClock />
          <a className="gear" href="#/settings" aria-label="Open settings">Settings</a>
        </div>
      </header>

      <main className="main">
        <ChartErrorBoundary>
          <Suspense fallback={<PageFallback />}>{content}</Suspense>
        </ChartErrorBoundary>
      </main>
      </div>
    </AppErrorBoundary>
  );
}
