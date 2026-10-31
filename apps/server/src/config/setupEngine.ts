// apps/server/src/config/setupEngine.ts
// KONFIGURASI MESIN SETUP (zona/POI, SL struktural, TP level).
// Semua angka deterministik & bisa di-override lewat env agar operator bisa tuning tanpa deploy ulang.
export const SETUP_ENGINE = {
  /** Band jarak SL (persen harga entry). SL struktural di-clamp ke band ini. */
  slBand: {
    // SCALP dilebarkan (perintah operator 26 Sep 2026): 1.2%-2.5% agar tidak
    // mudah tersapu noise; risiko TETAP $1 (qty mengecil mengikuti SL).
    // 30 Sep 2026 — refactor SCALP-only: entri mode lama dihapus.
    SCALP: { min: 0.012, max: 0.025 },
  },
  /**
   * 13 Okt 2026: batas atas band SL SWING — dipakai riskEngine
   * (calculateOrderPlan) sebagai cap SL mode SWING, dan marginPolicy
   * (SWING_STRUCTURAL_SL_REQUIRED).
   *
   * 20 Okt 2026 (operator: "polaris hapus juga"): override per-strategi
   * "S-05" DIHAPUS (strateginya mati -> override yatim). Band SWING kini
   * hidup INDEPENDEN dari override strategi apa pun, karena tiga strategist
   * RSW yang tersisa punya SL struktural median 3,4%-4,3% (master_v2 executed)
   * — jauh di atas cap SCALP 2,5%.
   *
   * 27 Okt 2026 (operator: "Max SL% 2.5% 20% itu terlalu lebar, ambil dari
   * data lowest SL dari 3 strategi swing gw"): cap 0,2 (20%) adalah ANGKA
   * MATI — tak pernah bisa dicapai. Bukti terukur di
   * research/out/master_v2/master_ledger.json (20.014 sinyal RSW-01/02/03,
   * 38 simbol, 2022-2026):
   *   - max SL per strategi: RSW-01 5,997671% | RSW-02 5,996722% | RSW-03 5,998393%
   *   - TERENDAH dari trio = 5,996722% (RSW-02) -> dipakai sebagai cap
   *   - 0 sinyal melewati 6% (mesin rswSignals.ts:373,531 sudah hard-cap 6%)
   * Cap 6% adalah batas yang TIDAK bisa dilampaui mesin strategi, jadi angka
   * yang paling jujur & aman: 0,06 (dibulatkan ke atas dari 5,9967% agar
   * pembulatan tick_size tidak menolak sinyal sah di batas).
   * Dampak: 0 sinyal legit ditolak (0,000%); cap lama 20% menolak 0 juga —
   * jadi perubahan ini MENYEMPITKAN proteksi tanpa mengubah entry mana pun.
   */
  SWING_SL_BAND_MAX: 0.06,
  /**
   * 27 Okt 2026: band KHUSUS arsip S-05 "Polaris" (replay historis).
   *
   * S-05 punya geometri SL sendiri (garis berlawanan x2) yang JAUH lebih
   * lebar daripada trio RSW: fixture terukur 2,16% (BTC) s/d 18,74% (DOGE),
   * dan master_ledger S-05 n=23.887 dengan max 91,99%. Jika cap global
   * diturunkan ke 6%, replay S-05 jadi rusak: 57,87% sinyal S-05 terbuang
   * (13.823 dari 23.887).
   *
   * S-05 SUDAH NON-ENTRY (retired 20 Okt 2026, deleted dari katalog aktif
   * 21 Okt 2026) — mesinnya hanya hidup untuk historicalReplay + worker
   * forward paper Polaris. Jadi arsipnya memakai band TERPISAH, dan cap
   * ketat 6% hanya berlaku untuk entry source aktif (RSW-01/02/03).
   * Nilai 0,2 (20%) PERTAMAAN: cap lama juga menerima semua sinyal S-05
   * (max 91,99% > 20% -> 0,9% sinyal terbuang), jadi angka ini LEBIH LEBAR
   * dari cap lama untuk arsip — arsip tidak boleh makin sempit.
   */
  SWING_ARCHIVE_SL_BAND_MAX: 0.2,
  /**
   * 27 Okt 2026: toleransi cap SL SWING untuk artefak pembulatan tick.
   *
   * SL struktural di-grid ke tick_size symbol (round AWAY dari entry, supaya
   * SL tak pernah masuk ke dalam invalidasi). Efeknya: % SL bisa naik sedikit
   * di atas cap murni karena pembulatan harga. Tanpa toleransi, 10 dari
   * 20.014 sinyal RSW (0,05%) ditolak palsu — deviasi maks 0,0565pp, masih
   * di bawah 1 tick (tick/E 0,0904pp untuk NEARUSDT).
   *
   * Nilai 0,0001 = 0,01pp: cukup menutup deviasi terukur (maks 0,0565pp)
   * TAPI terlalu kecil untuk menutup tick penuh — jadi tick_size yang besar
   * tetap menolak lewat `Math.max(tick/E, ...)`. Batas keras tetap 6% + tick.
   */
  SWING_SL_CAP_TOLERANCE_PCT: 0.0001,
  /** Jarak maksimum harga ke zona agar entry limit masih valid (anti entry basi). */
  zoneProximityPct: 0.006,
  /** Jarak maksimum level entry ke harga live (fill tidak boleh "ajaib" di harga jauh). */
  // SWING (13 Okt 2026): sinyal dievaluasi di close bar 1h yang baru tutup;
  // harga live boleh menyimpang maks 1% dari close sinyal (anti mengejar
  // breakout yang sudah lari jauh / anti entry sinyal basi). Deterministik.
  maxEntryGapPct: { SCALP: 0.003, SWING: 0.01 },
  /** Batas kompatibilitas umum; validasi entry memakai rrByMode di bawah. */
  minRr1: 1.2,
  /** Perintah operator 2 Okt 2026: RR KLASIK BARU, satu target saja.
   * Tidak ada lagi split 65% TP1 / 35% TP2. Seluruh posisi keluar di satu TP.
   * SCALP TP = 1.5R, satu target tunggal (tp1Price).
   * Opsi lama (>1.5R) telah dihapus sepenuhnya dari slTpMenu. */
  rrByMode: {
    // 2 Okt 2026 — perintah operator: Ubah TP klasik menjadi 1.5R.
    // 11 Okt 2026 — perintah operator: TP klasik menjadi 1.7R ("buat jadi 1.7$ dah TP nya
    // dikarenakan maximal risk nya 1-1.2$"). Risk per trade tetap $1 (maks $1.2).
    SCALP: { tp1R: 1.7 },
    // 17 Oct: new PAPER swing entries use 50% at 2R, BE, 50% at 3R.
    // Supervisor preserves unversioned positions under their legacy ladder.
    SWING: { tp1R: 2 },
  },
  /**
   * Menu SL/TP deterministik (Opsi 2 Hybrid, 2 Okt 2026). LLM hanya MEMILIH ID
   * varian; seluruh angka SL/TP tetap dihitung kode (calculator-owned). Nilai R
   * wajib >= minRr1 dan tidak pernah lebih agresif dari tp1R klasik.
   * PERINTAH OPERATOR 2 OKT 2026: Hapus opsi lama (>1.5R). Hanya 1.5R yang valid.
   */
  slTpMenu: {
    /** Kandidat R TP pra-hitung. tpR[0] WAJIB sama dengan rrByMode.SCALP.tp1R. */
    tpR: [1.7],
  },
  /**
   * Buffer ATR untuk SL struktural (di balik invalidasi zona / ekstrem pivot).
   * Operator 29 Sep 2026: pengali scalp +15%. ATR pasar tidak
   * dimanipulasi; hanya buffer/minimum SL. Batas SL 2.5% dan risiko $1 tetap.
   */
  slBufferAtr: { SCALP: 0.46 },
  /** Minimum jarak SL dari harga (x ATR trigger). */
  minSlAtr: { SCALP: 0.805 },
  /** Skor zona minimum agar bisa dipakai entry (FR-09). */
  minZoneScore: 50,
  /** Jumlah lilin struktur untuk mencari pivot high/low (TP struktural). */
  structureLookbackBars: 60,
  /**
   * Override gate PER-STRATEGI (6 Okt 2026, renumber 3 strategi).
   * Strategi TANPA entri di sini memakai angka default di atas (slBand SCALP,
   * rrByMode SCALP 1.5R) — tidak berubah satu bit.
   * - slBandValidateOnly=true: band hanya MEMVALIDASI SL struktural, TIDAK PERNAH
   *   menggesernya (menggeser SL = merusak geometri strategi). SL di luar band
   *   membuat plan ditolak, bukan di-clamp.
   * - tp1R: target R tunggal khas strategi (S-03 Fib zona 0.5-0.618 = 1.5R
   *   DIPAKSA dari entry, keputusan operator 7 Okt 2026; backtest 540 hari:
   *   satu-satunya varian zona yang positif di kedua bound intrabar).
   * - minCandidateScore/minKnn: ambang kelayakan kandidat khas strategi (6 Okt
   *   2026, perintah operator "rules Fib terpisah, jangan ikut sistem lama").
   *   Dasar angka (763 kandidat Fib live): skor Fib 63-75 (median 67) karena
   *   setup pullback memang tanpa trigger momentum segar; KNN p50=0.4 karena
   *   library analog belum mengenal pola Fib (out-of-domain, bukan jelek).
   *   65/0.35 = tetap menolak ekor bawah; nilai TETAP (tidak progresif).
   */
  strategyGateOverrides: {
    // CATATAN 20 Okt 2026 (perintah operator): override "S-03" (Fibonacci) dan
    // "S-04" (Mean-Reversion Stretch) KEDUA-NYA DIHAPUS — tidak ada lagi
    // strategi Fibonacci/MRV aktif di lane mana pun.
    // S-05 Swing Breakout Pattern (13 Okt 2026, perintah operator: "Swing semua
    // untuk Live trading dan paper mode backtest di website"). SL struktural
    // mesin (garis berlawanan x2, konvensi riset sim4) TIDAK PERNAH digeser —
    // band VALIDATE-ONLY (preseden S-03/S-04). Data terukur 877 sinyal 1h
    // Apr-Okt 2026 (5 simbol, fixtures/swing/signals_parity.json): slPct median
    // 4.74%, p5 1.24% — band SCALP 1-2.5% akan menolak >80% sinyal tervalidasi
    // (melawan backtest 16/16). Batas atas = sanity notional Binance ($5):
    // slPct 20% pada risiko $1 -> notional $5 tepat; cap 20% hanya menolak
    // 8/877 sinyal (0.9%). SWING sekarang RR23: TP1 50% @2R + final 50% @3R.
    // rrPolicyForMode("SWING") selalu memakai rrByMode.SWING=2R; field ini
    // dipertahankan sebagai metadata kompatibilitas, bukan override aktif.
  } as Record<string, { slBand: { min: number; max: number }; slBandValidateOnly: boolean; tp1R: number; minCandidateScore?: number; minKnn?: number }>,
  /** Berapa pair teratas yang dianalisis multi-timeframe per siklus (hemat kuota REST). */
  mtfTopN: 48,
  /** TTL cache analisis MTF per pair (ms). */
  mtfCacheTtlMs: 45_000,
} as const;

// 30 Sep 2026 — refactor SCALP-only: hanya ada satu mode (SCALP).
// 13 Okt 2026 — perintah operator ("Swing semua untuk Live trading dan paper
// mode backtest di website"): mode SWING kembali untuk S-05 Swing Breakout
// Pattern. SCALP tetap utuh seperti sebelumnya (fail-closed ke perilaku lama).
export type SetupMode = "SCALP" | "SWING";

let activeTp1R: Record<string, number> = {};
let activeTp1Version: Record<string, string> = {};

export function rrPolicyForMode(mode: SetupMode, strategyId?: string, explicitTp1R?: number) {
  const override = strategyId ? SETUP_ENGINE.strategyGateOverrides[strategyId.toUpperCase()] : undefined;
  // Fibonacci shares an ID across modes, but its scalp TP must not override the swing ladder.
  const base = mode === "SWING" ? SETUP_ENGINE.rrByMode.SWING
    : override ? { tp1R: override.tp1R } : SETUP_ENGINE.rrByMode[mode];
  if (mode === "SWING") return base; // Operator-fixed 2R; tuners/LLM cannot override it.
  const key = strategyId ? `${mode}:${strategyId.toUpperCase()}` : "";
  const tp1R = explicitTp1R ?? activeTp1R[key];
  return tp1R === undefined ? base : { ...base, tp1R };
}

/**
 * Buffer ATR SL struktural (SCALP-only sejak 30 Sep 2026).
 *
 * CATATAN 21 Okt 2026 (Phase 6, P-6.1): `_mode` SENGAJA diabaikan — hanya
 * `SETUP_ENGINE.slBufferAtr.SCALP` yang ada di katalog. SWING karena itu
 * MEWARISI buffer SCALP (0.46) di `buildSlTpMenu` (setupStrategies.ts:325)
 * dan di evaluate* (L597/L765). Ini adalah perilaku warisan yang TIDAK
 * tervalidasi untuk SWING: tidak ada nilai SWING yang terukur, jadi TIDAK
 * boleh di sini. Menetapkan angka SWING baru memerlukan backtest +
 * ParameterVersion baru (aturan main), bukan angka karangan.
 * `minSlAtrFor` (j lantai SL) punya masalah yang sama dan tidak punya
 * pemanggil sama sekali — lihat catatan di file tersebut.
 */
export function slBufferAtrFor(_mode: SetupMode): number {
  return SETUP_ENGINE.slBufferAtr.SCALP;
}

/**
 * Lantai jarak SL ke harga (x ATR trigger) — SCALP-only sejak 30 Sep 2026.
 *
 * CATATAN 21 Okt 2026 (Phase 6): fungsi ini TIDAK punya pemanggil di repo
 * (dicek `grep -rn minSlAtrFor apps/server/src` — 0 call site; import yang
 * pernah ada di setupStrategies.ts sudah dihapus). Import yang membawanya
 * tidak boleh dikembalikan. Jika suatu saat dipakai: nilai SWING juga belum
 * ada — jangan mengarang angka, tunduh ParameterVersion + backtest dulu.
 */
export function minSlAtrFor(_mode: SetupMode): number {
  return SETUP_ENGINE.minSlAtr.SCALP;
}

/** Load only the one bounded parameter that replay and live planning both implement. */
export function setRuntimeTp1R(mode: SetupMode, strategyId: string, tp1R: number, version: string): boolean {
  const override = SETUP_ENGINE.strategyGateOverrides[strategyId.toUpperCase()];
  // Fibonacci shares an ID across modes, but its scalp TP must not override the swing ladder.
  const base = mode === "SWING" ? SETUP_ENGINE.rrByMode.SWING
    : override ? { tp1R: override.tp1R } : SETUP_ENGINE.rrByMode[mode];
  // RR dikunci per strategi (operator 2 Okt 2026): hanya tepat base.tp1R yang
  // diterima — 1.5R klasik untuk strategi tanpa override dan 1.5R dipaksa
  // untuk S-03 Fib zona (strategyGateOverrides). Proposal lain DITOLAK. Bug lama:
  // clamp ke 1.4 justru menolak 1.5 tapi menerima 1.2-1.4 (TP turun di bawah klasik).
  const key = `${mode}:${strategyId.toUpperCase()}`;
  if (!strategyId.trim() || !Number.isFinite(tp1R) || Math.abs(tp1R - base.tp1R) > 1e-6 || !version.trim()) return false;
  activeTp1R[key] = base.tp1R;
  activeTp1Version[key] = version;
  return true;
}

export function clearRuntimeTp1R(): void {
  activeTp1R = {};
  activeTp1Version = {};
}

export function runtimeParameterVersion(mode: SetupMode, strategyId: string): string | null {
  return activeTp1Version[`${mode}:${strategyId.toUpperCase()}`] ?? null;
}

export function slBandFor(mode: string, atrPct?: number | null, strategyId?: string): { min: number; max: number } {
  const override = strategyId ? SETUP_ENGINE.strategyGateOverrides[strategyId.toUpperCase()] : undefined;
  // 14 Okt 2026 (perintah operator: "ini mode swing bukan scalping") — LANTAI
  // MINIMUM SL mode SWING = 1.2% (p5 dari 877 sinyal S-05 tervalidasi; median
  // 4.74%). SL struktural lebih tipis dari ini = geometri scalp pada bar 1h,
  // plan DITOLAK (validate-only — geometri tidak pernah digeser). Akibat
  // ekonomisnya: notional = risiko $1 / SL%, jadi SL tipis membuat notional &
  // margin membengkak (kasus MAGMAUSDT: SL 0.75% -> notional $133).
  if (mode === "SWING") {
    // 20 Okt 2026 (operator: "polaris hapus juga"): override "S-05" dihapus
    // -> band SWING TIDAK boleh lagi bergantung pada override per-strategi.
    // Sumber tunggal = SWING_SL_BAND_MAX, sama dengan cap riskEngine.
    // Tanpa ini, RSW-01/02/03 jatuh ke band SCALP (max 2,5%) padahal SL
    // strukturalnya median 3,4%-4,3% -> 78%-92% sinyal legit ditolak.
    //
    // 27 Okt 2026: S-05 (arsip replay) memakai band TERPISAH — geometri SL-nya
    // (garis berlawanan x2) jauh lebih lebar (s/d 18,74% terukur) dan bukan
    // entry source. Cap 6% hanya untuk trio RSW aktif.
    if (strategyId && strategyId.toUpperCase() === "S-05") {
      return { min: 0.012, max: SETUP_ENGINE.SWING_ARCHIVE_SL_BAND_MAX };
    }
    return { min: 0.012, max: SETUP_ENGINE.SWING_SL_BAND_MAX };
  }
  // 14 Okt 2026 — S-03 di lane SCALP: band strategi apa adanya (validate-only,
  // SL struktural fib tidak pernah digeser).
  // CATATAN 20 Okt 2026: S-03 Fibonacci dihapus operator -> cabang override
  // S-03 tidak lagi ada; baris di bawah hanya berlaku untuk override lain.
  if (override) return override.slBand;
  // The order planner and Wardha both enforce <=2.5% SL. Reject wider
  // structural invalidation at setup time so Arka never approves an
  // impossible order (observed 2.55% S-04 GO followed by zero positions).
  void atrPct;
  return SETUP_ENGINE.slBand.SCALP;
}

/**
 * true = band strategi hanya MEMVALIDASI SL struktural (tidak menggeser SL).
 * Berlaku untuk S-03 Fibonacci: SL wajib di level 1.0 fib apa adanya.
 */
export function slBandIsValidateOnly(strategyId?: string | null): boolean {
  const override = strategyId ? SETUP_ENGINE.strategyGateOverrides[String(strategyId).toUpperCase()] : undefined;
  return override?.slBandValidateOnly === true;
}

/** Daftar R TP yang boleh ditawarkan menu untuk strategi tertentu. */
export function tpMenuRsFor(strategyId?: string | null, mode: SetupMode = "SCALP"): number[] {
  if (mode === "SWING") return [SETUP_ENGINE.rrByMode.SWING.tp1R];
  const override = strategyId ? SETUP_ENGINE.strategyGateOverrides[String(strategyId).toUpperCase()] : undefined;
  return override ? [override.tp1R] : [...SETUP_ENGINE.slTpMenu.tpR];
}
