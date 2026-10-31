// apps/server/src/lab/labRoutes.ts — API Lab (CP-7, T-24 / CP-9, T-28..T-31).
// Semua endpoint = riset/display-only. Tidak ada endpoint Lab yang menempatkan order.
import { Router } from "express";
import type { Request, Response } from "express";
import type { LabSpec, LabCondition, LabInterval } from "./labTypes.js";
import { fetchLabKlines, intervalMs } from "./labKlines.js";
import { runLabBacktest } from "./labEngine.js";
import { parsePineSource } from "./pineParser.js";
import { listExperiments, saveExperiment } from "./labRepo.js";

const INTERVALS: LabInterval[] = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"];
// 14 Okt 2026: dinaikkan dari 6000 — 60000 bar 5m ≈ 208 hari (1m ≈ 41 hari).
// Paging fetchLabKlines (1500 bar/halaman) menangani rentang panjang.
const MAX_RANGE_BARS = 60_000;

function badSpec(msg: string): { ok: false; error: string } { return { ok: false, error: msg }; }

/** Stats kosong untuk interval yang dilewati (data kurang dari 30 bar). */
function emptyStats() {
  const side = { n: 0, winrate: 0, sumR: 0 };
  return {
    sampleCount: 0, winCount: 0, winrate: 0, profitFactor: 0,
    sumR: 0, avgR: 0, maxDdR: 0, avgHoldBars: 0,
    perSide: { LONG: side, SHORT: side },
    intrabarBand: { slFirst: { sumR: 0, winrate: 0 }, tpFirst: { sumR: 0, winrate: 0 } },
    validation: [],
  };
}

function validateSpec(raw: unknown): { ok: true; spec: LabSpec } | { ok: false; error: string } {
  const s = raw as Partial<LabSpec>;
  if (!s || typeof s !== "object") return badSpec("spec tidak valid");
  // 14 Okt 2026: MULTI PAIR — spec.symbols (1..5) ATAU spec.symbol tunggal.
  const symsRaw = Array.isArray(s.symbols) && s.symbols.length > 0
    ? (s.symbols as unknown[])
    : [s.symbol];
  if (typeof s.symbol !== "string" && symsRaw.length === 0) return badSpec("symbol wajib");
  if (symsRaw.length > 5) return badSpec("maksimal 5 pair per run");
  const symbols: string[] = [];
  for (const sy of symsRaw) {
    if (typeof sy !== "string" || !sy.trim()) return badSpec("symbol wajib");
    symbols.push(sy.trim().toUpperCase());
  }
  // 14 Okt 2026: dukung MULTI TIME FRAME — spec.intervals (1..7) ATAU spec.interval tunggal.
  const ivs = Array.isArray(s.intervals) && s.intervals.length > 0
    ? (s.intervals as unknown[])
    : [s.interval];
  if (ivs.length > INTERVALS.length) return badSpec(`maksimal ${INTERVALS.length} time frame`);
  for (const iv of ivs) {
    if (!INTERVALS.includes(iv as LabInterval)) return badSpec(`interval harus salah satu dari ${INTERVALS.join("/")}`);
  }
  const from = Date.parse(String(s.from ?? ""));
  const to = Date.parse(String(s.to ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return badSpec("rentang from/to tidak valid");
  for (const iv of ivs) {
    const bars = Math.ceil((to - from) / intervalMs(iv as LabInterval));
    if (bars > MAX_RANGE_BARS) {
      const maxDays = Math.floor((MAX_RANGE_BARS * intervalMs(iv as LabInterval)) / 86_400_000);
      return badSpec(`rentang terlalu panjang (${bars} bar > ${MAX_RANGE_BARS}). Maksimum untuk interval ${iv} ≈ ${maxDays} hari — kurangi rentang tanggal atau naikkan interval`);
    }
  }
  if (!Array.isArray(s.entryConditions) || s.entryConditions.length === 0) return badSpec("minimal 1 kondisi entry");
  for (const c of s.entryConditions as LabCondition[]) {
    if (!c?.left || !c?.right || !c?.op) return badSpec("kondisi entry tidak lengkap");
  }
  if (!s.sl || !s.tp) return badSpec("SL dan TP wajib");
  for (const exit of [s.sl, s.tp]) {
    if (!["PRICE", "PCT", "R_MULT", "ATR_MULT"].includes(exit.kind)) return badSpec("jenis exit tidak didukung");
    const value = exit.kind === "ATR_MULT" ? exit.mult : exit.value;
    if (!Number.isFinite(value) || value <= 0) return badSpec("nilai exit harus positif dan finite");
    if (exit.kind === "ATR_MULT" && (!Number.isInteger(exit.atrPeriod) || exit.atrPeriod < 1 || exit.atrPeriod > 10000)) return badSpec("periode ATR tidak valid");
    if (exit.kind === "PCT" && exit.value >= 100) return badSpec("jarak exit persen harus kurang dari 100%");
  }
  if (!["LONG", "SHORT", "BOTH"].includes(String(s.direction))) return badSpec("direction harus LONG/SHORT/BOTH");
  return {
    ok: true,
    spec: {
      name: String(s.name ?? "Tanpa nama"),
      symbol: symbols[0]!,
      symbols,
      interval: ivs[0] as LabInterval,
      intervals: ivs as LabInterval[],
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      direction: s.direction as LabSpec["direction"],
      entryConditions: s.entryConditions as LabCondition[],
      sl: s.sl,
      tp: s.tp,
      source: (s.source as LabSpec["source"]) ?? "MANUAL_BLOCK",
      pineSource: typeof s.pineSource === "string" ? s.pineSource.slice(0, 20000) : undefined,
      tvUrl: typeof s.tvUrl === "string" ? s.tvUrl.slice(0, 500) : undefined,
    },
  };
}

export function buildLabRouter(): Router {
  const r = Router();

  // POST /api/lab/run — jalankan backtest eksperimen pada kline asli
  r.post("/run", async (req: Request, res: Response) => {
    try {
      const v = validateSpec(req.body?.spec);
      if (!v.ok) { res.status(400).json({ ok: false, error: v.error }); return; }
      const spec = v.spec;
      const fromMs = Date.parse(spec.from);
      const toMs = Date.parse(spec.to);
      // MULTI PAIR + MULTI TIME FRAME: backtest per kombinasi pair x TF.
      const ivs = spec.intervals?.length ? spec.intervals : [spec.interval];
      const symbols = spec.symbols?.length ? spec.symbols : [spec.symbol];
      const results: { symbol: string; interval: string; result: ReturnType<typeof runLabBacktest> }[] = [];
      let saved = 0;
      for (const sym of symbols) {
        for (const iv of ivs) {
          const bars = await fetchLabKlines(sym, iv, fromMs, toMs, MAX_RANGE_BARS);
          if (bars.length < 30) {
            results.push({
              symbol: sym, interval: iv,
              result: {
                spec: { ...spec, symbol: sym, interval: iv }, stats: emptyStats(),
                trades: [], equity: [], candles: [], markers: [],
                barsUsed: 0, barsRequested: 0,
                caveats: [`Data kline terlalu sedikit (${bars.length} bar) untuk ${sym} ${iv} — dilewati.`],
                runtimeMs: 0,
              } as ReturnType<typeof runLabBacktest>,
            });
            continue;
          }
          const r = runLabBacktest({ ...spec, symbol: sym, interval: iv, intervals: [iv], symbols: [sym] }, bars);
          results.push({ symbol: sym, interval: iv, result: r });
          if (saved < 5) { saveExperiment({ ...spec, symbol: sym, interval: iv }, r.stats); saved++; }
        }
      }
      const primary = results.find((r) => r.result.trades.length > 0) ?? results[0]!;
      res.json({ ok: true, result: primary.result, results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "gagal menjalankan backtest" });
    }
  });

  // GET /api/lab/experiments — riwayat eksperimen
  r.get("/experiments", (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, experiments: listExperiments(50) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "gagal membaca riwayat" });
    }
  });

  // POST /api/lab/parse-pine — parse sumber Pine -> blok eksperimen (T-29)
  r.post("/parse-pine", (req: Request, res: Response) => {
    try {
      const src = String(req.body?.source ?? "");
      if (!src.trim()) { res.status(400).json({ ok: false, error: "sumber Pine kosong" }); return; }
      const parsed = parsePineSource(src, {
        symbol: req.body?.symbol,
        interval: req.body?.interval,
        name: req.body?.name,
        tvUrl: req.body?.tvUrl,
      });
      res.json({ ok: true, parsed });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "gagal parse Pine" });
    }
  });

  // POST /api/lab/parse-link — ekstrak metadata + sumber dari link TradingView (T-28).
  // JUJUR: sumber script invite-only/berbayar tidak bisa diambil -> tolak dengan alasan.
  r.post("/parse-link", async (req: Request, res: Response) => {
    try {
      const url = String(req.body?.url ?? "").trim();
      if (!/^https?:\/\/(www\.)?tradingview\.com\//i.test(url)) {
        res.status(400).json({ ok: false, error: "URL harus dari tradingview.com" });
        return;
      }
      const fetchRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) artatrade-lab/1.0" },
        redirect: "follow",
      });
      if (!fetchRes.ok) {
        res.status(502).json({ ok: false, error: `Halaman TradingView tidak bisa diambil (HTTP ${fetchRes.status})` });
        return;
      }
      const html = await fetchRes.text();
      // judul + lisensi dari meta
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "").trim();
      const license = /invite[- ]?only/i.test(html) ? "invite-only"
        : /open[- ]?source/i.test(html) ? "open-source"
        : /premium|berbayar|paid/i.test(html) ? "premium" : "unknown";
      // sumber Pine tersemat di halaman? (beberapa halaman memuatnya di state JSON)
      const embedded = html.match(/"(?:pine|source)"\s*:\s*"((?:[^"\\]|\\.){50,})"/);
      let source: string | null = null;
      if (embedded) {
        try { source = JSON.parse(`"${embedded[1]}"`); } catch { source = null; }
      }
      if (!source) {
        res.json({
          ok: true,
          meta: { title, license, url },
          source: null,
          message: license === "invite-only" || license === "premium"
            ? "Script ini invite-only/premium — sumber tidak bisa diambil otomatis. Tolak jujur: tanpa sumber, tanpa statistik."
            : "Metadata terambil, tapi kode sumber Pine dimuat via JavaScript sehingga tidak bisa diekstrak otomatis. Tempel kode Pine-nya di kolom yang tersedia.",
        });
        return;
      }
      const parsed = parsePineSource(source, { name: title, tvUrl: url });
      res.json({ ok: true, meta: { title, license, url }, source, parsed });
    } catch (e) {
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : "gagal mengambil halaman" });
    }
  });

  return r;
}
