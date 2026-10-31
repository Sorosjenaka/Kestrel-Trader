// apps/server/tests/dailyGuard.test.ts - Batas 2 posisi + guard harian -$2 + auto-disarm -$8 (FR-20, FR-21, US-07).
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { DailyRiskGuard, GuardRepo, getUtcMidnight, prismaGuardRepo } from "../src/risk/dailyGuard.js";

class MemoryGuardRepo implements GuardRepo {
  public openPositions: Array<{ symbol: string; status: string }> = [];
  public trades: Array<{ pnlUsd: number; createdAt: Date; source?: string }> = [];
  public armed: boolean | null = false;
  public loggedEvents: Array<{ type: string; severity: string; payload: Record<string, unknown> }> = [];

  async getOpenPositions() {
    return this.openPositions;
  }
  async getTodayTrades(since: Date) {
    return this.trades.filter((t) => t.createdAt >= since).map((t) => ({ pnlUsd: t.pnlUsd, source: t.source }));
  }
  async getAllTrades() {
    return this.trades;
  }
  async getArmSetting() {
    return this.armed;
  }
  async setArmSetting(armed: boolean) {
    this.armed = armed;
  }
  async logEvent(type: string, severity: string, payload: Record<string, unknown>) {
    this.loggedEvents.push({ type, severity, payload });
  }
}

describe("FR-20 & FR-21: Daily Risk Guard", () => {
  it("memulihkan DISARM tersimpan sebelum entry; start bot tidak boleh mengubahnya", async () => {
    const repo = new MemoryGuardRepo();
    repo.armed = false;
    const guard = new DailyRiskGuard({ repo, initialArmed: true });
    await guard.restoreArmedState();
    expect(guard.isArmed()).toBe(false);
    expect(repo.loggedEvents).toHaveLength(0);
  });

  it("ARM tetap OFF pada database baru yang belum punya keputusan operator", async () => {
    const repo = new MemoryGuardRepo();
    repo.armed = null;
    const guard = new DailyRiskGuard({ repo, initialArmed: true });
    await guard.restoreArmedState();
    expect(guard.isArmed()).toBe(false);
  });

  it("FR-20 (AC-07): menolak order baru jika sudah ada 2 posisi terbuka", async () => {
    const repo = new MemoryGuardRepo();
    repo.openPositions = [
      { symbol: "BTCUSDT", status: "OPEN" },
      { symbol: "ETHUSDT", status: "OPEN" },
    ];

    const guard = new DailyRiskGuard({ repo, maxPositions: 2 });
    const check = await guard.canOpenPosition("SOLUSDT");

    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("MAX_POSITIONS_REACHED");
  });

  it("FR-20: menolak order baru jika simbol yang sama sudah memiliki posisi terbuka", async () => {
    const repo = new MemoryGuardRepo();
    repo.openPositions = [{ symbol: "BTCUSDT", status: "OPEN" }];

    const guard = new DailyRiskGuard({ repo, maxPositions: 2 });
    const check = await guard.canOpenPosition("BTCUSDT");

    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("SYMBOL_ALREADY_OPEN");
  });

  it("FR-20: mengizinkan order baru jika < 2 posisi terbuka dan simbol belum ada", async () => {
    const repo = new MemoryGuardRepo();
    repo.openPositions = [{ symbol: "BTCUSDT", status: "OPEN" }];

    const guard = new DailyRiskGuard({ repo, maxPositions: 2 });
    const check = await guard.canOpenPosition("ETHUSDT");

    expect(check.allowed).toBe(true);
  });

  it("FR-21: auto-disarm dan blokir order ketika loss harian mencapai -$2.00", async () => {
    const repo = new MemoryGuardRepo();
    const now = new Date();
    // 2 trade loss masing-masing -$1.00 hari ini
    repo.trades = [
      { pnlUsd: -1.02, createdAt: now },
      { pnlUsd: -1.05, createdAt: now },
    ];

    const guard = new DailyRiskGuard({
      repo,
      initialArmed: true,
      dailyStopUsd: -2.0,
      now: () => now,
    });

    expect(guard.isArmed()).toBe(true);

    const status = await guard.evaluateStatus("SOLUSDT");

    expect(status.isDailyLossHit).toBe(true);
    expect(status.dailyPnlUsd).toBeLessThanOrEqual(-2.0);
    expect(status.canTrade).toBe(false);
    // Auto-disarm terpicu
    expect(guard.isArmed()).toBe(false);

    // EventLog tercatat
    const event = repo.loggedEvents.find((e) => e.type === "DAILY_LOSS_GUARD_TRIGGERED");
    expect(event).toBeDefined();
    expect(event?.severity).toBe("error");
  });

  it("FR-21: auto-disarm dan blokir order ketika drawdown kumulatif mencapai -$8.00", async () => {
    const repo = new MemoryGuardRepo();
    const now = new Date();
    repo.trades = [
      { pnlUsd: -3.0, createdAt: new Date(now.getTime() - 86400000 * 2) },
      { pnlUsd: -3.0, createdAt: new Date(now.getTime() - 86400000) },
      { pnlUsd: -2.5, createdAt: now },
    ];

    const guard = new DailyRiskGuard({
      repo,
      initialArmed: true,
      autoDisarmDdUsd: -8.0,
      now: () => now,
    });

    const status = await guard.evaluateStatus("SOLUSDT");

    expect(status.isDrawdownHit).toBe(true);
    expect(status.cumulativePnlUsd).toBeLessThanOrEqual(-8.0);
    expect(status.canTrade).toBe(false);
    expect(guard.isArmed()).toBe(false);

    const event = repo.loggedEvents.find((e) => e.type === "MAX_DRAWDOWN_GUARD_TRIGGERED");
    expect(event).toBeDefined();
  });

  it("API /api/guard/status dan /api/guard/arm berfungsi", async () => {
    const app = createApp();
    const res = await request(app).get("/api/guard/status").set("x-api-token", "vitest-mutation-token").expect(200);
    expect(res.body.status).toBeDefined();
    expect(typeof res.body.status.canTrade).toBe("boolean");

    const armRes = await request(app).post("/api/guard/arm").set("x-api-token", "vitest-mutation-token")
      .send({ armed: true, reason: "TEST_ENABLE" })
      .expect(200);
    expect(armRes.body.ok).toBe(true);
    expect(armRes.body.armed).toBe(true);

    const disarmRes = await request(app).post("/api/guard/arm").set("x-api-token", "vitest-mutation-token")
      .send({ armed: false, reason: "TEST_DISABLE" })
      .expect(200);
    expect(disarmRes.body.ok).toBe(true);
    expect(disarmRes.body.armed).toBe(false);
  });
});

// ── Tripwire loss LIVE (operator 11 Okt: "loss 1x = berhenti"; 12 Okt: "loss 2x
// stop berhenti" -> default 2). Mekanisme diuji dengan threshold eksplisit. ──
describe("LIVE_LOSS_TRIPWIRE: N x loss = auto-disarm + laporan", () => {
  it("1x loss LIVE memicu disarm + laporan; profit tidak memicu (threshold eksplisit 1)", async () => {
    const repo = new MemoryGuardRepo();
    const reported: Array<{ losses: unknown[]; dailyPnlUsd: number }> = [];
    const guard = new DailyRiskGuard({
      repo, maxPositions: 1, initialArmed: true, lossTripwireLive: true, lossTripwireCount: 1,
      onLossTripwire: (info) => { reported.push({ losses: info.losses, dailyPnlUsd: info.dailyPnlUsd }); },
    });
    await guard.setArmed(true, "TEST");
    repo.trades.push({ pnlUsd: 0.8, createdAt: new Date(), source: "LIVE_AI" });
    const before = await guard.evaluateStatus();
    expect(before.isLossTripwireHit).toBe(false);
    expect(before.canTrade).toBe(true);

    repo.trades.push({ pnlUsd: -1.1, createdAt: new Date(), source: "LIVE_AI" });
    const after = await guard.evaluateStatus();
    expect(after.isLossTripwireHit).toBe(true);
    expect(after.canTrade).toBe(false);
    expect(guard.isArmed()).toBe(false);
    expect(after.reasons.some((r) => r.startsWith("LIVE_LOSS_TRIPWIRE"))).toBe(true);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.losses).toHaveLength(1);
    expect(repo.loggedEvents.some((e) => e.type === "LIVE_LOSS_TRIPWIRE_TRIGGERED")).toBe(true);
  });

  it("loss PAPER tidak memicu tripwire (PAPER tetap tanpa guard, keputusan 29 Sep)", async () => {
    const repo = new MemoryGuardRepo();
    const guard = new DailyRiskGuard({ repo, maxPositions: 20, initialArmed: true, lossTripwireLive: true });
    await guard.setArmed(true, "TEST");
    await guard.evaluateStatus();
    repo.trades.push({ pnlUsd: -1.0, createdAt: new Date(), source: "PAPER_AI" });
    const st = await guard.evaluateStatus();
    expect(st.isLossTripwireHit).toBe(false);
    expect(st.canTrade).toBe(true);
    expect(guard.isArmed()).toBe(true);
  });

  it("27 Okt: re-arm TIDAK mengulang counter — loss dihitung per hari sejak 07:00 WIB", async () => {
    const repo = new MemoryGuardRepo();
    const guard = new DailyRiskGuard({ repo, maxPositions: 20, initialArmed: true, lossTripwireLive: true, lossTripwireCount: 1 });
    await guard.setArmed(true, "TEST");
    await guard.evaluateStatus();
    repo.trades.push({ pnlUsd: -1.0, createdAt: new Date(), source: "LIVE_AI" });
    const tripped = await guard.evaluateStatus();
    expect(tripped.isLossTripwireHit).toBe(true);

    // Perintah operator 27 Okt ("6X SL perhari dihitung dari jam 7 pagi"):
    // re-arm tidak menghapus hitungan hari ini — loss pertama tetap dihitung.
    await guard.setArmed(true, "REVIEWED");
    const stillTripped = await guard.evaluateStatus();
    expect(stillTripped.isLossTripwireHit).toBe(true);
    expect(stillTripped.reasons.some((r) => r.startsWith("LIVE_LOSS_TRIPWIRE"))).toBe(true);
  });

  it("tripwire mati (default/PAPER): loss LIVE tidak mengubah ARM", async () => {
    const repo = new MemoryGuardRepo();
    const guard = new DailyRiskGuard({ repo, maxPositions: 20, initialArmed: true });
    await guard.setArmed(true, "TEST");
    await guard.evaluateStatus();
    repo.trades.push({ pnlUsd: -1.0, createdAt: new Date(), source: "LIVE_AI" });
    const st = await guard.evaluateStatus();
    expect(st.isLossTripwireHit).toBe(false);
    expect(guard.isArmed()).toBe(true);
  });

  it("REGRESI 12 Okt: default 2x loss baru stop (1x loss TIDAK mematikan trading)", async () => {
    const repo = new MemoryGuardRepo();
    // Threshold di-pin eksplisit 2 (bukan ikut env produksi) supaya test ini
    // selalu menguji LOGIKA counting "2x loss baru stop" apa pun nilai
    // LIVE_LOSS_TRIPWIRE_COUNT yang berlaku saat test dijalankan.
    const guard = new DailyRiskGuard({ repo, maxPositions: 20, initialArmed: true, lossTripwireLive: true, lossTripwireCount: 2 });
    // (regresi logika counting; nilai default/env dikontrol operator via .env)
    await guard.setArmed(true, "TEST");
    await guard.evaluateStatus();
    repo.trades.push({ pnlUsd: -1.0, createdAt: new Date(), source: "LIVE_AI" });
    const after1 = await guard.evaluateStatus();
    expect(after1.isLossTripwireHit).toBe(false); // 1x loss masih lanjut
    expect(after1.canTrade).toBe(true);
    expect(guard.isArmed()).toBe(true);

    repo.trades.push({ pnlUsd: -0.8, createdAt: new Date(), source: "LIVE_AI" });
    const after2 = await guard.evaluateStatus();
    expect(after2.isLossTripwireHit).toBe(true); // 2x loss = STOP
    expect(after2.canTrade).toBe(false);
    expect(guard.isArmed()).toBe(false);
    expect(after2.reasons.some((r) => r.startsWith("LIVE_LOSS_TRIPWIRE"))).toBe(true);
  });

  it("REGRESI 12 Okt: profit tidak menghitung ke counter loss", async () => {
    const repo = new MemoryGuardRepo();
    const guard = new DailyRiskGuard({ repo, maxPositions: 20, initialArmed: true, lossTripwireLive: true });
    await guard.setArmed(true, "TEST");
    await guard.evaluateStatus();
    repo.trades.push({ pnlUsd: -1.0, createdAt: new Date(), source: "LIVE_AI" });
    repo.trades.push({ pnlUsd: 1.7, createdAt: new Date(), source: "LIVE_AI" });
    const st = await guard.evaluateStatus();
    expect(st.isLossTripwireHit).toBe(false); // 1 loss + 1 win = belum 2x loss
    expect(guard.isArmed()).toBe(true);
  });
});


// 27 Okt 2026 (perintah operator: "hapus saja blocker Live nya jangan di
// bypass") — hard block ARM-in-LIVE DIHAPUS PERMANEN. Escape hatch
// ARM_LIVE_BYPASS yang sebelumnya ada juga DIHAPUS: tidak ada lagi env flag
// yang perlu di-set, jadi tidak ada lagi nilai "basi" yang bisa terbawa
// restart. Test di bawah mengunci perilaku BARU ini.
describe("ARM dihapus blocker-nya: identik di PAPER dan LIVE (27 Okt 2026)", () => {
  it("restoreArmedState di LIVE memulihkan nilai ARM dari DB (tidak dipaksa false)", async () => {
    const prev = process.env.BINANCE_EXECUTION_MODE;
    process.env.BINANCE_EXECUTION_MODE = "LIVE";
    try {
      const repo = new MemoryGuardRepo();
      repo.armed = true;
      const guard = new DailyRiskGuard({ repo, initialArmed: false });
      await guard.restoreArmedState();
      expect(guard.isArmed()).toBe(true);
      expect(repo.loggedEvents.some((e) => e.type === "ARM_BLOCKED_LIVE")).toBe(false);
    } finally {
      process.env.BINANCE_EXECUTION_MODE = prev;
    }
  });

  it("setArmed(true) di LIVE tidak lagi ditolak", async () => {
    const prev = process.env.BINANCE_EXECUTION_MODE;
    process.env.BINANCE_EXECUTION_MODE = "LIVE";
    try {
      const repo = new MemoryGuardRepo();
      const guard = new DailyRiskGuard({ repo, initialArmed: false });
      await expect(guard.setArmed(true, "TEST")).resolves.toBeUndefined();
      expect(guard.isArmed()).toBe(true);
      expect(repo.armed).toBe(true);
      expect(repo.loggedEvents.some((e) => e.type === "ARM_BLOCKED_LIVE")).toBe(false);
    } finally {
      process.env.BINANCE_EXECUTION_MODE = prev;
    }
  });

  it("tidak ada lagi env flag ARM_LIVE_BYPASS yang mengubah perilaku ARM", async () => {
    const prevMode = process.env.BINANCE_EXECUTION_MODE;
    const prevBypass = process.env.ARM_LIVE_BYPASS;
    process.env.BINANCE_EXECUTION_MODE = "LIVE";
    // sengaja menyisakan flag basi — harus diabaikan, bukan di-error.
    process.env.ARM_LIVE_BYPASS = "1";
    try {
      const repo = new MemoryGuardRepo();
      repo.armed = true;
      const guard = new DailyRiskGuard({ repo, initialArmed: false });
      await guard.restoreArmedState();
      expect(guard.isArmed()).toBe(true);
      await guard.setArmed(false, "TEST");
      expect(guard.isArmed()).toBe(false);
    } finally {
      process.env.BINANCE_EXECUTION_MODE = prevMode;
      if (prevBypass === undefined) delete process.env.ARM_LIVE_BYPASS;
      else process.env.ARM_LIVE_BYPASS = prevBypass;
    }
  });
});

// ── PERSIST ARM: nilainya harus benar-benar tersimpan, termasuk di mode LIVE ──
// Bug yang ditemukan 27 Okt 2026 setelah menghapus blocker ARM-in-LIVE:
// prismaGuardRepo.setArmSetting() masih MENGHAPUS nilai "true" saat mode LIVE
// (`persist = armed && live ? false : armed`). Akibatnya ARM yang dinyalakan
// operator tidak pernah tersimpan -> setiap restart service mengembalikan
// ARM=false, liveReady=false, dan bot berhenti entry. Test ini mengunci
// perilaku benar: nilai ARM apa adanya tersimpan di kedua mode.
describe("PERSIST ARM: nilai operator tersimpan di PAPER dan LIVE", () => {
  it("prismaGuardRepo.setArmed(true) di LIVE MENYIMPAN 'true' (tidak ditolak diam-diam)", async () => {
    const prevMode = process.env.BINANCE_EXECUTION_MODE;
    process.env.BINANCE_EXECUTION_MODE = "LIVE";
    try {
      await prismaGuardRepo.setArmSetting(true);
      const saved = await prismaGuardRepo.getArmSetting();
      expect(saved).toBe(true);

      await prismaGuardRepo.setArmSetting(false);
      expect(await prismaGuardRepo.getArmSetting()).toBe(false);
    } finally {
      process.env.BINANCE_EXECUTION_MODE = prevMode;
      await prismaGuardRepo.setArmSetting(false);
    }
  });

  it("setArmed(true) di LIVE lewat guard menyimpan ARM=true di repo (persist nyata)", async () => {
    const prevMode = process.env.BINANCE_EXECUTION_MODE;
    process.env.BINANCE_EXECUTION_MODE = "LIVE";
    try {
      const guard = new DailyRiskGuard({ repo: prismaGuardRepo, initialArmed: false });
      await guard.setArmed(true, "TEST_PERSIST_LIVE");
      expect(guard.isArmed()).toBe(true);
      expect(await prismaGuardRepo.getArmSetting()).toBe(true);
    } finally {
      process.env.BINANCE_EXECUTION_MODE = prevMode;
      await prismaGuardRepo.setArmSetting(false);
    }
  });
});
