// apps/server/src/marketdata/wallLifelines.ts
// MODUL 2 — WALL LIFELINES: siklus hidup dinding likuiditas di L2.
//
// Deteksi wall (order besar) dari snapshot book live Binance Futures +
// Hyperliquid l2Book. Event yang dilacak:
//
//   appeared  -> level baru muncul di book dengan notional >= ambang
//   moved     -> level yang sama berpindah harga (hantu/iceberg mengikuti)
//   pulled    -> level hilang TANPA ada trade yang memotongnya (spoof)
//   eaten     -> level hilang DAN ada taker trade yang memotongnya
//
// Toleransi dipisah menjadi dua (penting, kalau tidak event "moved" meledek):
//
//   IDENT_TOL_PCT = 0,005%  -> jitter normal book (tick 0,1 dtk) = LEVEL YANG
//                              SAMA. Tidak menghasilkan event apa pun.
//   MOVE_TOL_PCT  = 0,05%   -> perpindahan harga yang MATERIL = "moved".
//
// Klasifikasi pulled-vs-eaten memakai JEJAK WAKTU, bukan "trade terakhir":
// setiap wall menyimpan `crossedAt` (waktu trade pertama yang memotong
// levelnya) dan `goneAt` (waktu level hilang dari book).
//
//   - Trade memotong saat wall masih di book  -> wall itu memang dimakan.
//   - Trade memotong > EATEN_AFTER_GONE_MS   -> itu rally terpisah, bukan
//     bukti wall lama dimakan; wall tetap dihitung PULLED.
//
// Retensi 30 menit. Profil kedalaman memakai skala akar ($^0.5) supaya
// dinding kecil tetap terlihat tanpa écras/menyembunyikan yang besar.
//
// Semua angka berasal dari book + trade live. Tidak ada data karangan.

import { logger } from "../core/logger.js";
import type { BookSnapshot, BookLevel, VenueId, WallEvent, WallRecord } from "./microstructureTypes.js";

/** Notional minimum (USD) agar sebuah level dianggap "wall". */
const WALL_MIN_USD = 100_000;
/** Rentang harga yang dipantau (persen dari mid) untuk wall lifecycle. */
const TRACK_RANGE_PCT = 3.0;
/** Retensi event (ms). */
const RETENTION_MS = 30 * 60_000;
/** Toleransi identitas level (persen): jitter di bawah ini = level yang sama. */
const IDENT_TOL_PCT = 0.005;
/** Toleransi perpindahan (persen): jarak harga >= ini = wall "moved". */
const MOVE_TOL_PCT = 0.05;
/** Grace period (ms) sebelum level yang hilang dianggap GONE. */
const GONE_GRACE_MS = 1_200;
/** Jeda (ms) sebelum wall GONE tanpa trade pemotong ditandai PULLED. */
const PULLED_AFTER_MS = 2_000;
/** Jeda (ms) setelah wall GONE di mana trade pemotong masih dianggap "makan". */
const EATEN_AFTER_GONE_MS = 2_500;
/** Jeda (ms) yang masih dianggap "baru saja" saat wall hilang dari book. */
const CROSS_WINDOW_MS = 1_000;
/** Toleransi harga (basis point) saat menilai trade "memotong" sebuah wall. */
const CROSS_EPS = 0.0001;
/** Rentang harga (%) yang discan saat trade datang (batas kerja per trade). */
const TRADE_SCAN_PCT = 0.01;
/** Maksimum event per simbol (histori tidak saling mengikis). */
const MAX_EVENTS_PER_SYMBOL = 500;
/** Cooldown (ms) event "moved" per wall (anti ping-pong book). */
const MOVE_EVENT_COOLDOWN_MS = 1_500;

export interface WallDepthLevel {
  price: number;
  side: "BID" | "ASK";
  notionalUsd: number;
  /** Notional dengan skala akar (untuk lebar bar). */
  scaled: number;
  /** Level ini pernah jadi wall (dalam retensi). */
  isWall: boolean;
  state: WallRecord["state"] | "GONE" | null;
}

export interface WallLifelinesSnapshot {
  symbol: string;
  venue: VenueId;
  updatedAt: number;
  mid: number | null;
  /** Profil kedalaman (sqrt $) per level, dibatasi ± TRACK_RANGE_PCT. */
  depth: WallDepthLevel[];
  events: WallEvent[];
  summary: {
    appeared: number;
    moved: number;
    pulled: number;
    eaten: number;
    active: number;
    totalPulledUsd: number;
    totalEatenUsd: number;
    /** Notional wall aktif terbesar saat ini. */
    largestActiveUsd: number;
    largestActivePrice: number | null;
    largestActiveSide: "BID" | "ASK" | null;
    /** Umur data dalam ms (honest — retensi 30 menit). */
    windowMs: number;
  };
  /** Tren notional wall per bucket 5 menit (6 bucket). */
  trend: { t: number; appeared: number; pulled: number; eaten: number }[];
}

interface LiveWall {
  id: number;
  venue: VenueId;
  symbol: string;
  side: "BID" | "ASK";
  price: number;
  notionalUsd: number;
  appearedAt: number;
  lastSeenAt: number;
  /** "GONE" = level hilang dari book, pulled/eaten diputuskan. */
  state: WallRecord["state"] | "GONE";
  movedTo?: number;
  /** Terakhir event "moved" dipush (untuk cooldown). */
  lastMoveEventAt: number;
  /** Waktu trade pertama yang memotong level ini (null = belum pernah). */
  crossedAt: number | null;
  /** Waktu level hilang dari book. */
  goneAt: number | null;
  /** Waktu level terakhir kali tidak terlihat di book padahal SEHARUSNYA
   *  terlihat (dalam rentang kedalaman book). Deteksi "cancel lalu posting
   *  ulang" — tanda spoof klasik. */
  vanishedAt: number | null;
}

const venueKey = (v: VenueId, s: string) => `${v}|${s}`;

/**
 * Apakah harga trade `px` memotong level wall di harga `wallPx`?
 * BID: wall dimakan bila ada trade di harga <= wall (taker jual memukul bid).
 * ASK: wall dimakan bila ada trade di harga >= wall (taker beli mengangkat ask).
 */
function crosses(px: number, side: "BID" | "ASK", wallPx: number): boolean {
  if (side === "BID") return px <= wallPx * (1 + CROSS_EPS);
  return px >= wallPx * (1 - CROSS_EPS);
}

/** Indeks pertama pada array terurut harga dengan price >= p. */
function lowerBound(list: LiveWall[], p: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.price < p) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export class WallLifelinesTracker {
  /** Wall hidup per simbol, terurut harga (venue disimpan di tiap wall). */
  private walls = new Map<string, LiveWall[]>();
  /** Event per simbol — batas per simbol supaya riwayat satu simbol tidak
   *  mengikis riwayat simbol lain. */
  private events = new Map<string, WallEvent[]>();
  private lastBooks = new Map<string, BookSnapshot>();
  /** TAHAP 6B: waktu book DITERIMA proses per venue+símbol (terpisah dari
   *  waktu event bursa di `book.t`). */
  private lastBookReceivedAt = new Map<string, number>();
  private eventSeq = 0;
  private startedAt = Date.now();

  /** Dipanggil tiap book update: deteksi wall muncul / pindah / hilang. */
  onBook(book: BookSnapshot): void {
    const k = venueKey(book.venue, book.symbol);
    this.lastBooks.set(k, book);
    this.lastBookReceivedAt.set(k, Date.now());
    if (!book.mid) return;

    const live = this.walls.get(book.symbol) ?? [];
    /** Wall yang sudah dipasangkan dengan sebuah level pada update ini. */
    const matched = new Set<number>();
    /** Wall baru yang akan ditambahkan setelah iterasi selesai. */
    const created: LiveWall[] = [];

    const check = (levels: BookLevel[], side: "BID" | "ASK"): void => {
      for (const l of levels) {
        const distPct = ((l.price - book.mid!) / book.mid!) * 100;
        if (Math.abs(distPct) > TRACK_RANGE_PCT) continue;
        if (l.notionalUsd < WALL_MIN_USD) continue;

        // 1) Level yang SAMA -> wall yang sama (jitter normal book).
        // 25 Okt 2026 (FASE 5): identitas wall = venue+symbol+side+level.
        // Tanpa filter venue, wall Hyperliquid bisa dipasangkan oleh update
        // book Binance -> GONE/MOVED/PULLED palsu antar-venue.
        const same = live.find((w) =>
          w.venue === book.venue &&
          w.state !== "PULLED" && w.state !== "EATEN" &&
          w.side === side && !matched.has(w.id) &&
          Math.abs(w.price - l.price) / l.price * 100 < IDENT_TOL_PCT,
        );
        if (same) {
          matched.add(same.id);
          // Wall sempat HILANG dari book (dibatalkan) lalu posting ulang di
          // harga yang sama = "cancel & repost" -> tanda spoof klasik.
          if (same.vanishedAt != null) {
            this.pushEvent({
              kind: "pulled", side, price: l.price, notionalUsd: l.notionalUsd,
              distPct, lifeSec: (book.t - same.appearedAt) / 1000,
            }, book);
            same.vanishedAt = null;
          }
          same.lastSeenAt = book.t;
          same.notionalUsd = l.notionalUsd;
          // Wall yang sempat GONE tapi muncul lagi = masih HIDUP, bukan hilang.
          if (same.state === "GONE") { same.state = "ACTIVE"; same.goneAt = null; }
          continue;
        }

        // 2) Perpindahan harga MATERIL -> wall yang sama dipindah (moved).
        let cand: LiveWall | null = null;
        let candDist = Infinity;
        for (const w of live) {
          if (w.venue !== book.venue) continue; // 25 Okt 2026 (FASE 5): antar-venue jangan dicampur
          if (w.state === "PULLED" || w.state === "EATEN") continue;
          if (w.side !== side || matched.has(w.id)) continue;
          const d = Math.abs(w.price - l.price) / l.price * 100;
          if (d >= MOVE_TOL_PCT || d >= candDist) continue;
          cand = w; candDist = d;
        }
        if (cand) {
          matched.add(cand.id);
          cand.price = l.price;
          cand.notionalUsd = l.notionalUsd;
          cand.lastSeenAt = book.t;
          cand.movedTo = l.price;
          cand.state = "MOVED";
          cand.goneAt = null;
          // Cooldown: wall yang ping-pong tiap tick tetap terekam satu kali
          // per cooldown supaya log event tidak meledak.
          if (book.t - cand.lastMoveEventAt >= MOVE_EVENT_COOLDOWN_MS) {
            cand.lastMoveEventAt = book.t;
            this.pushEvent({
              kind: "moved", side, price: l.price, notionalUsd: l.notionalUsd,
              distPct, lifeSec: (book.t - cand.appearedAt) / 1000,
            }, book);
          }
          continue;
        }

        // 3) Level baru -> wall baru.
        const w: LiveWall = {
          id: ++this.eventSeq,
          venue: book.venue, symbol: book.symbol, side,
          price: l.price, notionalUsd: l.notionalUsd,
          appearedAt: book.t, lastSeenAt: book.t, state: "ACTIVE",
          lastMoveEventAt: 0, crossedAt: null, goneAt: null, vanishedAt: null,
        };
        created.push(w);
        matched.add(w.id);
        this.pushEvent({
          kind: "appeared", side, price: l.price, notionalUsd: l.notionalUsd,
          distPct, lifeSec: 0,
        }, book);
      }
    };

    check(book.bids, "BID");
    check(book.asks, "ASK");

    if (created.length) {
      live.push(...created);
      live.sort((a, b) => a.price - b.price);
    }

    // Wall yang tidak terlihat lagi di level yang sama -> bisa pulled atau eaten.
    // Grace period 1,2 dtk: level yang hilang sesaat (qty 0 sesaat atau
    // sinkronisasi book) TIDAK boleh langsung dianggap hilang — kalau tidak,
    // setiap wall akan ter-pulled lalu muncul lagi (churn palsu).
    for (const w of live) {
      if (matched.has(w.id)) continue;
      if (w.venue !== book.venue) continue; // 25 Okt 2026 (FASE 5): wall venue lain bukan "hilang"
      if (w.state === "GONE" || w.state === "PULLED" || w.state === "EATEN") continue;
      // Level ini SEHARUSNYA masih terlihat di book (dalam rentang kedalaman
      // yang di-push) tapi tidak ada -> benar-benar hilang / dibatalkan.
      const shouldBeVisible = w.side === "BID"
        ? book.bestBid != null && w.price > book.bestBid
        : book.bestAsk != null && w.price < book.bestAsk;
      if (book.t - w.lastSeenAt < GONE_GRACE_MS) {
        if (shouldBeVisible && w.vanishedAt == null) w.vanishedAt = book.t;
        continue;
      }
      // Ada trade yang memotong level ini BARU-BARU SEBELUM hilang?
      // Kalau ya -> wall dimakan (EATEN). Kalau tidak -> GONE, nanti
      // dievaluasi jadi PULLED bila tak ada trade pemotong.
      const fresh = w.crossedAt != null && w.crossedAt >= w.lastSeenAt - CROSS_WINDOW_MS;
      if (fresh) {
        w.state = "EATEN";
        w.lastSeenAt = book.t;
        w.goneAt = book.t;
        this.pushEvent({
          kind: "eaten", side: w.side, price: w.price, notionalUsd: w.notionalUsd,
          distPct: ((w.price - book.mid!) / book.mid!) * 100,
          lifeSec: (book.t - w.appearedAt) / 1000,
        }, book);
        continue;
      }
      w.state = "GONE";
      w.lastSeenAt = book.t;
      w.goneAt = book.t;
    }

    this.walls.set(book.symbol, live);
    this.prune();
  }

  /**
   * Dipanggil saat ada trade taker di simbol tsb. Trade yang memotong level
   * wall dicatat pada wall itu (`crossedAt`). Bila wall sudah GONE dan trade
   * datang masih dalam jendela waktu yang masuk akal, wall = EATEN.
   *
   * Pemotongan hanya berlaku untuk trade pada VENUE YANG SAMA dengan wall:
   * ask Binance yang hilang tidak "dimakan" oleh fill OKX di harga sama.
   */
  onTrade(symbol: string, price: number, usd: number, t: number, venue?: VenueId): void {
    const live = this.walls.get(symbol);
    if (!live || live.length === 0) return;
    const lo = price * (1 - TRADE_SCAN_PCT);
    const hi = price * (1 + TRADE_SCAN_PCT);
    for (let i = lowerBound(live, lo); i < live.length && live[i]!.price <= hi; i++) {
      const w = live[i]!;
      if (w.state === "PULLED" || w.state === "EATEN") continue;
      if (venue && w.venue !== venue) continue;
      if (!crosses(price, w.side, w.price)) continue;
      if (w.crossedAt == null) w.crossedAt = t;
      if (w.state !== "GONE") continue;
      // Sudah GONE: trade yang memotong HARUS datang segera setelah level
      // hilang. Trade yang jauh afterwards = rally terpisah, bukan bukti.
      if (w.goneAt == null || t - w.goneAt > EATEN_AFTER_GONE_MS) continue;
      w.state = "EATEN";
      w.lastSeenAt = t;
      const book = this.lastBooks.get(venueKey(w.venue, symbol));
      const mid = book?.mid ?? price;
      this.pushEvent({
        kind: "eaten", side: w.side, price: w.price, notionalUsd: w.notionalUsd,
        distPct: ((w.price - mid) / mid) * 100,
        lifeSec: (t - w.appearedAt) / 1000,
      }, { venue: w.venue, symbol, mid, t } as BookSnapshot);
    }
  }

  /** Wall yang hilang tanpa trade memotong -> PULLED (spoof). Dipanggil berkala. */
  markPulled(now = Date.now()): void {
    for (const [symbol, live] of this.walls) {
      for (const w of live) {
        if (w.state !== "GONE") continue;
        // Beri jeda agar antrean book sempat sinkron sebelum di/pull.
        if (now - (w.goneAt ?? w.lastSeenAt) < PULLED_AFTER_MS) continue;
        w.state = "PULLED";
        const book = this.lastBooks.get(venueKey(w.venue, symbol));
        const mid = book?.mid ?? null;
        this.pushEvent({
          kind: "pulled", side: w.side, price: w.price, notionalUsd: w.notionalUsd,
          distPct: mid ? ((w.price - mid) / mid) * 100 : 0,
          lifeSec: (now - w.appearedAt) / 1000,
        }, { venue: w.venue, symbol, mid, t: now } as BookSnapshot);
      }
    }
    this.prune();
  }

  private pushEvent(e: Omit<WallEvent, "id" | "t" | "venue" | "symbol">, book: BookSnapshot): void {
    const list = this.events.get(book.symbol) ?? [];
    list.push({
      id: ++this.eventSeq,
      t: book.t || Date.now(),
      venue: book.venue,
      symbol: book.symbol,
      ...e,
    });
    // Batas per simbol: riwayat simbol yang ramai tidak boleh menghapus
    // riwayat simbol lain.
    if (list.length > MAX_EVENTS_PER_SYMBOL) {
      list.splice(0, list.length - MAX_EVENTS_PER_SYMBOL);
    }
    this.events.set(book.symbol, list);
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [symbol, list] of this.events) {
      let i = 0;
      while (i < list.length && list[i]!.t < cutoff) i++;
      if (i > 0) list.splice(0, i);
      if (list.length === 0) this.events.delete(symbol);
    }
    for (const [symbol, live] of this.walls) {
      const keep = live.filter((w) => w.lastSeenAt >= cutoff || w.state === "ACTIVE");
      if (keep.length !== live.length) this.walls.set(symbol, keep);
    }
  }

  /**
   * TAHAP 6B: waktu evidence sumber untuk panel walls — epoch ms book terakhir
   * yang diterima untuk simbol ini (bukan waktu snapshot dibuat). null = belum
   * ada book untuk simbol ini (UNKNOWN, bukan "sekarang").
   */
  lastBookAtMs(symbol: string, venue: VenueId = "BINANCE_PERP"): number | null {
    const book = this.lastBooks.get(venueKey(venue, symbol));
    return book && book.t > 0 ? book.t : null;
  }

  /**
   * TAHAP 6B: waktu data book DITERIMA proses (epoch ms) — terpisah dari
   * `lastBookAtMs` (waktu event di bursa). null = UNKNOWN.
   */
  lastBookReceivedAtMs(symbol: string, venue: VenueId = "BINANCE_PERP"): number | null {
    const book = this.lastBooks.get(venueKey(venue, symbol));
    if (!book || book.t <= 0) return null;
    const rec = this.lastBookReceivedAt.get(venueKey(venue, symbol));
    return rec ?? null;
  }

  /**
   * TAHAP 6B: waktu evidence sumber paling tua di antara wall yang masih hidup
   * (appearedAt) — dipakai untuk menandai evidence basi (mis. wall muncul 40
   * menit lalu). null = tidak ada wall hidup.
   */
  oldestLiveWallAtMs(symbol: string, venue: VenueId = "BINANCE_PERP"): number | null {
    const live = (this.walls.get(symbol) ?? []).filter(
      (w) => w.venue === venue && (w.state === "ACTIVE" || w.state === "MOVED"),
    );
    if (live.length === 0) return null;
    let oldest: number | null = null;
    for (const w of live) {
      if (oldest == null || w.appearedAt < oldest) oldest = w.appearedAt;
    }
    return oldest;
  }

  /** Snapshot untuk Panel 2. */
  snapshot(symbol: string, venue: VenueId = "BINANCE_PERP"): WallLifelinesSnapshot {
    this.prune();
    const book = this.lastBooks.get(venueKey(venue, symbol)) ?? null;
    const mid = book?.mid ?? null;
    const live = (this.walls.get(symbol) ?? []).filter(
      (w) => w.venue === venue && (w.state === "ACTIVE" || w.state === "MOVED"),
    );

    // Profil kedalaman sqrt($).
    const depth: WallDepthLevel[] = [];
    if (book && mid) {
      const push = (levels: BookLevel[], side: "BID" | "ASK") => {
        for (const l of levels) {
          const distPct = ((l.price - mid) / mid) * 100;
          if (Math.abs(distPct) > TRACK_RANGE_PCT) continue;
          const wall = live.find((w) => w.side === side && Math.abs(w.price - l.price) / l.price < 0.002);
          depth.push({
            price: l.price,
            side,
            notionalUsd: l.notionalUsd,
            scaled: Math.sqrt(Math.max(0, l.notionalUsd)),
            isWall: !!wall,
            state: wall?.state ?? null,
          });
        }
      };
      push(book.bids, "BID");
      push(book.asks, "ASK");
    }
    depth.sort((a, b) => a.price - b.price);

    const events = (this.events.get(symbol) ?? []).filter((e) => e.venue === venue);
    const counts = { appeared: 0, moved: 0, pulled: 0, eaten: 0 };
    let totalPulledUsd = 0, totalEatenUsd = 0;
    for (const e of events) {
      counts[e.kind] += 1;
      if (e.kind === "pulled") totalPulledUsd += e.notionalUsd;
      if (e.kind === "eaten") totalEatenUsd += e.notionalUsd;
    }
    const largest = live.reduce<LiveWall | null>(
      (acc, w) => (!acc || w.notionalUsd > acc.notionalUsd ? w : acc), null,
    );

    // Tren per bucket 5 menit (6 bucket terakhir = 30 menit).
    const bucketMs = 5 * 60_000;
    const now = Date.now();
    const trend: WallLifelinesSnapshot["trend"] = [];
    for (let i = 5; i >= 0; i--) {
      const end = now - i * bucketMs;
      const start = end - bucketMs;
      const inBucket = events.filter((e) => e.t >= start && e.t < end);
      trend.push({
        t: end,
        appeared: inBucket.filter((e) => e.kind === "appeared").length,
        pulled: inBucket.filter((e) => e.kind === "pulled").length,
        eaten: inBucket.filter((e) => e.kind === "eaten").length,
      });
    }

    return {
      symbol,
      venue,
      updatedAt: Date.now(),
      mid,
      depth,
      events: events.slice(-300).reverse(),
      summary: {
        appeared: counts.appeared,
        moved: counts.moved,
        pulled: counts.pulled,
        eaten: counts.eaten,
        active: live.length,
        totalPulledUsd,
        totalEatenUsd,
        largestActiveUsd: largest?.notionalUsd ?? 0,
        largestActivePrice: largest?.price ?? null,
        largestActiveSide: largest?.side ?? null,
        windowMs: Math.min(RETENTION_MS, now - this.startedAt),
      },
      trend,
    };
  }
}

export const wallLifelines = new WallLifelinesTracker();
export { WALL_MIN_USD, RETENTION_MS };
