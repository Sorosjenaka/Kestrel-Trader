// apps/server/tests/lossCooldown.test.ts
// Guard cooldown pasca-LOSS 15 menit global (perintah operator 11 Okt 2026, varian
// "15 menit semua simbol", dasar data audit 5 Whys 15/15 revenge <15m).
import { afterEach, describe, expect, it } from "vitest";
import {
  LossCooldownGuard,
  LOSS_COOLDOWN_BLOCK_MIN,
  assertLossCooldownForEntry,
  lossCooldownGuard,
} from "../src/risk/lossCooldown.js";
import { env } from "../src/core/env.js";

const MIN = 60_000;

describe("LossCooldownGuard — boundary math", () => {
  it("loss memblokir entry 15 menit; diblokir di T-1, bebas TEPAT di T", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    expect(g.isBlocked(1_000_000 + 15 * MIN - 1)).toBe(true);
    expect(g.isBlocked(1_000_000 + 15 * MIN)).toBe(false);
    expect(g.remainingMs(1_000_000 + 14 * MIN)).toBe(MIN);
  });

  it("win tidak memulai cooldown dan tidak mengubah loss terakhir", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    g.recordClose(true, 1_000_000 + 5 * MIN);
    expect(g.sinceLossMin(1_000_000 + 6 * MIN)).toBeCloseTo(6, 5);
    expect(g.isBlocked(1_000_000 + 16 * MIN)).toBe(false);
  });

  it("loss kedua memundurkan cooldown (menghitung dari loss terakhir)", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    g.recordClose(false, 1_000_000 + 10 * MIN);
    expect(g.isBlocked(1_000_000 + 15 * MIN)).toBe(true);
    expect(g.isBlocked(1_000_000 + 25 * MIN)).toBe(false);
  });

  it("tanpa loss: tidak pernah memblokir", () => {
    const g = new LossCooldownGuard();
    expect(g.isBlocked(9_999_999)).toBe(false);
    expect(g.sinceLossMin()).toBeNull();
  });

  it("seed dari riwayat DB: blok aktif bila <15 menit, bebas bila lewat, null/NaN diabaikan", () => {
    const g = new LossCooldownGuard();
    g.seed(1_000_000);
    expect(g.isBlocked(1_000_000 + 10 * MIN)).toBe(true);
    expect(g.isBlocked(1_000_000 + 15 * MIN)).toBe(false);
    const g2 = new LossCooldownGuard();
    g2.seed(null);
    g2.seed(Number.NaN);
    expect(g2.isBlocked(1_000_000)).toBe(false);
  });

  it("seed tidak pernah memundurkan loss yang lebih baru", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 5_000_000 });
    g.seed(1_000_000);
    expect(g.sinceLossMin(5_000_000)).toBe(0);
  });

  it("clear() menghapus state", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    expect(g.isBlocked(1_000_000)).toBe(true);
    g.clear();
    expect(g.isBlocked(1_000_000)).toBe(false);
  });

  it("guard GLOBAL: berlaku untuk semua simbol (API tanpa parameter simbol) + konstanta 15 menit", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    expect(g.isBlocked(1_000_000 + 1)).toBe(true);
    expect(LOSS_COOLDOWN_BLOCK_MIN).toBe(15); // keputusan operator 11 Okt 2026
  });

  it("close SL: blokir panjang 60 menit; loss non-SL tetap 15 menit (perintah operator 13 Okt 2026)", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    g.recordClose(false, 1_000_000 + 20 * MIN, "SL"); // loss kedua, reason SL
    // 20+15 menit sejak loss pertama sudah lewat, tapi SL baru 20 menit -> masih blokir
    expect(g.isBlocked(1_000_000 + 35 * MIN)).toBe(true);
    // bebas tepat di 20 + 60 menit sejak SL
    expect(g.isBlocked(1_000_000 + 20 * MIN + 60 * MIN - 1)).toBe(true);
    expect(g.isBlocked(1_000_000 + 20 * MIN + 60 * MIN)).toBe(false);
    // remainingMs mengikuti anchor terpanjang
    expect(g.remainingMs(1_000_000 + 50 * MIN)).toBe(30 * MIN);
  });

  it("recordClose TANPA reason (jalur lama): perilaku tidak berubah, tetap 15 menit", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    g.recordClose(false, 1_000_000 + 10 * MIN); // tanpa closeReason
    expect(g.isBlocked(1_000_000 + 25 * MIN - 1)).toBe(true);
    expect(g.isBlocked(1_000_000 + 25 * MIN)).toBe(false); // bebas TEPAT di T
  });

  it("loss non-SL lebih baru TIDAK memundurkan anchor SL 60 menit", () => {
    const g = new LossCooldownGuard({ initialLastLossAt: 1_000_000 });
    g.recordClose(false, 1_000_000 + 30 * MIN, "SL");
    g.recordClose(false, 1_000_000 + 40 * MIN); // loss biasa lebih baru
    // SL tetap anchor: 30 + 60 = 90 menit
    expect(g.isBlocked(1_000_000 + 89 * MIN)).toBe(true);
    expect(g.isBlocked(1_000_000 + 90 * MIN)).toBe(false);
  });

  it("seedSl: blokir aktif <60 menit sejak SL; null/NaN diabaikan; tidak memundurkan", () => {
    const g = new LossCooldownGuard();
    g.seedSl(1_000_000);
    expect(g.isBlocked(1_000_000 + 59 * MIN)).toBe(true);
    expect(g.isBlocked(1_000_000 + 60 * MIN)).toBe(false);
    g.seedSl(Number.NaN);
    g.seedSl(null);
    expect(g.isBlocked(1_000_000 + 1)).toBe(true);
    const g2 = new LossCooldownGuard({ initialLastLossAt: 5_000_000 });
    g2.seedSl(1_000_000); // anchor SL lebih tua: diabaikan (max)
    // loss anchor 5.000.000 -> bebas tepat di 5.900.000 (15 menit); SL (4.600.000) sudah lewat
    expect(g2.isBlocked(5_900_000 - 1)).toBe(true);
    expect(g2.isBlocked(5_900_000)).toBe(false);
  });
});

describe("assertLossCooldownForEntry — seam pra-order (fail-closed)", () => {
  afterEach(() => {
    lossCooldownGuard.clear();
    env.LOSS_COOLDOWN_ENABLED = true;
  });

  it("melempar saat cooldown aktif (order tidak boleh dikirim); bebas setelah 15 menit", () => {
    lossCooldownGuard.recordClose(false, Date.now());
    expect(() => assertLossCooldownForEntry()).toThrow(/LOSS_COOLDOWN_BLOCKED_/);
    lossCooldownGuard.clear();
    expect(() => assertLossCooldownForEntry()).not.toThrow();
  });

  it("rollback: LOSS_COOLDOWN_ENABLED=false mematikan veto", () => {
    lossCooldownGuard.recordClose(false, Date.now());
    env.LOSS_COOLDOWN_ENABLED = false;
    expect(() => assertLossCooldownForEntry()).not.toThrow();
  });
});
