// apps/server/tests/prasyaratKritis.test.ts - 23 Okt 2026 (Tahap 2):
// F-A watchdog hanya pakai level LIVE, F-E restPool hormati Retry-After,
// F-C stop() menunggu langkah in-flight.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRetryAfterMs } from "../src/marketdata/restPool.js";

const WATCHDOG = resolve(import.meta.dirname, "../../../watchdog/watchdog_sltp.py");

function watchdogSource(): string {
  return readFileSync(WATCHDOG, "utf8");
}

describe("F-A — watchdog tidak boleh memakai level PAPER untuk posisi exchange", () => {
  it("levels_from_db hanya mengambil baris source LIVE", () => {
    const src = watchdogSource();
    const fn = src.slice(src.indexOf("def levels_from_db()"), src.indexOf("def get_open_positions()"));
    expect(fn).toContain("source LIKE 'LIVE%'");
    // Query tanpa filter source = bug yang diperbaiki.
    expect(fn).not.toMatch(/WHERE status='OPEN'\s*"\s*\)/);
  });

  it("lookup entry di levels_from_algo_orders juga hanya baris LIVE", () => {
    const src = watchdogSource();
    const fn = src.slice(src.indexOf("def levels_from_algo_orders("), src.indexOf("def levels_from_db()"));
    expect(fn).toContain("source LIKE 'LIVE%'");
  });

  it("gagal aman kalau kolom source belum ada di DB lama (tidak pakai level DB sama sekali)", () => {
    const src = watchdogSource();
    const fn = src.slice(src.indexOf("def levels_from_db()"), src.indexOf("def get_open_positions()"));
    expect(fn).toContain("DB_LEVELS_SKIP_NO_SOURCE_COLUMN");
  });
});

describe("F-E — restPool hormati Retry-After", () => {
  it("parse delay-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("parse HTTP-date (dalam ms, minimal 0)", () => {
    const now = Date.parse("2026-10-23T00:00:00Z");
    expect(parseRetryAfterMs("Fri, 23 Oct 2026 00:00:30 GMT", now)).toBe(30_000);
    // Tanggal yang sudah lewat -> 0 (tidak negatif, tidak NaN)
    expect(parseRetryAfterMs("Thu, 22 Oct 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("header tidak ada/tidak valid -> null (bukan tebakan)", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("secepatnya")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
  });

  it("418/429 tidak lagi memutar host (tidak pindah host saat rate limit)", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/marketdata/restPool.ts"), "utf8");
    const seg = src.slice(src.indexOf("const retryable = res.status === 418"));
    expect(seg).toContain("res.status === 418 || res.status === 429");
    expect(seg).toContain("failedThisRequest.delete(host)");
    expect(seg).toContain("parseRetryAfterMs");
  });
});

describe("F-C — stop() menunggu langkah in-flight", () => {
  it("stop() async dan menunggu isStepRunning", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/exec/autonomousTradingBot.ts"), "utf8");
    expect(src).toMatch(/public async stop\(opts\?: \{ timeoutMs\?: number \}\)/);
    expect(src).toContain("while (this.isStepRunning");
  });

  it("semua pemanggil stop() meng-awaited hasilnya", () => {
    const botRoute = readFileSync(resolve(import.meta.dirname, "../src/api/routes/bot.ts"), "utf8");
    const adminRoute = readFileSync(resolve(import.meta.dirname, "../src/api/routes/admin.ts"), "utf8");
    expect(botRoute).toContain("await bot.stop()");
    expect(adminRoute).toContain("await bot.stop()");
    // Setiap kemunculan pemanggilan stop() harus didahului "await".
    for (const src of [botRoute, adminRoute]) {
      const calls = src.match(/(await\s+)?bot\.stop\(\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.startsWith("await")).toBe(true);
    }
  });
});

describe("F-G — .env root tidak punya literal \\n (systemd EnvironmentFile)", () => {
  it("tidak ada baris dengan escape \\n di .env root", () => {
    const raw = readFileSync(resolve(import.meta.dirname, "../../../.env"), "utf8");
    const bad = raw.split("\n").filter((l) => l.includes("\\n#") || /\\n[A-Z_]+=/.test(l));
    expect(bad).toEqual([]);
  });

  it("semua baris non-komentar punya format KEY=VALUE yang valid untuk systemd", () => {
    const raw = readFileSync(resolve(import.meta.dirname, "../../../.env"), "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      expect(s, `baris tidak valid: ${s}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
    }
  });
});

describe("regresi — tidak ada perubahan struktur yang merusak", () => {
  it("watchdog tetap bisa diimpor (syntax python valid)", () => {
    expect(() => execFileSync("python3", ["-m", "py_compile", WATCHDOG], { stdio: "pipe" })).not.toThrow();
  });
});
