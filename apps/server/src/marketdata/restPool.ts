// apps/server/src/marketdata/restPool.ts - Rest pool Binance USD-M (FR-23, NFR-03).
//  - Pool host: fapi1 -> fapi2 -> fapi3 -> fapi4 -> fapi (urutan dari BINANCE_REST_POOL)
//  - Circuit breaker: >= 5 gagal berturut -> host dibuka (dilewati) 30 detik
//  - Retry: 3x dengan backoff 250ms / 500ms / 2000ms (total 4 percobaan), tiap percobaan pindah host
//  - Time-sync: offset serverTime Binance -> nowWithOffset() untuk request signed (Rules Bagian 4)
//  - 4xx (kecuali 418/429) = fatal, TIDAK di-retry (hemat budget kuota)
//  - 2xx non-JSON (mis. halaman blokir) dihitung GAGAL host -> lanjut host berikut
//  - Semua fetch & sleep bisa disuntik -> unit test jalan OFFLINE (tanpa jaringan live)
import { env } from "../core/env.js";

export type PoolEventType = "HOST_SWITCH" | "CIRCUIT_OPEN" | "CIRCUIT_CLOSE" | "REQUEST_FAILED";

export interface PoolEvent {
  type: PoolEventType;
  from?: string;
  to?: string;
  detail: string;
  atMs: number;
}

export interface RestPoolOptions {
  hosts?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  failThreshold?: number;
  cooldownMs?: number;
  retryDelaysMs?: number[];
  onEvent?: (e: PoolEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestResult<T> {
  data: T;
  host: string;
  attempts: number;
  elapsedMs: number;
}

export interface HostState {
  host: string;
  consecutiveFails: number;
  totalFails: number;
  lastStatus: number | null;
  open: boolean;
  openUntil: number;
}

export class PoolError extends Error {
  attempts: number;
  lastStatus: number | null;
  constructor(message: string, attempts: number, lastStatus: number | null) {
    super(message);
    this.name = "PoolError";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 2000];
const DEFAULT_FAIL_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 4000;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 23 Okt 2026 (F-E): parse header Retry-After.
 * Format resmi: delay-seconds (integer) ATAU HTTP-date.
 * Return ms, atau null bila header tidak ada/tidak valid.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs?: number): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (raw === "") return null;
  // delay-seconds (RFC 9110): non-negative integer
  if (/^\d+$/.test(raw)) {
    const sec = Number(raw);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return sec * 1000;
  }
  // HTTP-date: harus berbentuk tanggal (mengandung huruf), bukan angka aneh.
  // Tanpa guard ini, string seperti "-5" bisa ter-parse Date.parse() jadi
  // epoch dan diam-diam menghasilkan 0 (= "tidak tunggu") — tebakan salah.
  if (!/[A-Za-z]/.test(raw)) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  const now = nowMs ?? Date.now();
  const delta = ts - now;
  return delta > 0 ? delta : 0;
}

interface HostInternal {
  consecutiveFails: number;
  totalFails: number;
  openUntil: number;
  lastStatus: number | null;
}

export class RestPool {
  private readonly hosts: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly failThreshold: number;
  private readonly cooldownMs: number;
  private readonly retryDelaysMs: number[];
  private readonly onEvent?: (e: PoolEvent) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly state = new Map<string, HostInternal>();
  private cursor = 0;

  timeOffsetMs: number | null = null;
  timeOffsetAtMs: number | null = null;

  constructor(opts: RestPoolOptions = {}) {
    this.hosts = opts.hosts ?? env.BINANCE_REST_POOL;
    if (this.hosts.length === 0) throw new Error("RestPool: hosts kosong (BINANCE_REST_POOL)");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.failThreshold = opts.failThreshold ?? DEFAULT_FAIL_THRESHOLD;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.onEvent = opts.onEvent;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    for (const h of this.hosts) {
      this.state.set(h, { consecutiveFails: 0, totalFails: 0, openUntil: 0, lastStatus: null });
    }
  }

  snapshot(): HostState[] {
    const t = this.now();
    return this.hosts.map((h) => {
      const s = this.state.get(h)!;
      return {
        host: h,
        consecutiveFails: s.consecutiveFails,
        totalFails: s.totalFails,
        lastStatus: s.lastStatus,
        open: s.openUntil > t,
        openUntil: s.openUntil,
      };
    });
  }

  nowWithOffset(): number {
    return this.now() + (this.timeOffsetMs ?? 0);
  }

  private buildUrl(host: string, path: string, params?: Record<string, string | number>): string {
    const url = new URL(path, "https://" + host);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private pickNext(exclude?: ReadonlySet<string>): string {
    const t = this.now();
    const n = this.hosts.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const h = this.hosts[idx];
      if (exclude?.has(h)) continue;
      if (this.state.get(h)!.openUntil <= t) {
        this.cursor = (idx + 1) % n;
        return h;
      }
    }
    // Semua host cooldown/dikecualikan -> pakai yang paling cepat pulih.
    return this.hosts.reduce((a, b) => (this.state.get(a)!.openUntil <= this.state.get(b)!.openUntil ? a : b));
  }

  private emit(e: PoolEvent): void {
    if (this.onEvent) this.onEvent(e);
  }

  private markFail(host: string, status: number | null): void {
    const s = this.state.get(host)!;
    const wasOpen = s.openUntil > this.now();
    s.consecutiveFails += 1;
    s.totalFails += 1;
    s.lastStatus = status;
    if (!wasOpen && s.consecutiveFails >= this.failThreshold) {
      s.openUntil = this.now() + this.cooldownMs;
      this.emit({ type: "CIRCUIT_OPEN", from: host, detail: s.consecutiveFails + " gagal berturut; cooldown " + this.cooldownMs + " ms", atMs: this.now() });
    }
  }

  private markSuccess(host: string): void {
    const s = this.state.get(host)!;
    const wasOpen = s.openUntil > this.now();
    s.consecutiveFails = 0;
    s.openUntil = 0;
    if (wasOpen) this.emit({ type: "CIRCUIT_CLOSE", to: host, detail: "host pulih setelah cooldown", atMs: this.now() });
  }

  /**
   * 23 Okt 2026 (F-E): pasang cooldown host sesuai Retry-After. Host TIDAK
   * dianggap gagal permanen — hanya ditahan sampai jendela rate limit selesai.
   */
  private markCooldown(host: string, ms: number): void {
    const s = this.state.get(host)!;
    const until = this.now() + ms;
    if (until > s.openUntil) {
      s.openUntil = until;
      this.emit({ type: "CIRCUIT_OPEN", from: host, detail: "cooldown Retry-After " + ms + " ms", atMs: this.now() });
    }
  }

  private async fetchOnce(url: string, method: string, timeoutMs?: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        signal: ctrl.signal,
        headers: { Accept: "application/json", "User-Agent": "privatetrade/0.1.3" },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(path: string, params?: Record<string, string | number>, timeoutMs?: number): Promise<RequestResult<T>> {
    return this.request<T>("GET", path, params, timeoutMs);
  }

  async request<T>(method: string, path: string, params?: Record<string, string | number>, timeoutMs?: number): Promise<RequestResult<T>> {
    const started = this.now();
    let attempts = 0;
    let lastStatus: number | null = null;
    let lastError: unknown = null;
    let prevHost: string | null = null;
    // Host yang sudah gagal pada request INI dilewati di percobaan berikut —
    // host WAF (202-kosong) tidak boleh membakar seluruh budget retry
    // (biang MTF_UNAVAILABLE massal: 4x percobaan habis di host mati).
    const failedThisRequest = new Set<string>();

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      attempts = attempt + 1;
      const host = this.pickNext(failedThisRequest);
      if (prevHost !== null && prevHost !== host) {
        this.emit({ type: "HOST_SWITCH", from: prevHost, to: host, detail: "failover pada percobaan ke-" + attempts, atMs: this.now() });
      }
      prevHost = host;
      const url = this.buildUrl(host, path, params);

      let res: Response;
      try {
        res = await this.fetchOnce(url, method, timeoutMs);
      } catch (netErr) {
        this.markFail(host, null);
        failedThisRequest.add(host);
        lastError = netErr;
        lastStatus = null;
        if (attempt < this.retryDelaysMs.length) await this.sleep(this.retryDelaysMs[attempt]);
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const text = await res.text();
        if (!text) {
          // WAF fapi1-4 menjawab 202 KOSONG: bukan data valid (endpoint JSON tak
          // pernah kosong) -> gagalkan agar retry pindah host, bukan sukses-null.
          this.markFail(host, res.status);
          failedThisRequest.add(host);
          lastError = new Error("respons kosong dari " + host + " (dicegat?)");
          if (attempt < this.retryDelaysMs.length) await this.sleep(this.retryDelaysMs[attempt]);
          continue;
        }
        let data: T;
        try {
          data = text ? (JSON.parse(text) as T) : (null as T);
        } catch {
          this.markFail(host, res.status);
          failedThisRequest.add(host);
          lastError = new Error("respons 2xx bukan JSON dari " + host + " (dicegat?) pratinjau: " + text.slice(0, 80));
          if (attempt < this.retryDelaysMs.length) await this.sleep(this.retryDelaysMs[attempt]);
          continue;
        }
        this.markSuccess(host);
        return { data, host, attempts, elapsedMs: this.now() - started };
      }

      lastStatus = res.status;
      const body = (await res.text().catch(() => "")).slice(0, 160);
      this.markFail(host, res.status);
      failedThisRequest.add(host);
      lastError = new Error("HTTP " + res.status + " dari " + host + ": " + body);
      const retryable = res.status === 418 || res.status === 429 || res.status >= 500;
      if (!retryable) {
        throw new PoolError(String((lastError as Error).message), attempts, lastStatus);
      }
      // 23 Okt 2026 (F-E): HORMATI Retry-After. 418/429 = rate limit Binance;
      // memutar host pada header yang sama hanya memindahkan tegakan, bukan
      // mengurangi beban (Binance memblokir per IP). Jadi: (1) hormati
      // Retry-After dari header (detik atau tanggal HTTP), (2) JANGAN pindah
      // host saat 418/429 — stay di host yang sama sampai jendela selesai,
      // (3) cooldown host mengikuti Retry-After kalau ada.
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (res.status === 418 || res.status === 429) {
        const waitMs = retryAfterMs ?? (attempt < this.retryDelaysMs.length ? this.retryDelaysMs[attempt]! : 0);
        // TETAP di host yang sama: hapus host ini dari daftar yang dilewati
        // untuk percobaan berikutnya pada request ini.
        failedThisRequest.delete(host);
        if (retryAfterMs !== null) {
          this.markCooldown(host, retryAfterMs);
          this.emit({ type: "REQUEST_FAILED", detail: "HTTP " + res.status + " " + host + " -> tunggu Retry-After " + retryAfterMs + " ms", atMs: this.now() });
        }
        if (attempt < this.retryDelaysMs.length) await this.sleep(waitMs);
        continue;
      }
      if (attempt < this.retryDelaysMs.length) await this.sleep(this.retryDelaysMs[attempt]);
    }

    this.emit({ type: "REQUEST_FAILED", detail: "pool habis percobaan: " + String(lastError), atMs: this.now() });
    throw new PoolError("RestPool habis percobaan (" + attempts + "x): " + String(lastError), attempts, lastStatus);
  }

  async measureTimeOffset(): Promise<number | null> {
    const t0 = this.now();
    try {
      const r = await this.get<{ serverTime?: number }>("/fapi/v1/time");
      const t1 = this.now();
      if (typeof r.data.serverTime !== "number") return null;
      const mid = (t0 + t1) / 2;
      this.timeOffsetMs = r.data.serverTime - mid;
      this.timeOffsetAtMs = t1;
      return this.timeOffsetMs;
    } catch (e) {
      this.emit({ type: "REQUEST_FAILED", detail: "time-sync gagal: " + String(e), atMs: this.now() });
      return null;
    }
  }
}

// Instance siap pakai untuk modul marketdata berikutnya.
export const binanceRest = new RestPool();