/**
 * FR-12: Library analog KNN Lorentzian & FR-13: Skor gabungan 0-100 dan ranking kandidat.
 *
 * Normalisasi fitur (WAJIB sama saat latih & query, bila tidak jarak meaningless):
 * [zoneScore 0-100, triggerScore 0-100, trendScore 0-100, adx, volRatio]
 * dengan volRatio = clamp(volume24hUsd / VOL_NORM_USD, 0.2, 5).
 */
export const KNN_FEATURE_DIM = 5;
export const VOL_NORM_USD = 50_000_000;

export function buildKnnFeatures(input: {
  zoneScore: number;
  triggerScore: number;
  trendScore: number;
  adx?: number | null;
  volume24hUsd?: number | null;
}): number[] {
  const num = (v: unknown, fb: number): number => {
    if (v === null || v === undefined || v === "") return fb;
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  const vol = num(input.volume24hUsd, VOL_NORM_USD);
  const volRatio = Math.min(5, Math.max(0.2, vol / VOL_NORM_USD));
  return [
    num(input.zoneScore, 50),
    num(input.triggerScore, 50),
    num(input.trendScore, 50),
    num(input.adx, 20),
    Number(volRatio.toFixed(4)),
  ];
}

// 30 Sep 2026 — refactor SCALP-only: satu-satunya mode adalah SCALP.
// Item dengan mode lain di file lama DIBUANG saat dimuat (tidak pernah
// menjadi analog untuk kandidat yang kini selalu SCALP).
export type KnnMode = "SCALP" | "SWING";

/**
 * 24 Okt 2026 (BUG FIX kolom KNN kosong di Live Market Scanner):
 * Vektor fitur NEUTRAL yang dipakai sebagai fallback runtime adalah
 * [50, 50, 50, 20, 1] (lihat buildKnnFeatures: zone 50, trigger 50, trend 50,
 * adx 20, volRatio 1). Item yang memakai vektor ini TIDAK membawa informasi
 * diskriminatif apa pun: semua identik, semua jarak Lorentzian-nya sama.
 *
 * Dampaknya fatal pada query: dengan 114 item sentinel identik di pool,
 * K=5 "tetangga terdekat" selalu dipilih dari sentinel itu (jarak tie) dan
 * label win-nya acak -> knnProb = 0 untuk SETIAP kandidat, padahal tidak ada
 * bukti apa pun. Kolom pun tampil "—" (0 = falsy di renderer).
 *
 * Aturan: item dengan vektor netral DIKECUALIKAN dari pool query (bukan
 * dihapus dari penyimpanan — histori tetap utuh untuk audit). Pool query
 * dihitung dari item NON-degenerate, dan ambang n>=50 diukur terhadap pool
 * itu. Tidak ada angka yang dikarang: kalau pool non-degenerate < 50, hasilnya
 * tetap null dengan label INSUFFICIENT_DATA.
 */
export const KNN_NEUTRAL_FEATURES: readonly number[] = [50, 50, 50, 20, 1];

/** True bila vektor fitur identik dengan fallback netral (tanpa info diskriminatif). */
export function isDegenerateKnnFeatures(features: readonly number[]): boolean {
  if (!Array.isArray(features) || features.length !== KNN_FEATURE_DIM) return false;
  return KNN_NEUTRAL_FEATURES.every((v, i) => Number(features[i]) === v);
}

export interface KnnAnalogItem {
  id: string | number;
  symbol: string;
  mode: KnnMode;
  features: number[]; // [zoneScore, triggerScore, trendScore, adx, volRatio]
  win: boolean;
  rMultiple: number;
  timestamp: number;
}

export interface KnnQueryResult {
  queryFeatures: number[];
  k: number;
  knnN: number;
  knnProb: number | null;
  label: "INSUFFICIENT_DATA" | "READY";
  nearestNeighbors: {
    id: string | number;
    symbol: string;
    distance: number;
    win: boolean;
    rMultiple: number;
  }[];
  /** Jumlah item degenerat (vektor netral) yang DIBUANG dari pool query. */
  degenerateSkipped: number;
  /** Alasan singkat kalau label = INSUFFICIENT_DATA (aman ditampilkan). */
  labelReason: string;
}

/**
 * Menghitung jarak Lorentzian antara dua vektor fitur:
 * d_L(u, v) = sum( ln(1 + |u_i - v_i|) )
 */
export function lorentzianDistance(v1: number[], v2: number[]): number {
  const len = Math.min(v1.length, v2.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += Math.log(1 + Math.abs(v1[i]! - v2[i]!));
  }
  return Number(sum.toFixed(6));
}

/**
 * FR-12: Mencari K=5 analog terdekat (Lorentzian) dari riwayat resolusi.
 * Bila n < 50, diberi label data belum cukup (probabilitas null).
 *
 * 24 Okt 2026: item dengan vektor fitur NETRAL (lihat isDegenerateKnnFeatures)
 * dikeluarkan dari pool query. Tanpa ini, K=5 selalu jatuh ke item sentinel
 * yang identik dan knnProb selalu 0 (bukan bukti, hanya artefak). `knnN` kini
 * melaporkan ukuran pool yang DIPAKAI (setelah pembuangan) supaya operator
 * bisa melihat bukti sebenarnya.
 */
export function queryKnnLorentzian(
  queryFeatures: number[],
  history: KnnAnalogItem[],
  k = 5
): KnnQueryResult {
  const usable = history.filter((it) => !isDegenerateKnnFeatures(it.features));
  const degenerateSkipped = history.length - usable.length;
  const n = usable.length;
  if (n < 50) {
    return {
      queryFeatures,
      k,
      knnN: n,
      knnProb: null,
      label: "INSUFFICIENT_DATA",
      nearestNeighbors: [],
      degenerateSkipped,
      labelReason: degenerateSkipped > 0
        ? `KNN_POOL_${n}_LT_50 (${degenerateSkipped} item netral dibuang)`
        : `KNN_POOL_${n}_LT_50`,
    };
  }

  const scored = usable.map((item) => ({
    item,
    distance: lorentzianDistance(queryFeatures, item.features),
  }));

  scored.sort((a, b) => a.distance - b.distance);
  const topK = scored.slice(0, k);
  const winCount = topK.filter((x) => x.item.win).length;
  const knnProb = Number((winCount / k).toFixed(4));

  return {
    queryFeatures,
    k,
    knnN: n,
    knnProb,
    label: "READY",
    nearestNeighbors: topK.map((x) => ({
      id: x.item.id,
      symbol: x.item.symbol,
      distance: x.distance,
      win: x.item.win,
      rMultiple: x.item.rMultiple,
    })),
    degenerateSkipped,
    labelReason: "KNN_POOL_READY",
  };
}

/**
 * Penyimpanan dan indeks riwayat analog resolusi trade (in-memory + database sync).
 */
export class KnnAnalogLibrary {
  private items: KnnAnalogItem[] = [];

  constructor(initialItems: KnnAnalogItem[] = []) {
    this.seedItems(initialItems);
  }

  addItem(item: KnnAnalogItem): void {
    if (!isValidKnnItem(item)) return;
    const existing = this.items.findIndex((x) => x.id === item.id && x.mode === item.mode);
    const copy = { ...item, symbol: item.symbol.toUpperCase(), features: [...item.features] };
    if (existing >= 0) this.items[existing] = copy;
    else this.items.push(copy);
  }

  seedItems(items: KnnAnalogItem[]): void {
    for (const item of items) this.addItem(item);
  }

  clear(): void {
    this.items = [];
  }

  count(mode?: KnnMode): number {
    if (!mode) return this.items.length;
    return this.items.filter((it) => it.mode === mode).length;
  }

  /** Salinan item untuk persistensi (JSON file, selamat dari restart). */
  snapshot(): KnnAnalogItem[] {
    return this.items.map((it) => ({
      id: it.id,
      symbol: it.symbol,
      mode: it.mode,
      features: [...it.features],
      win: it.win,
      rMultiple: it.rMultiple,
      timestamp: it.timestamp,
    }));
  }

  query(
    features: number[],
    mode: KnnMode = "SCALP",
    k = 5
  ): KnnQueryResult {
    const pool = this.items.filter((it) => it.mode === mode);
    return queryKnnLorentzian(features, pool, k);
  }
}

export interface CandidateRawScores {
  zoneScore: number;
  triggerScore: number;
  trendScore: number;
  knnProb?: number | null;
}

/**
 * FR-13: Menghitung skor gabungan 0-100 secara deterministik.
 * Bobot standar:
 * - zoneScore: 30%
 * - triggerScore: 25%
 * - trendScore: 25%
 * - knnProb: 20% (bila null, didistribusikan proporsional ke 3 engine lainnya).
 */
export function calculateCompositeScore(scores: CandidateRawScores): number {
  const { zoneScore, triggerScore, trendScore, knnProb } = scores;

  let finalScore: number;
  if (knnProb !== undefined && knnProb !== null) {
    const knnScore = knnProb * 100;
    finalScore = 0.30 * zoneScore + 0.25 * triggerScore + 0.25 * trendScore + 0.20 * knnScore;
  } else {
    // Redistribusi proporsional tanpa KNN (30/80, 25/80, 25/80)
    finalScore = (30 / 80) * zoneScore + (25 / 80) * triggerScore + (25 / 80) * trendScore;
  }

  const rounded = Math.round(finalScore);
  return Math.max(0, Math.min(100, rounded));
}

export interface ScoredCandidateInput {
  symbol: string;
  // 30 Sep 2026 — refactor SCALP-only: kandidat baru selalu SCALP.
  mode: "SCALP";
  regime: string;
  zoneScore: number;
  triggerScore: number;
  trendScore: number;
  knnProb?: number | null;
  knnN?: number | null;
  gatesPass: Record<string, boolean>;
  meta?: Record<string, unknown>;
}

export interface RankedCandidate extends ScoredCandidateInput {
  score: number;
  rank: number;
}

/**
 * FR-13: Meranking kandidat terurut menurun berdasarkan skor gabungan.
 * Mengembalikan array berurutan dengan atribut rank (1..N).
 */
export function rankCandidates(
  candidates: ScoredCandidateInput[]
): {
  ranked: RankedCandidate[];
  durationMs: number;
  total: number;
} {
  const start = Date.now();

  const scored: RankedCandidate[] = candidates.map((c) => {
    const score = calculateCompositeScore({
      zoneScore: c.zoneScore,
      triggerScore: c.triggerScore,
      trendScore: c.trendScore,
      knnProb: c.knnProb,
    });
    return {
      ...c,
      score,
      rank: 0,
    };
  });

  // Urutkan menurun: skor utama, lalu zoneScore, triggerScore, trendScore
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.zoneScore !== a.zoneScore) return b.zoneScore - a.zoneScore;
    if (b.triggerScore !== a.triggerScore) return b.triggerScore - a.triggerScore;
    return b.trendScore - a.trendScore;
  });

  // Berikan nomor urut rank 1-based
  for (let i = 0; i < scored.length; i++) {
    scored[i]!.rank = i + 1;
  }

  const durationMs = Date.now() - start;

  return {
    ranked: scored,
    durationMs,
    total: scored.length,
  };
}

/** Singleton library produksi: diisi dari trade yang close, dibaca saat scan. */
export const defaultKnnLibrary = new KnnAnalogLibrary();

export interface KnnLibraryFile {
  version: 1;
  savedAt: number;
  items: KnnAnalogItem[];
}

const KNN_FILE_MAX_ITEMS = 500;

/** Serialisasi library untuk file JSON (hanya 500 terbaru). */
export function serializeKnnLibrary(items: readonly KnnAnalogItem[]): string {
  const tail = items.slice(-KNN_FILE_MAX_ITEMS);
  const file: KnnLibraryFile = { version: 1, savedAt: Date.now(), items: tail as KnnAnalogItem[] };
  return JSON.stringify(file);
}

function isValidKnnItem(x: unknown): x is KnnAnalogItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.symbol !== "string" || !o.symbol) return false;
  if (o.mode !== "SCALP" && o.mode !== "SWING") return false;
  if (!Array.isArray(o.features) || o.features.length !== KNN_FEATURE_DIM) return false;
  if (!(o.features as unknown[]).every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  if (typeof o.win !== "boolean") return false;
  if (typeof o.rMultiple !== "number" || !Number.isFinite(o.rMultiple)) return false;
  if (typeof o.timestamp !== "number" || !Number.isFinite(o.timestamp)) return false;
  return true;
}

/** Parse file JSON library (toleran: baris rusak dibuang, maksimal 500). */
export function parseKnnLibraryFile(text: string): KnnAnalogItem[] {
  const parsed: unknown = JSON.parse(text);
  const arr: unknown = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
    ? (parsed as { items: unknown[] }).items
    : parsed;
  if (!Array.isArray(arr)) return [];
  return arr.filter(isValidKnnItem).slice(-KNN_FILE_MAX_ITEMS).map((it) => ({
    id: (it as KnnAnalogItem).id,
    symbol: (it as KnnAnalogItem).symbol.toUpperCase(),
    mode: (it as KnnAnalogItem).mode,
    features: [...(it as KnnAnalogItem).features],
    win: (it as KnnAnalogItem).win,
    rMultiple: (it as KnnAnalogItem).rMultiple,
    timestamp: (it as KnnAnalogItem).timestamp,
  }));
}
