// apps/server/src/universe/assetClassGuard.ts - Penjaga kelas aset (crypto-only).
// PENTING: Binance Futures kini punya kontrak TRADFI (komoditas/equity/index)
// yang tetap lolos filter underlyingType="COIN" di exchangeInfo.
// Contoh nyata: BZUSDT (Brent Crude Oil) sempat lolos & ditradingkan.
// Modul ini = deny-by-default untuk aset NON-CRYPTO di jalur entry.
// Aturan: komoditas/equity/index/saham SELAMANYA diblokir (Rules.md §8).
// TAMBAHAN 25 Sep 2026: simbol WAJIB alfanumerik murni (A-Z, 0-9) + USDT.
// Ini menutup lubang simbol aneh/emoji/CJK (contoh nyata: "龙虾USDT" lolos
// dari feed ticker dan sempat dibuka posisinya oleh bot).
//
// REGISTRY DINAMIS (25 Sep 2026): daftar statis di bawah BUKAN satu-satunya
// sumber kebenaran — Binance terus menambah simbol TRADFI baru (KORUUSDT,
// SKHYNIXUSDT, PLTRUSDT lolos daftar statis). `setExchangeNonCrypto()` diisi
// dari /fapi/v1/exchangeInfo live oleh UniverseManager.syncOnce() sehingga
// SEMUA simbol non-COIN/non-PERPETUAL/non-USDT/non-TRADING ikut diblokir
// tanpa perlu update kode. Daftar statis tetap dipertahankan sebagai fallback
// offline bila sync belum pernah jalan.

// Basis komoditas & proxy yang dikenal di pasar (huruf besar, tanpa USDT).
// Mencakup emas (XAU, GOLD, PAXG), perak (XAG, SILVER), minyak (BZ, CL, OIL, WTI, CRUDE),
// gas (NG, NATGAS), logam industri (COPPER, HG, XPT, XPD, ALUMINUM, NICKEL, ZINC, LEAD,
// PLATINUM, PALLADIUM), dan agrikultur.
export const COMMODITY_BASES: ReadonlySet<string> = new Set([
  "BZ",         // Brent Crude Oil
  "BRENT",
  "CL",         // WTI Crude Oil
  "WTI",
  "OIL",
  "CRUDE",
  "NG",         // Natural Gas
  "NATGAS",
  "XAU",        // Gold / Emas
  "GOLD",
  "PAXG",       // Gold-backed crypto token
  "XAG",        // Silver / Perak
  "SILVER",
  "XPT",        // Platinum
  "PLATINUM",
  "XPD",        // Palladium
  "PALLADIUM",
  "HG",         // Copper / Tembaga
  "COPPER",
  "IRON",
  "STEEL",
  "URANIUM",
  "COAL",
  "WHEAT",
  "CORN",
  "SOY",
  "SOYBEAN",
  "COFFEE",
  "SUGAR",
  "COCOA",
  "COTTON",
  "ALUMINUM",
  "NICKEL",
  "ZINC",
  "LEAD",
  "LUMBER",
  "RICE",
  "OATS",
  "ETHANOL",
]);

// Basis ETF, inverse ETF, leveraged ETF, dan indeks tradisional yang diblokir.
export const ETF_BASES: ReadonlySet<string> = new Set([
  // Index & Market ETFs
  "SPY", "QQQ", "DIA", "IWM", "EEM", "EWY", "EWJ", "EWT", "EWZ", "FXI", "KORU",
  "KODEX200", "CSOPSKHYNIX2L", "CSOPSAMSUNG2L", "BOT", "SP500", "US500", "NAS100",
  "US30", "DXY", "VIX", "UVXY", "SVXY", "VXX",
  // Leveraged / Inverse ETFs
  "TQQQ", "SQQQ", "SOXL", "SOXS", "TZA", "TMF", "TBT", "NVDL", "TSLL",
  // Sector & Thematic ETFs
  "XLE", "XLF", "XLK", "XLI", "XLU", "XLP", "XLY", "XLV", "XLB", "XLC", "XBI",
  "IBB", "GDX", "GDXJ", "SMH", "SOXX", "URNM", "ARKK", "BITO", "HYG", "LQD",
  "TLT", "AGG", "GLD", "SLV", "USO", "UNG", "DBC", "IYR", "VNQ",
]);

// Basis ekuitas / saham US, Asia, EU, dan premarket yang diblokir.
export const EQUITY_BASES: ReadonlySet<string> = new Set([
  // US Mega & Large Cap Equities & Major Indices
  "AAPL", "ABNB", "ADBE", "AGPU", "ALAB", "AMAT", "AMC", "AMD", "AMZN", "ANET",
  "APLD", "APP", "ARM", "ASTS", "AVGO", "AXTI", "BA", "BABA", "BBX", "BE", "BILI",
  "BMNR", "BRK", "BRKB", "BSP", "BX", "CAT", "CBRS", "CIEN", "CLSK", "COHR",
  "COIN", "COKE", "COST", "CRCL", "CRDO", "CRM", "CRWD", "CRWV", "CSCO", "CXMT",
  "CYPH", "DDOG", "DE", "DELL", "DIS", "DJI", "DJT", "DKNG", "DRAM", "EBAY",
  "F", "FLEX", "FLNC", "FWDI", "GE", "GEV", "GIGADEV", "GLW", "GM", "GME",
  "GOOG", "GOOGL", "GPRO", "GRAB", "GS", "GTLB", "HD", "HIMS", "HPE", "HOOD",
  "HUT", "IBM", "INTC", "INTW", "IONQ", "IREN", "JNJ", "JPM", "KLAC", "KO",
  "KSTR", "LITE", "LLY", "LRCX", "LYTE", "MA", "MARA", "MCD", "MDB", "META",
  "MINIMAX", "MOONSHOT", "MRK", "MRNA", "MRVL", "MS", "MSFT", "MSTR", "MU",
  "MUU", "MVLL", "NBIS", "NET", "NFLX", "NOK", "NOW", "NVDA", "NVO", "ONDS",
  "OPENAI", "ORCL", "OURA", "PANW", "PATH", "PAYP", "PDD", "PENG", "PEP", "PFE",
  "PLTR", "POPMART", "PYPL", "QCOM", "QNTX", "QQQ", "RAM", "RDDT", "RIOT", "RIVN", "RKLB",
  "SCHW", "SE", "SHAZ", "SHOP", "SKDD", "SKUU", "SMCI", "SNDK", "SNOW", "SNXX",
  "SOFI", "SPCX", "SPX", "SPY", "SQ", "STRC", "STXX", "TEAM", "TEM", "TER", "TM",
  "TSLA", "TSM", "TTWO", "TXN", "UBER", "UNITREE", "UPST", "USAR", "V", "VRT",
  "VST", "WDC", "WEN", "WFC", "WMT", "ZHIPU", "ZM", "ZS",
  // Asian Equities & Tickers
  "BYD", "HANMI", "HK0625", "HK0700", "HK0992", "HK1810", "HYUNDAI", "KUAISHOU",
  "LGELECTRONICS", "MEITUAN", "NAVER", "SAMSUNG", "SAMSUNGEM", "SKHY", "SKHYNIX",
  "SONY", "TENCENT", "ZHONGJI",
  // Premarket / AI Startups
  "ANTHROPIC",
]);

export const REASON_COMMODITY = "NON_CRYPTO_COMMODITY_BLOCKED";
export const REASON_EQUITY = "NON_CRYPTO_EQUITY_BLOCKED";
export const REASON_ETF = "NON_CRYPTO_ETF_BLOCKED";
export const REASON_SYMBOL_FORMAT = "SYMBOL_FORMAT_INVALID";

export interface AssetClassCheck {
  blocked: boolean;
  reason: string | null;
  baseAsset: string;
  assetClass: "CRYPTO" | "COMMODITY" | "EQUITY" | "INDEX" | "FX" | "OTHER" | "INVALID";
}

/** Baris ringkas exchangeInfo yang dibutuhkan penjaga (tanpa filter/precision). */
export interface ExchangeSymbolInfo {
  symbol: string;
  contractType?: string;
  underlyingType?: string;
  quoteAsset?: string;
  status?: string;
  baseAsset?: string;
}

// 16 Okt 2026 (perintah operator: "gw ga mau trading di koin fan"): fan token
// TIDAK PERNAH ditrade — masuk blacklist permanen saat sinkron universe dan
// ditolak guard entry. Metadata Binance TIDAK punya kategori fan-token di
// underlyingSubType (dicek /fapi/v1/exchangeInfo & spot exchangeInfo, 16 Okt
// 2026), jadi daftar base-asset dikurasi dari daftar resmi Binance Fan Token +
// kategori CoinGecko "fan-token". Tambah base baru bila Binance listing fan
// token lain. (Operator: blacklisted via alasan "fan-token:operator".)
export const FAN_TOKEN_BASES: ReadonlySet<string> = new Set([
  "ACM", "AFC", "ALPINE", "ASR", "ATM", "BAR", "CITY", "GAL", "JUV", "LAZ", "LAZIO",
  "LEG", "MENGO", "NAP", "OG", "PSG", "POR", "PORTO", "SANTOS", "SPFC", "TRA",
  "ESPORTS", "SPORTFUN",
]);

/** Base asset dari info simbol; fallback: strip suffix quote dari symbol. */
function baseAssetOf(raw: ExchangeSymbolInfo): string {
  const base = raw.baseAsset ?? String(raw.symbol ?? "").replace(/(USDT|USDC|USD1|BUSD|PERP)$/, "");
  return base.toUpperCase();
}

// ── REGISTRY DINAMIS (sumber live /fapi/v1/exchangeInfo) ──
// Kosong sampai UniverseManager.syncOnce() sukses pertama kali; SELAMA KOSONG
// checkAssetClass tetap aman memakai daftar statis di atas.
const dynamicNonCrypto = new Map<string, string>(); // SYMBOL -> alasan (mis. "non-crypto:EQUITY")

/**
 * Klasifikasi deny-by-default murni (tanpa blacklist manual):
 * mengembalikan alasan blokir atau null bila simbol lolos whitelist
 * PERPETUAL + COIN + USDT + TRADING. Dipakai bersama oleh guard ini dan
 * UniverseManager supaya klasifikasi di 2 tempat tidak pernah berbeda.
 */
export function classifyExchangeNonCrypto(raw: ExchangeSymbolInfo): string | null {
  const symbol = String(raw.symbol ?? "").toUpperCase();
  const underlying = raw.underlyingType ?? "?";
  if (symbol === "BTCDOMUSDT") return "BTCDOM-data-only";
  // Fan token ditolak paling awal (operator 16 Okt 2026) — alasan tetap spesifik
  // walau simbolnya juga melanggar rule lain.
  if (FAN_TOKEN_BASES.has(baseAssetOf(raw))) return "fan-token:operator";
  if (underlying !== "COIN") return "non-crypto:" + underlying;
  if (raw.contractType !== "PERPETUAL") return "contract:" + String(raw.contractType ?? "?");
  if (raw.quoteAsset !== "USDT") return "quote:" + String(raw.quoteAsset ?? "?");
  if (raw.status !== "TRADING") return "status:" + String(raw.status ?? "?");
  return null;
}

/**
 * Isi registry dinamis dari exchangeInfo live. HANYA boleh dipanggil dengan
 * hasil fetch yang SUCCEED — gagal fetch jangan dipanggil supaya registry lama
 * (yang valid) tidak hilang. Mengembalikan jumlah simbol yang diblokir.
 */
export function setExchangeNonCrypto(rows: ReadonlyArray<ExchangeSymbolInfo>): number {
  dynamicNonCrypto.clear();
  let blocked = 0;
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase();
    const reason = classifyExchangeNonCrypto(row);
    if (reason) {
      dynamicNonCrypto.set(symbol, reason);
      blocked += 1;
    }
  }
  return blocked;
}

/** Jumlah simbol non-crypto di registry dinamis (0 = belum pernah sync). */
export function exchangeNonCryptoCount(): number {
  return dynamicNonCrypto.size;
}

// ── ALLOWLIST PERPETUAL (perintah operator 26 Sep 2026: ONLY FUTURES PAIR) ──
// Daftar simbol yang LOLOS whitelist PERPETUAL + COIN + USDT + TRADING dari
// /fapi/v1/exchangeInfo live. Dipakai lapis DISPLAY (pairs/top/scan) + entry:
// simbol di luar daftar = BUKAN futures perp (spot/delivery/settling/belum sync
// klasifikasi) -> DISEMBUNYIKAN & DITOLAK selama allowlist terisi.
// Kosong sampai syncOnce() sukses pertama kali; SELAMA KOSONG semua check
// fail-open (UI tidak brick saat boot / jaringan mati).
const perpAllowlist = new Set<string>();
let perpAllowlistAtMs = 0;

/** Isi allowlist (HANYA dari fetch exchangeInfo yang SUCCEED). */
export function setExchangePerpUniverse(symbols: Iterable<string>): number {
  perpAllowlist.clear();
  let n = 0;
  for (const s of symbols) {
    const u = String(s ?? "").toUpperCase();
    if (u) {
      perpAllowlist.add(u);
      n++;
    }
  }
  perpAllowlistAtMs = Date.now();
  return n;
}

/**
 * true = futures perp terkonfirmasi; false = BUKAN perp (sembunyikan/tolak);
 * null = allowlist kosong (belum sync) -> fail-open.
 */
export function isPerpListed(symbol: string): boolean | null {
  if (perpAllowlist.size === 0) return null;
  return perpAllowlist.has(String(symbol ?? "").toUpperCase());
}

/** Jumlah perp di allowlist (0 = belum pernah sync). */
export function perpUniverseCount(): number {
  return perpAllowlist.size;
}

/** Reset allowlist (untuk unit test). */
export function clearExchangePerpUniverse(): void {
  perpAllowlist.clear();
  perpAllowlistAtMs = 0;
}

/** Reset registry (untuk unit test; produksi hanya diganti via setExchangeNonCrypto). */
export function clearExchangeNonCrypto(): void {
  dynamicNonCrypto.clear();
}

/** Petakan alasan dinamis ke kelas aset untuk laporan/log. */
function mapDynamicAssetClass(reason: string): AssetClassCheck["assetClass"] {
  if (reason.startsWith("non-crypto:")) {
    const t = reason.slice("non-crypto:".length);
    if (t === "COMMODITY") return "COMMODITY";
    if (t === "INDEX") return "INDEX";
    if (t === "FX") return "FX";
    if (t.includes("EQUITY") || t === "PREMARKET") return "EQUITY";
    return "OTHER";
  }
  if (reason === "BTCDOM-data-only") return "INDEX";
  return "OTHER";
}

/**
 * Ekstrak basis dari simbol Binance Futures (mis. "BZUSDT" -> "BZ").
 * Multiplier seperti 1000PEPE / 1MBABYDOGE dilepas agar tidak salah klasifikasi.
 */
export function extractBaseAsset(symbol: string): string {
  const s = symbol.toUpperCase().replace(/USDT$/, "");
  return s.replace(/^\d+/, ""); // buang prefix multiplier numerik (1000, 1000000)
}

/**
 * Cek kelas aset. Memakai daftar statis + daftar blacklist operator
 * (dari Setting.blacklistManual) sebagai lapis kedua.
 */
export function checkAssetClass(symbol: string, manualBlacklist: ReadonlySet<string> = new Set()): AssetClassCheck {
  const raw = String(symbol ?? "").toUpperCase();
  // Format keras: basis 2-12 huruf/angka murni + USDT. Tolak emoji/CJK/spasi/simbol.
  // Contoh yang ditolak: "龙虾USDT", "BTC USDT", "BTC-PERP", "BTCUSDT ".
  if (!/^[A-Z0-9]{2,12}USDT$/.test(raw)) {
    return { blocked: true, reason: REASON_SYMBOL_FORMAT, baseAsset: raw, assetClass: "INVALID" };
  }
  const base = extractBaseAsset(raw);

  // 1. Registry dinamis exchangeInfo live (sumber primer):
  // Menghormati klasifikasi asli dari bursa (EQUITY, COMMODITY, INDEX, FX, PREMARKET).
  const dynReason = dynamicNonCrypto.get(raw);
  if (dynReason) {
    return { blocked: true, reason: dynReason, baseAsset: base, assetClass: mapDynamicAssetClass(dynReason) };
  }

  // 2. Daftar statis (fallback offline / pre-sync):
  if (COMMODITY_BASES.has(base)) {
    return { blocked: true, reason: REASON_COMMODITY, baseAsset: base, assetClass: "COMMODITY" };
  }
  if (EQUITY_BASES.has(base)) {
    return { blocked: true, reason: REASON_EQUITY, baseAsset: base, assetClass: "EQUITY" };
  }
  if (ETF_BASES.has(base)) {
    return { blocked: true, reason: REASON_ETF, baseAsset: base, assetClass: "INDEX" };
  }

  // 3. Blacklist manual operator (Rules §1.8: manual blacklist SELALU menang):
  if (manualBlacklist.has(raw)) {
    return { blocked: true, reason: "MANUAL_BLACKLIST", baseAsset: base, assetClass: "CRYPTO" };
  }

  return { blocked: false, reason: null, baseAsset: base, assetClass: "CRYPTO" };
}

/**
 * Gate cepat untuk kandidat scanner/entry. Mengembalikan true bila LAYAK
 * ditradingkan (crypto murni & tidak masuk blacklist operator).
 */
export function isCryptoTradeable(symbol: string, manualBlacklist: ReadonlySet<string> = new Set()): boolean {
  return !checkAssetClass(symbol, manualBlacklist).blocked;
}
