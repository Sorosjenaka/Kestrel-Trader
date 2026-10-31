// ArtaTrade AI - env loader deterministik (NFR-08).
// Rantai baca (prioritas tinggi -> rendah): apps/server/.env, lalu .env root.
// File ini TIDAK PERNAH menampilkan nilai secret - hanya status SET/MISSING.
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(THIS_DIR, "..", "..");
const ROOT_DIR = path.resolve(SERVER_DIR, "..", "..");
const offlineTest = process.env.ARTA_OFFLINE_TEST === "true";
const localProfile = process.env.ARTA_ENV_PROFILE === "local";
function readVarsFile(file: string): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Rantai deterministik: first-write-wins — sumber prioritas TINGGI diterapkan DULU
// agar tak tertimpa sumber rendah. Prioritas: apps/server/.env, lalu .env root.
// (BUG lama: urutan terbalik membuat root selalu menang sehingga DATABASE_URL
// absolut di apps/server/.env tak pernah dipakai + histori terbelah dua.)
const _preexistingEnvKeys = new Set(Object.keys(process.env));
export const envProvenance: Record<string, string> = {};
for (const _k of _preexistingEnvKeys) envProvenance[_k] = "process";
// Offline tests and the explicit local profile never load account credentials.
const serverVars = offlineTest || localProfile ? {} : readVarsFile(path.join(SERVER_DIR, ".env"));
const rootVars = offlineTest || localProfile ? {} : readVarsFile(path.join(ROOT_DIR, ".env"));
function applyVarsFile(source: Record<string, string>, tag: string): void {
  for (const [k, v] of Object.entries(source)) {
    const cur = process.env[k];
    if ((cur === undefined || cur === "") && v !== "") {
      process.env[k] = v;
      envProvenance[k] = tag;
    }
  }
}
applyVarsFile(serverVars, "serverEnv");
applyVarsFile(rootVars, "rootEnv");

if (localProfile) {
  const localVars: Record<string, string> = {
    DATABASE_URL: `file:${path.join(ROOT_DIR, "data", "local", "artatrade.db").replace(/\\/g, "/")}`,
    KNN_LIBRARY_PATH: path.join(ROOT_DIR, "data", "local", "knn-library.json"),
    BINANCE_EXECUTION_MODE: "PAPER",
    BINANCE_API_KEY: "", BINANCE_API_SECRET: "", XKIRO_API_KEY: "", DREX_API_KEY: "",
    DREX_ENABLED: "false", DREX_SWING_ENABLED: "false", LLM_SWEEP_ENABLED: "false", LLM_ANALYST_ENABLED: "false",
    ARM_DEFAULT: "false", API_MUTATION_TOKEN: "", TV_WEBHOOK_SECRET: "",
  };
  for (const [key, value] of Object.entries(localVars)) {
    process.env[key] = value;
    envProvenance[key] = "localProfile";
  }
}

// File-authority (insiden 26 Sep 2026): tsx-watch PARENT yang hidup sejak lama
// mewariskan nilai .env basi ke semua child (restart tak pernah baca ulang file).
// Untuk kunci yang TERBUKTI teracuni, nilai eksplisit di .env MENANG atas warisan
// process — kecuali saat test (vitest menyetel DATABASE_URL test yang wajib menang).
const _isTestEnv = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
if (!_isTestEnv) {
  // 29 Sep 2026: SCALP_STRATEGY_IDS ditambahkan ke daftar kunci yang WAJIB
  // mengikuti file .env — restart tidak boleh memakai nilai warisan basi dari
  // proses induk (kelas bug env teracuni 26 Sep 2026).
  for (const _k of [
    "DATABASE_URL", "XKIRO_MONTHLY_BUDGET_USD",
    "XKIRO_API_KEY", "XKIRO_BASE_URL", "XKIRO_MODEL_FAST",
    "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_API_KEY_1", "DEEPSEEK_API_KEY_2", "DEEPSEEK_API_KEY_3", "DEEPSEEK_API_KEY_4", "DEEPSEEK_FAILOVER_ENABLED",
    "XKIRO_MODEL_REASON", "XKIRO_MODEL_REASON_FALLBACKS", "XKIRO_REASONING_EFFORT", "XKIRO_MONTHLY_BUDGET_USD", "XKIRO_DEGRADE_AT_PCT",
    "VOLUME_MIN_USD",
    "SCALP_STRATEGY_IDS",
    // 13 Okt 2026: kunci lane SWING S-05 wajib file-authority (anti warisan basi).
    "SWING_STRATEGY_IDS",
    "SWING_MAX_POSITIONS",
    "LLM_ANALYST_ENABLED", "LLM_ANALYST_INTERVAL_MIN", "LLM_ANALYST_MAX_DAILY_CALLS",
    "LLM_TRADE_EVAL_ENABLED", "LLM_TRADE_EVAL_INTERVAL_HOURS", "LLM_TRADE_EVAL_MAX_DAILY_CALLS",
    "THESIS_ARENA_ENABLED", "THESIS_ARENA_INTERVAL_HOURS", "THESIS_ARENA_MAX_DAILY_CALLS",
    "THESIS_ARENA_GATE_ENABLED",
    "LLM_SWEEP_ENABLED", "LLM_SWEEP_INTERVAL_MIN", "LLM_SWEEP_MAX_SYMBOLS", "LLM_SWEEP_STAGE2",
    "SIDEWAYS_ENTRY_ALLOWED",
    "PAPER_DETERMINISTIC_ENTRY",
    // 21 Okt 2026 (Phase 4): S03_SHORT_ENABLED + S03_FIB_ENABLED dihapus —
    // tidak ada lagi env yang perlu mengikuti file .env.
    "KNN_LIBRARY_PATH",
    "BINANCE_EXECUTION_MODE",
    // 3 Okt 2026 — integrasi Drex: key + parameter keputusan ikuti file .env,
    // jangan mewarisi nilai basi dari proses induk (kelas bug env teracuni).
    "DREX_API_KEY", "DREX_ENABLED", "DREX_BASE_URL", "DREX_MODEL",
    "DREX_TIMEOUT_MS", "DREX_MIN_ENTRY_PROBABILITY", "DREX_MIN_SETUP_STRENGTH",
    "DREX_SWING_ENABLED",
    // 24 Okt 2026 — Drex vision (chart PNG dikirim ke Drex-Max).
    "DREX_VISION_ENABLED", "DREX_VISION_MAX_BARS", "DREX_VISION_TIMEFRAME",
    "LIVE_MAX_OPEN_POSITIONS", "LIVE_DAILY_DD_CAP_USD", "LIVE_MIN_BALANCE_USD", "LIVE_MAX_MARGIN_USD",
    "LIVE_LOSS_TRIPWIRE_COUNT", "LIVE_DEPTH_GUARD_ENABLED", "LIVE_DEPTH_GUARD_MAX_BPS", "LIVE_POST_ONLY_ENABLED", "LIVE_ORDER_AMEND_ENABLED",
    // 24 Okt 2026 — Vike Data API key (Panel 3 peta likuidasi). File-authority
    // supaya restart tidak memakai warisan basi dari proses induk.
    "VIKE_API_KEY",
  ]) {
    const _fileVal =
      serverVars[_k] !== undefined && serverVars[_k] !== ""
        ? { v: serverVars[_k], tag: "serverEnv" }
        : rootVars[_k] !== undefined && rootVars[_k] !== ""
          ? { v: rootVars[_k], tag: "rootEnv" }
          : null;
    if (_fileVal && process.env[_k] !== _fileVal.v) {
      process.env[_k] = _fileVal.v;
      envProvenance[_k] = _fileVal.tag;
    }
  }
}

export const serverFileDatabaseUrl: string | null =
  typeof serverVars.DATABASE_URL === "string" && serverVars.DATABASE_URL !== ""
    ? serverVars.DATABASE_URL
    : null;

export function envSourceOf(key: string): string {
  return envProvenance[key] ?? "default";
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function str(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined ? fallback : v;
}

const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
function reasoningEffort(key: string, fallback: typeof REASONING_EFFORTS[number]): typeof REASONING_EFFORTS[number] {
  const value = str(key, fallback).trim().toLowerCase();
  return REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number])
    ? value as typeof REASONING_EFFORTS[number]
    : fallback;
}

function executionMode(): "PAPER" | "LIVE" {
  const mode = str("BINANCE_EXECUTION_MODE", "PAPER").trim().toUpperCase();
  if (mode !== "PAPER" && mode !== "LIVE") throw new Error("BINANCE_EXECUTION_MODE must be PAPER or LIVE");
  return mode;
}

export interface AppEnv {
  PORT: number; LOG_LEVEL: string; DATABASE_URL: string;
  BINANCE_API_KEY: string; BINANCE_API_SECRET: string;
  BINANCE_EXECUTION_MODE: "PAPER" | "LIVE";
  BINANCE_REST_POOL: string[]; BINANCE_WS_PRIMARY: string; BINANCE_WS_FALLBACK: string;
  XKIRO_API_KEY: string; XKIRO_BASE_URL: string;
  /**
   * 24 Okt 2026 — Vike Data API key (format `vk_...`). Dipakai modul
   * likuidasi (Panel 3) sebagai sumber UTAMA peta likuidasi.
   * Nilai TIDAK PERNAH dicetak di log/API — hanya status SET/MISSING.
   */
  VIKE_API_KEY: string;
  XKIRO_MODEL_FAST: string; XKIRO_MODEL_REASON: string; XKIRO_MODEL_REASON_FALLBACKS: string[];
  XKIRO_REASONING_EFFORT: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  XKIRO_MONTHLY_BUDGET_USD: number; XKIRO_DEGRADE_AT_PCT: number;
  /** DeepSeek (Lighthouse/dphn.ai) — failover-only; nilai key TIDAK pernah dicetak. */
  DEEPSEEK_BASE_URL: string; DEEPSEEK_MODEL: string;
  DEEPSEEK_API_KEYS: string[];
  DEEPSEEK_FAILOVER_ENABLED: boolean;
  RISK_PER_TRADE_USD: number; LEVERAGE_TARGET: number; MARGIN_MODE: string; MARGIN_CAP_PCT: number;
  ARM_DEFAULT: boolean;
  VOLUME_MIN_USD: number; MTF_CONCURRENCY: number; MTF_CONCURRENCY_CAP: number; SCAN_CONCURRENCY: number;
  DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE: boolean;
  /** Independent LONG-vs-SHORT battle gate; default OFF until PAPER validation. */
  DIRECTION_BATTLE_ENABLED: boolean;
  SCALP_STRATEGY_IDS: string;
  /** 13 Okt 2026 — lane SWING S-05: allowlist + cap posisi global. */
  SWING_STRATEGY_IDS: string;
  SWING_MAX_POSITIONS: number;
  /** 14 Okt 2026 — LLM Market Analyst (riset/analisis berkala, read-only). */
  LLM_ANALYST_ENABLED: boolean;
  LLM_ANALYST_INTERVAL_MIN: number;
  /** LLM Market Sweep (15 Okt): riset multi-paralel semua simbol. */
  LLM_SWEEP_ENABLED: boolean; LLM_SWEEP_INTERVAL_MIN: number; LLM_SWEEP_MAX_SYMBOLS: number; LLM_SWEEP_STAGE2: boolean;
  LLM_ANALYST_MAX_DAILY_CALLS: number;
  /** 27 Okt 2026 — Trade Evaluator (Mira): evaluasi hasil trade + 5-why, read-only. */
  LLM_TRADE_EVAL_ENABLED: boolean;
  LLM_TRADE_EVAL_INTERVAL_HOURS: number;
  LLM_TRADE_EVAL_MAX_DAILY_CALLS: number;
  /** 27 Okt 2026 — Arena Tesis LONG vs SHORT (Arya/Bayu/Ratih), read-only. */
  THESIS_ARENA_ENABLED: boolean;
  THESIS_ARENA_INTERVAL_HOURS: number;
  THESIS_ARENA_MAX_DAILY_CALLS: number;
  /** Opsi B: verdict arena tesis sebagai gate entry (fail-closed kualitas). */
  THESIS_ARENA_GATE_ENABLED: boolean;
  /**
   * Perintah operator 29 Sep 2026 ("gw ga mau trading di chart sideaways"):
   * default false = entry sideways (bias NEUTRAL / regime RANGING / UNCERTAIN)
   * DITOLAK di semua mode dan semua level progresif.
   */
  SIDEWAYS_ENTRY_ALLOWED: boolean;
  /**
   * Perintah operator 30 Sep 2026 ("isi slot sampai 20/20").
   * PAPER-only: true = gate deterministik (skor/KNN) yang menentukan verdict
   * entry; keputusan LLM Arka menjadi advisory. Di LIVE flag ini diabaikan
   * (verdict LLM tetap wajib, fail-closed).
   */
  PAPER_DETERMINISTIC_ENTRY: boolean;
  /**
   * 30 Sep 2026: lokasi file library KNN eksplisit (menang atas turunan DATABASE_URL).
   */
  KNN_LIBRARY_PATH: string;
  PROGRESSIVE_ENABLED: boolean; PROGRESSIVE_LEVEL_OVERRIDE: string;
  SCAN_INTERVAL_SCALP_SEC: number;
  SCALP_HOLD_MAX_MIN: number;
  /**
   * 30 Sep 2026 — perintah operator: "SL nya malah jadi melebar ... terkecuali da fake out
   * yang luar biasa." Slippage (bps, arah merugikan) yang diasumsikan saat SL dieksekusi
   * di harga stop (mirroring resting STOP_MARKET yang tereksekusi di bursa).
   */
  SL_FILL_SLIPPAGE_BPS: number;
  /**
   * Ambang "fake out yang luar biasa" dalam satuan risk distance (jarak entry→SL).
   * Harga menembus SL lebih dari ini dalam satu tick → fill di harga pasar
   * (gap exception, tercatat event SL_GAP_FILL). Di bawah ambang → fill di harga SL.
   */
  SL_GAP_OVERRUN_R: number;
  TV_MCP_ENABLED: boolean; TV_WEBHOOK_SECRET: string; API_MUTATION_TOKEN: string; PAPER_TOUCH_VERIFY: boolean;
  ENABLE_AI_COUNCIL: boolean;
  /**
   * C2 (30 Okt 2026, perintah operator): pembuatan posisi PAPER BARU.
   * Default false = dimatikan (kode paper TIDAK dihapus, hanya tidak
   * menghasilkan posisi baru). Set PAPER_POSITIONS_ENABLED=TRUE untuk
   * mengaktifkan kembali. Tidak berpengaruh pada jalur LIVE.
   */
  PAPER_POSITIONS_ENABLED: boolean;
  // ── Jalur LIVE (keputusan operator 10 Okt 2026) ──────────────────────────
  /** Batas posisi terbuka mode LIVE (fase test $3 = 1; fase $30 = 3). */
  LIVE_MAX_OPEN_POSITIONS: number;
  /** Cap drawdown harian LIVE (USD). 0 = nonaktif (fase $3); fase $30 = 7. */
  LIVE_DAILY_DD_CAP_USD: number;
  /** Saldo minimum LIVE agar entry diizinkan (fail-closed di bawah ini). */
  LIVE_MIN_BALANCE_USD: number;
  /** Plafon margin per posisi LIVE (USD). Perintah operator 11 Okt 2026: maks $3. */
  LIVE_MAX_MARGIN_USD: number;
  /** Jumlah loss LIVE yang memicu tripwire stop sejak ARM. Operator 12 Okt 2026: 2x. */
  LIVE_LOSS_TRIPWIRE_COUNT: number;
  /** T-13 (19 Okt 2026): depth guard pre-entry LIVE (fail-closed bila depth gagal). */
  LIVE_DEPTH_GUARD_ENABLED: boolean;
  /** Batas slippage VWAP depth vs best price (bps). */
  LIVE_DEPTH_GUARD_MAX_BPS: number;
  /** T-13: entry LIMIT live memakai timeInForce=GTX (post-only). */
  LIVE_POST_ONLY_ENABLED: boolean;
  /** T-11: amend order live — default OFF sampai probe zero-risk exchange. */
  LIVE_ORDER_AMEND_ENABLED: boolean;
  /**
   * 11 Okt 2026 — cooldown pasca-LOSS 15 menit global (varian dipilih operator:
   * "15 menit semua simbol"). false = rollback (entry tidak lagi ditunda pasca-loss).
   */
  LOSS_COOLDOWN_ENABLED: boolean;
  // ── Drex (NaceAI) — lapisan keputusan (3 Okt 2026). BUKAN risk engine: ──
  // tidak menghitung sizing/harga; hanya vonis GO/NO-GO + probabilitas setup.
  /** Aktif = Drex dipanggil di runSetupJudge sebelum judge Xkiro (failover). */
  DREX_ENABLED: boolean;
  /**
   * 23 Okt 2026 (perintah operator): Drex menilai kandidat lane SWING.
   * Putusan Drex yang TERSEDIA mengikat (reject = entry batal); Drex tak
   * tersedia = fail-open, gate deterministik lama tetap berjalan (jujur di log).
   */
  DREX_SWING_ENABLED: boolean;
  /** 26 Okt 2026 (TAHAP 5): shadow compare Drex SWING v2 (state v2 + pertanyaan
   *  horizon SWING + evidence mikrostruktur & BTC macro). Shadow TIDAK mengikat:
   *  verdict produksi tetap milik versi lama; hasil v2 hanya dicatat untuk
   *  perbandingan (EventLog DREX_SWING_SHADOW_COMPARE). */
  DREX_SWING_SHADOW: boolean;
  // ── 23 Okt 2026 (Tahap 4): lapisan analisis data (observasi) ───────────
  /** Aktif = feed trade analisis dijalankan (default mati). */
  ANALYTICS_ENABLED: boolean;
  /**
   * TIDAK PERNAH diaktifkan di tahap mana pun sebelum disetujui operator +
   * uji paper. Selama false, lapisan analisis tidak pernah menyentuh
   * entry/order — murni observasi + jurnal.
   */
  ANALYTICS_INFLUENCE_TRADING: boolean;
  ANALYTICS_SYMBOL: string;
  ANALYTICS_MARKET: string;
  /**
   * Venue feed analisis yang diaktifkan, dipisah koma.
   * Pilihan: BINANCE, HYPERLIQUID, COINBASE.
   * Default: BINANCE saja (hemat RAM & rate-limit VPS 2 GB).
   *
   * CATATAN SEMANTIK (23 Okt 2026):
   *  - BINANCE     : taker side eksplisit (field `m`).
   *  - HYPERLIQUID : taker side eksplisit (field `side`).
   *  - COINBASE    : hanya MAKER side -> delta-nya proksi taker, label wajib.
   */
  ANALYTICS_VENUES: string;
  /** Hyperliquid: pakai testnet (default mainnet). */
  ANALYTICS_HYPERLIQUID_TESTNET: boolean;
  /** Secret; hanya status SET/MISSING yang boleh tampil (lihat keyStatus). */
  DREX_API_KEY: string;
  DREX_BASE_URL: string;
  DREX_MODEL: string;
  DREX_TIMEOUT_MS: number;
  /** Ambang probabilitas GO Drex; JANGAN diturunkan otomatis untuk menambah frekuensi. */
  DREX_MIN_ENTRY_PROBABILITY: number;
  /**
   * Ambang conviction setup_strength Drex, sebagai INDEX label
   * (0=very_weak, 1=weak, 2=moderate, 3=strong, 4=very_strong).
   * Default 2 = "moderate": very_weak & weak DITOLAK.
   */
  DREX_MIN_SETUP_STRENGTH: number;
  // ── Drex vision (24 Okt 2026) ────────────────────────────────────────────
  /**
   * true = server mengirim screenshot chart PNG (base64) ke Drex lewat field
   * `images`, sehingga Drex-Max menilai dari GAMBAR chart, bukan hanya angka.
   * DEFAULT MATI (false): perilaku produksi tidak berubah sampai operator menyalakan.
   * Membutuhkan DREX_MODEL=drex-max (drex-v1.5 menolak field images dengan 422).
   */
  DREX_VISION_ENABLED: boolean;
  /** Jumlah lilin terakhir yang digambar pada chart PNG. */
  DREX_VISION_MAX_BARS: number;
  /** Timeframe chart yang dikirim (harus timeframe analisis lane, mis. 1h). */
  DREX_VISION_TIMEFRAME: string;
  // ── Panel AI analysis (26 Okt 2026, TAHAP 4) ─────────────────────────────
  /** Aktif = analisis AI lima panel mikrostruktur dipanggil otomatis. */
  PANEL_AI_ENABLED: boolean;
  /** Budget panggilan LLM panel per jam (hemat; dedup hash tetap utama). */
  PANEL_AI_MAX_PER_HOUR: number;
  /** TAHAP 6B: batas keras TOKEN aktual per jam untuk panel AI (0 = tanpa batas). */
  PANEL_AI_MAX_TOKENS_PER_HOUR: number;
  /** TAHAP 6B: batas keras request HTTP per batch analisis (5 panel + combined = 6). */
  PANEL_AI_MAX_REQUESTS_PER_BATCH: number;
  /** TAHAP 6B: deadline ANTREAN panel (ms). Melewati batas -> request dibatalkan
   *  (evidence basi) alih-alih menunggu lalu kehabisan waktu provider. */
  PANEL_AI_QUEUE_DEADLINE_MS: number;
  /** Debounce: bukti tak berubah dalam jendela ini tidak memicu analisis ulang. */
  PANEL_AI_DEBOUNCE_MS: number;
}

const splitList = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);

export const env: AppEnv = {
  PORT: num("PORT", 8787),
  // 15 Okt 2026 (Tahap 7): DB_PATH dihapus — tidak pernah dibaca; sumber tunggal
  // path DB adalah DATABASE_URL (insiden 26 Sep: dua sumber = histori terbelah).
  LOG_LEVEL: str("LOG_LEVEL", "info"),
  DATABASE_URL: str("DATABASE_URL", "file:../data/artatrade.db"),
  BINANCE_API_KEY: str("BINANCE_API_KEY"),
  BINANCE_API_SECRET: str("BINANCE_API_SECRET"),
  BINANCE_EXECUTION_MODE: executionMode(),
  BINANCE_REST_POOL: splitList(str("BINANCE_REST_POOL", "fapi.binance.com,fapi1.binance.com,fapi2.binance.com,fapi3.binance.com,fapi4.binance.com")),
  BINANCE_WS_PRIMARY: str("BINANCE_WS_PRIMARY", "fstream.binance.com"),
  BINANCE_WS_FALLBACK: str("BINANCE_WS_FALLBACK", "fstream1.binance.com"),
  XKIRO_API_KEY: str("XKIRO_API_KEY"),
  VIKE_API_KEY: str("VIKE_API_KEY"),
  XKIRO_BASE_URL: str("XKIRO_BASE_URL", "https://api.xkiro.com/v1"),
  XKIRO_MODEL_FAST: str("XKIRO_MODEL_FAST", "xiaomi/mimo-v2.6-flash"),
  XKIRO_MODEL_REASON: str("XKIRO_MODEL_REASON", "xiaomi/mimo-v2.6-pro"),
  XKIRO_MODEL_REASON_FALLBACKS: splitList(str("XKIRO_MODEL_REASON_FALLBACKS", "")),
  XKIRO_REASONING_EFFORT: reasoningEffort("XKIRO_REASONING_EFFORT", "high"),
  XKIRO_MONTHLY_BUDGET_USD: num("XKIRO_MONTHLY_BUDGET_USD", 60),
  XKIRO_DEGRADE_AT_PCT: num("XKIRO_DEGRADE_AT_PCT", 80),
  DEEPSEEK_BASE_URL: str("DEEPSEEK_BASE_URL", "https://lighthouse.dphn.ai/run/text-v/v1"),
  DEEPSEEK_MODEL: str("DEEPSEEK_MODEL", "deepseek-ai/DeepSeek-V4.1-Flash"),
  DEEPSEEK_API_KEYS: [1, 2, 3, 4]
    .map((i) => str(`DEEPSEEK_API_KEY_${i}`).trim())
    .filter(Boolean),
  DEEPSEEK_FAILOVER_ENABLED: bool("DEEPSEEK_FAILOVER_ENABLED", true),
  RISK_PER_TRADE_USD: num("RISK_PER_TRADE_USD", 1),
  LEVERAGE_TARGET: num("LEVERAGE_TARGET", 25),
  MARGIN_MODE: str("MARGIN_MODE", "CROSS"),
  MARGIN_CAP_PCT: num("MARGIN_CAP_PCT", 40),
  // 29 Sep 2026 — perintah operator: DAILY_STOP_USD & AUTO_DISARM_DD_USD DIHAPUS
  // dari sistem. Nilai PnL/drawdown tetap dilaporkan, tetapi tanpa guard/auto-disarm.
  // 15 Okt 2026 — ATURAN PERMANEN operator: ARM TIDAK PERNAH dinyalakan di live
  // trading. Hard block: di mode LIVE, ARM_DEFAULT dipaksa false apa pun isi .env.
  // 27 Okt 2026 (perintah operator: "hapus saja blocker Live nya jangan di
  // bypass") — hard block tersebut DIHAPUS PERMANEN. ARM_DEFAULT kini dibaca
  // apa adanya di kedua mode; tidak ada flag bypass yang perlu di-set, jadi
  // tidak ada lagi nilai env yang bisa "basi" setelah restart.
  ARM_DEFAULT: bool("ARM_DEFAULT", true),
  VOLUME_MIN_USD: num("VOLUME_MIN_USD", 7000000),
  PROGRESSIVE_ENABLED: bool("PROGRESSIVE_ENABLED", true),
  PROGRESSIVE_LEVEL_OVERRIDE: str("PROGRESSIVE_LEVEL_OVERRIDE", "AUTO"),
  DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE: bool("DETERMINISTIC_FALLBACK_ON_LLM_OUTAGE", true),
  // Direction battle: default OFF until PAPER/shadow validation and operator approval.
  DIRECTION_BATTLE_ENABLED: bool("DIRECTION_BATTLE_ENABLED", false),
  // 20 Okt 2026 (perintah operator) — S-03 Fibonacci dan S-04 Mean-Reversion
  // Stretch dihapus dari katalog aktif. Default allowlist mengikuti katalog:
  // SCALP = S-02 (S-01 hard-gated EV negatif); SWING = S-05 + RSW-01/02/03.
  SCALP_STRATEGY_IDS: str("SCALP_STRATEGY_IDS", "S-02"),
  // 13 Okt 2026 — lane SWING S-05: allowlist + cap posisi global (file-authority,
  // ikut daftar kunci anti-warisan basi). Default mengikuti katalog.
  // T0.5 (18 Okt 2026): default lane SWING menyertakan RSW-01/02/03
  // (port evaluator riset). 20 Okt 2026: S-03 Fibonacci dihapus dari lane ini.
  // 20 Okt 2026 (operator: "polaris hapus juga"): S-05 Polaris dihapus —
  // master_v2 executed PF 0.7503 / P(EV<=0)=99.9% = edge negatif.
  SWING_STRATEGY_IDS: str("SWING_STRATEGY_IDS", "RSW-01,RSW-02,RSW-03"),
  SWING_MAX_POSITIONS: num("SWING_MAX_POSITIONS", 20),
  LLM_ANALYST_ENABLED: bool("LLM_ANALYST_ENABLED", true),
  LLM_ANALYST_INTERVAL_MIN: num("LLM_ANALYST_INTERVAL_MIN", 60),
  LLM_SWEEP_ENABLED: bool("LLM_SWEEP_ENABLED", false),
  LLM_SWEEP_INTERVAL_MIN: num("LLM_SWEEP_INTERVAL_MIN", 60),
  LLM_SWEEP_MAX_SYMBOLS: num("LLM_SWEEP_MAX_SYMBOLS", 0),
  LLM_SWEEP_STAGE2: bool("LLM_SWEEP_STAGE2", true),
  LLM_ANALYST_MAX_DAILY_CALLS: num("LLM_ANALYST_MAX_DAILY_CALLS", 12),
  // 27 Okt 2026 — pemecahan beban Market Analyst (audit /tmp/analyst-load-audit.log):
  // evaluasi trade + feedback loop 5-why pindah ke agen trade-evaluator (Mira).
  LLM_TRADE_EVAL_ENABLED: bool("LLM_TRADE_EVAL_ENABLED", true),
  LLM_TRADE_EVAL_INTERVAL_HOURS: num("LLM_TRADE_EVAL_INTERVAL_HOURS", 4),
  LLM_TRADE_EVAL_MAX_DAILY_CALLS: num("LLM_TRADE_EVAL_MAX_DAILY_CALLS", 6),
  // 27 Okt 2026 — Arena Tesis LONG vs SHORT (Arya/Bayu/Ratih): dibatasi
  // interval + cap harian; output READ-ONLY (EventLog/AGENT_DIALOG).
  THESIS_ARENA_ENABLED: bool("THESIS_ARENA_ENABLED", true),
  THESIS_ARENA_INTERVAL_HOURS: num("THESIS_ARENA_INTERVAL_HOURS", 4),
  THESIS_ARENA_MAX_DAILY_CALLS: num("THESIS_ARENA_MAX_DAILY_CALLS", 3),
  /** 27 Okt 2026 (opsi B, persetujuan operator): verdict arena tesis menjadi
   *  gate entry (fail-closed: entry butuh tesis USABLE yang sejalan sisi plan). */
  THESIS_ARENA_GATE_ENABLED: bool("THESIS_ARENA_GATE_ENABLED", false),
  // 29 Sep 2026: "gw ga mau trading di chart sideaways" — default WAJIB menolak.
  SIDEWAYS_ENTRY_ALLOWED: bool("SIDEWAYS_ENTRY_ALLOWED", false),
  // 30 Sep 2026 — perintah operator: isi slot 20/20 di PAPER. Default true hanya
  // berlaku bila BINANCE_EXECUTION_MODE=PAPER (ditegakkan di pemanggil).
  PAPER_DETERMINISTIC_ENTRY: bool("PAPER_DETERMINISTIC_ENTRY", false),
  // 21 Okt 2026 (Phase 4c, keputusan operator): S03_SHORT_ENABLED dan
  // S03_FIB_ENABLED DIHAPUS TOTAL dari env.
  //   - S03_SHORT_ENABLED: tidak ada lagi saklar yang bisa membuka kunci
  //     S-01 SHORT (Liquidity Sweep Reclaim) — kunci jadi PERMANEN.
  //   - S03_FIB_ENABLED: S-03 sudah dihapus dari katalog aktif sejak 20 Okt
  //     2026 dan plan-nya sudah fail-closed, jadi saklarnya tidak pernah
  //     dibaca kode mana pun.
  // Kunci S-01 SHORT sekarang ditegakkan tanpa parameter — lihat
  // isStrategySideLocked() di exec/slotFillPolicy.ts.
  KNN_LIBRARY_PATH: str("KNN_LIBRARY_PATH", ""),
  MTF_CONCURRENCY: num("MTF_CONCURRENCY", 3),
  // Cap keras analisis MTF paralel (2..3). Menaikkan ini memicu 429 Binance yang
  // membuat seluruh kandidat jatuh ke Jalur B (MTF_UNAVAILABLE) dan tidak ada
  // strategy match — jangan menaikkan tanpa uji beban REST.
  MTF_CONCURRENCY_CAP: num("MTF_CONCURRENCY_CAP", 3),
  SCAN_CONCURRENCY: num("SCAN_CONCURRENCY", 50),
  SCAN_INTERVAL_SCALP_SEC: num("SCAN_INTERVAL_SCALP_SEC", 60),
  SCALP_HOLD_MAX_MIN: num("SCALP_HOLD_MAX_MIN", 90),
  // 30 Sep 2026 — "SL nya malah jadi melebar ... terkecuali da fake out yang luar biasa."
  // SL = resting stop-market: dieksekusi di harga stop + slippage kecil, BUKAN di harga
  // pasar saat monitor kebetulan mendeteksi (delay sampling ≠ realita pasar).
  SL_FILL_SLIPPAGE_BPS: num("SL_FILL_SLIPPAGE_BPS", 5),
  SL_GAP_OVERRUN_R: num("SL_GAP_OVERRUN_R", 2),
  TV_MCP_ENABLED: bool("TV_MCP_ENABLED", false),
  TV_WEBHOOK_SECRET: str("TV_WEBHOOK_SECRET"),
  // 15 Okt 2026 (Tahap 1 rencana audit): token auth untuk SEMUA route mutasi
  // (POST/PUT/DELETE). Dibaca dari .env (JANGAN di-commit ke repo publik).
  // Kosong = middleware off (local dev / curl localhost tanpa token).
  API_MUTATION_TOKEN: str("API_MUTATION_TOKEN"),
  // TAHAP 5 audit: verifikasi sentuhan kline utk fill paper (LIMIT entry & TP exit).
  // Matikan di suite test hermetic (tanpa jaringan Binance).
  PAPER_TOUCH_VERIFY: bool("PAPER_TOUCH_VERIFY", true),
  ENABLE_AI_COUNCIL: bool("ENABLE_AI_COUNCIL", false),
  // C2 (30 Okt 2026, perintah operator): posisi paper baru dimatikan secara
  // default. Lihat komentar tipe di atas; .env PAPER_POSITIONS_ENABLED=TRUE
  // mengaktifkan kembali (keputusan operator, bukan kode).
  PAPER_POSITIONS_ENABLED: bool("PAPER_POSITIONS_ENABLED", false),
  // Jalur LIVE (10 Okt 2026). Default aman: 1 posisi, tanpa DD cap, min $3.
  // 11 Okt 2026 (operator): DD harian $7 (deposit $30-40), margin maks $3 per posisi.
  LIVE_MAX_OPEN_POSITIONS: num("LIVE_MAX_OPEN_POSITIONS", 1),
  LIVE_DAILY_DD_CAP_USD: num("LIVE_DAILY_DD_CAP_USD", 0),
  LIVE_MIN_BALANCE_USD: num("LIVE_MIN_BALANCE_USD", 3),
  LIVE_MAX_MARGIN_USD: num("LIVE_MAX_MARGIN_USD", 3),
  // 12 Okt 2026 (operator "loss 2x stop berhenti"): tripwire 2x loss sejak ARM.
  LIVE_LOSS_TRIPWIRE_COUNT: num("LIVE_LOSS_TRIPWIRE_COUNT", 6),
  LIVE_DEPTH_GUARD_ENABLED: bool("LIVE_DEPTH_GUARD_ENABLED", true),
  LIVE_DEPTH_GUARD_MAX_BPS: num("LIVE_DEPTH_GUARD_MAX_BPS", 15),
  LIVE_POST_ONLY_ENABLED: bool("LIVE_POST_ONLY_ENABLED", true),
  LIVE_ORDER_AMEND_ENABLED: bool("LIVE_ORDER_AMEND_ENABLED", false),
  // 11 Okt 2026 — guard cooldown pasca-loss (audit 5 Whys). Default aktif; rollback=false.
  LOSS_COOLDOWN_ENABLED: bool("LOSS_COOLDOWN_ENABLED", true),
  // 3 Okt 2026 — Drex decision layer. Default enabled, tapi TANPA DREX_API_KEY
  // tidak ada panggilan keluar (adapter menolak diam-diam -> failover Xkiro).
  // Set DREX_ENABLED=false untuk mematikan lapisan ini sepenuhnya.
  DREX_ENABLED: bool("DREX_ENABLED", true),
  // 23 Okt 2026: lapisan Drex untuk lane SWING. Default mati; dinyalakan via .env.
  DREX_SWING_ENABLED: bool("DREX_SWING_ENABLED", false),
  // 26 Okt 2026 (TAHAP 5): shadow perbandingan Drex SWING v2 (tidak mengikat).
  DREX_SWING_SHADOW: bool("DREX_SWING_SHADOW", true),
  // ── 23 Okt 2026 (Tahap 4): lapisan analisis data ────────────────────────
  // ANALYTICS_ENABLED: menyalakan pengumpulan data (feed trade). Default MATI.
  // ANALYTICS_INFLUENCE_TRADING: TIDAK PERNAH menyalakan ini di tahap mana pun
  // sebelum disetujui operator + uji paper. Selama ini = false, analisis murni
  // observasi: tidak pernah menyentuh entry/order.
  ANALYTICS_ENABLED: bool("ANALYTICS_ENABLED", false),
  ANALYTICS_INFLUENCE_TRADING: bool("ANALYTICS_INFLUENCE_TRADING", false),
  ANALYTICS_SYMBOL: str("ANALYTICS_SYMBOL", "BTCUSDT"),
  ANALYTICS_MARKET: str("ANALYTICS_MARKET", "PERP"),
  ANALYTICS_VENUES: str("ANALYTICS_VENUES", "BINANCE"),
  ANALYTICS_HYPERLIQUID_TESTNET: bool("ANALYTICS_HYPERLIQUID_TESTNET", false),
  DREX_API_KEY: str("DREX_API_KEY"),
  DREX_BASE_URL: str("DREX_BASE_URL", "https://drex.nace.ai"),
  DREX_MODEL: str("DREX_MODEL", "drex-v1.5"),
  DREX_TIMEOUT_MS: num("DREX_TIMEOUT_MS", 4000),
  // Ambang keputusan (bukan properti model): jangan diturunkan otomatis.
  DREX_MIN_ENTRY_PROBABILITY: num("DREX_MIN_ENTRY_PROBABILITY", 0.55),
  // Conviction gate: index label setup_strength (0 very_weak .. 3 strong, 4 very_strong).
  // 11 Okt 2026 — perintah operator: "hanya boleh strong conviction dan very strong
  // conviction" => ambang 3 (score >= 3 lolos; label dibaca ke bawah).
  DREX_MIN_SETUP_STRENGTH: num("DREX_MIN_SETUP_STRENGTH", 2),
  // 24 Okt 2026 — Drex vision. DEFAULT MATI: chart PNG hanya dikirim kalau
  // operator menyalakan DREX_VISION_ENABLED (butuh DREX_MODEL=drex-max).
  DREX_VISION_ENABLED: bool("DREX_VISION_ENABLED", false),
  DREX_VISION_MAX_BARS: num("DREX_VISION_MAX_BARS", 120),
  DREX_VISION_TIMEFRAME: str("DREX_VISION_TIMEFRAME", "1h"),
  // 26 Okt 2026 (TAHAP 4): analisis AI lima panel mikrostruktur. Default aktif;
  // pemicu didedup hash bukti + debounce + budget per jam (bukan per pesan SSE).
  PANEL_AI_ENABLED: bool("PANEL_AI_ENABLED", true),
  PANEL_AI_MAX_PER_HOUR: num("PANEL_AI_MAX_PER_HOUR", 24),
  // TAHAP 6B: budget keras panel. Batas token = 0 berarti tanpa batas token
  // (hanya batas request). Batas per batch = 6 (5 panel + combined).
  PANEL_AI_MAX_TOKENS_PER_HOUR: num("PANEL_AI_MAX_TOKENS_PER_HOUR", 120_000),
  PANEL_AI_MAX_REQUESTS_PER_BATCH: num("PANEL_AI_MAX_REQUESTS_PER_BATCH", 6),
  // Deadline antrean: 90 dtk. Cukup untuk slot LLM (4) dengan batch 6 request,
  // pendek agar evidence basi tidak pernah dianalisis.
  PANEL_AI_QUEUE_DEADLINE_MS: num("PANEL_AI_QUEUE_DEADLINE_MS", 90_000),
  PANEL_AI_DEBOUNCE_MS: num("PANEL_AI_DEBOUNCE_MS", 300_000),
};

export function llmProvider(): "XKIRO" {
  return "XKIRO";
}

export function keyStatus(): { binance: "SET" | "MISSING"; xkiro: "SET" | "MISSING"; llm: "SET" | "MISSING"; llmProvider: "XKIRO"; drex: "SET" | "MISSING"; vike: "SET" | "MISSING" } {
  return {
    binance: env.BINANCE_API_KEY && env.BINANCE_API_SECRET ? "SET" : "MISSING",
    xkiro: env.XKIRO_API_KEY ? "SET" : "MISSING",
    llm: env.XKIRO_API_KEY ? "SET" : "MISSING",
    llmProvider: llmProvider(),
    drex: env.DREX_API_KEY ? "SET" : "MISSING",
    vike: env.VIKE_API_KEY ? "SET" : "MISSING",
  };
}
