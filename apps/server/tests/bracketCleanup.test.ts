// tests/bracketCleanup.test.ts — 13 Okt 2026 (insiden orphan SL/TP 3028/3029).
// 16 skenario wajib operator: SL/TP fill -> sibling dibatalkan; watchdog/manual
// close; posisi terbuka & partial tidak disentuh; cancel timeout = query dulu;
// sibling sudah terisi; idempotent; race server/watchdog; atribusi ambigu;
// order manual asing; jalur algo; recovery restart; query gagal; posisi berubah
// di tengah jalan. Semua respons exchange DI-MOCK — tidak ada order nyata.
import { describe, expect, it } from "vitest";
import {
  cancelWithConfirmation, cleanupProtectiveOrders, collectOwnedProtectiveOrders,
  isProtectiveAlgoId, protectiveBase, verifyFlat,
  type CleanupExchange, type CleanupRepo,
} from "../src/exec/bracketCleanup.js";

const SYM = "TESTUSDT";
const ENTRY = "AT_TESTU_1700000000000_ABC123"; // 30 char setelah sanitasi
const SLA = `SLA_${ENTRY}`;
const TPA = `TPA_${ENTRY}`;

interface AlgoSpec {
  status: string;
  cancelErr?: { code?: number; message: string; accepted?: boolean };
  queryErr?: { code?: number; message: string };
}

function makeEx(opts: {
  positionAmt: number | "ERR" | Array<number | "ERR">;  // array = per getIndex (race #16)
  algos: Record<string, AlgoSpec>;
  openList?: Array<{ symbol: string; clientAlgoId: string }>;
  openListErr?: boolean;
  afterCancel?: (cid: string) => void;   // hook mutasi state antar panggilan
}): CleanupExchange & { calls: string[] } {
  const calls: string[] = [];
  let amtIndex = 0;
  const amtSeq = Array.isArray(opts.positionAmt) ? opts.positionAmt : [opts.positionAmt];
  return {
    calls,
    async getPositionRisk() {
      const v = amtSeq[Math.min(amtIndex, amtSeq.length - 1)];
      amtIndex++;
      if (v === "ERR") throw new Error("transport down");
      return [{ symbol: SYM, positionAmt: String(v) }];
    },
    async queryAlgo(cid: string) {
      calls.push(`query:${cid}`);
      const a = opts.algos[cid];
      if (!a) { const e: Error & { code?: number } = new Error("Order does not exist"); e.code = -2013; throw e; }
      if (a.queryErr) { const e: Error & { code?: number } = new Error(a.queryErr.message); e.code = a.queryErr.code; throw e; }
      return { clientAlgoId: cid, algoId: "1", algoStatus: a.status, triggerPrice: "1", symbol: SYM };
    },
    async cancelAlgo(cid: string) {
      calls.push(`cancel:${cid}`);
      const a = opts.algos[cid];
      if (!a) { const e: Error & { code?: number } = new Error("Unknown order"); e.code = -2011; throw e; }
      if (a.cancelErr) {
        // accepted=true = cancel DITERIMA exchange tapi respons hilang (timeout):
        // status benar-benar berubah di exchange, caller tidak melihat jawaban.
        if (a.cancelErr.accepted) a.status = "CANCELED";
        const e: Error & { code?: number } = new Error(a.cancelErr.message);
        e.code = a.cancelErr.code;
        throw e;
      }
      a.status = "CANCELED";                 // exchange memproses cancel
      opts.afterCancel?.(cid);
      return { clientAlgoId: cid, algoId: "1", algoStatus: "CANCELED", triggerPrice: "1", symbol: SYM };
    },
    async getOpenAlgoOrders() {
      calls.push("openAlgoOrders");
      if (opts.openListErr) throw new Error("listing down");
      return opts.openList ?? [];
    },
  };
}

function makeRepo(entry: string | null): CleanupRepo {
  return {
    async findEntryByPositionId() {
      return entry ? { clientOrderId: entry, reduceOnly: false } : null;
    },
  };
}

describe("bracketCleanup — helper", () => {
  it("protectiveBase menyaring & memotong 30 char; isProtectiveAlgoId hanya SLA_/TPA_", () => {
    expect(protectiveBase("AT_TESTU_1700000000000_ABC123")).toBe(ENTRY);
    expect(protectiveBase("AT_TESTU_1700000000000_ABC123EXTRA").length).toBe(30);
    expect(isProtectiveAlgoId("SLA_X")).toBe(true);
    expect(isProtectiveAlgoId("TPA_X")).toBe(true);
    expect(isProtectiveAlgoId("MY_MANUAL_STOP")).toBe(false);
    expect(isProtectiveAlgoId("WDG_abc")).toBe(false);
  });
});

describe("bracketCleanup — 16 skenario wajib", () => {
  it("1. SL fill -> flat -> sibling TP dibatalkan + terkonfirmasi", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "CANCELED" }, [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.flatVerified).toBe(true);
    expect(r.cancelled).toHaveLength(1);
    expect(r.cancelled[0]).toMatchObject({ clientAlgoId: TPA, finalStatus: "CANCELED", confirmed: true });
    expect(ex.calls).toContain(`cancel:${TPA}`);
    expect(ex.calls).not.toContain(`cancel:${SLA}`);
  });

  it("2. TP fill -> flat -> sibling SL dibatalkan", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "FINISHED" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.cancelled).toHaveLength(1);
    expect(r.cancelled[0].clientAlgoId).toBe(SLA);
    expect(r.cancelled[0].confirmed).toBe(true);
  });

  it("3. watchdog MARKET reduceOnly close -> KEDUA proteksi direkonsiliasi", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.cancelled.map((c) => c.clientAlgoId).sort()).toEqual([SLA, TPA].sort());
    expect(r.cancelled.every((c) => c.confirmed && c.finalStatus === "CANCELED")).toBe(true);
  });

  it("4. penutupan manual/eksternal -> rekonsiliasi sama (atribusi tetap dari DB)", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 77 });
    expect(r.flatVerified).toBe(true);
    expect(r.cancelled).toHaveLength(2);
  });

  it("5. posisi MASIH TERBUKA -> tidak ada proteksi yang disentuh", async () => {
    const ex = makeEx({ positionAmt: 100, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r).toMatchObject({ flatVerified: false, reason: "POSITION_STILL_OPEN", cancelled: [] });
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0);
  });

  it("6. partial close (posisi menyusut tapi terbuka) -> proteksi sisa DIPERTAHANKAN", async () => {
    const ex = makeEx({ positionAmt: 35, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.reason).toBe("POSITION_STILL_OPEN");
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0);
  });

  it("7. cancel timeout (respons hilang) -> state ditanyakan ulang sebelum retry", async () => {
    // accepted=true: cancel DITERIMA exchange tapi respons hilang — setelah
    // cancelAlgo throw, status di query berikutnya = CANCELED.
    const ex = makeEx({
      positionAmt: 0,
      algos: { [TPA]: { status: "NEW", cancelErr: { message: "timeout", accepted: true } } },
    });
    const r = await cancelWithConfirmation(ex, TPA);
    expect(r).toMatchObject({ clientAlgoId: TPA, finalStatus: "CANCELED", confirmed: true });
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(1); // TIDAK retry buta
  });

  it("8. sibling sudah FILLED (FINISHED) -> tidak ada aksi dobel yang tidak aman", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "FINISHED" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.cancelled.map((c) => c.clientAlgoId)).toEqual([SLA]);
    expect(ex.calls).not.toContain(`cancel:${TPA}`);
  });

  it("9. cleanup dipanggil dua kali -> idempotent (panggilan kedua tanpa cancel)", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } } });
    const r1 = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r1.cancelled).toHaveLength(2);
    const r2 = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r2.cancelled).toHaveLength(0);           // sudah terminal -> tidak ada aksi
    expect(r2.flatVerified).toBe(true);
  });

  it("10. race server vs watchdog (cancel lawan sudah lebih dulu) -> aman, tanpa error", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: { [TPA]: { status: "NEW", cancelErr: { code: -2011, message: "Unknown order sent" } } },
    });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.cancelled[0]).toMatchObject({ finalStatus: "NOT_FOUND", confirmed: true });
  });

  it("11. atribusi ambigu (basis tak dikenal) -> TIDAK dibatalkan, dilaporkan", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: { SLA_LAINBASIS123: { status: "NEW" } },
      openList: [{ symbol: SYM, clientAlgoId: "SLA_LAINBASIS123" }],
    });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(null), symbol: SYM, positionId: 1 });
    expect(r.cancelled).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].note).toContain("AMBIGUOUS");
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0);
  });

  it("12. order manual asing (non SLA_/TPA_) -> diawetkan, tak dilaporkan sbg kandidat", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: {},
      openList: [
        { symbol: SYM, clientAlgoId: "MY_MANUAL_STOP" },
        { symbol: "OTHERUSDT", clientAlgoId: `TPA_${ENTRY}` },
      ],
    });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(null), symbol: SYM, positionId: 1 });
    expect(r.cancelled).toHaveLength(0);
    expect(r.skipped).toHaveLength(0); // manual + simbol lain tidak masuk kandidat sama sekali
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(0);
  });

  it("13. proteksi conditional/algo diproses lewat jalur API algo yang benar", async () => {
    const ex = makeEx({ positionAmt: 0, algos: { [TPA]: { status: "NEW" } } });
    await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(ex.calls).toContain(`cancel:${TPA}`);
    expect(ex.calls).toContain(`query:${TPA}`);   // konfirmasi lewat queryAlgo
    expect(ex.calls.filter((c) => c.includes("cancelAllOrders") || c.includes("postOrder"))).toHaveLength(0);
  });

  it("14. recovery pasca-restart: orphan ditemukan & dibersihkan (basis dari DB)", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: { [TPA]: { status: "NEW" } },
      openList: [{ symbol: SYM, clientAlgoId: TPA }],
    });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 3028 });
    expect(r.cancelled).toHaveLength(1);
    expect(r.cancelled[0].confirmed).toBe(true);
  });

  it("15. query exchange gagal -> TIDAK pernah dianggap cleanup sukses", async () => {
    const ex = makeEx({ positionAmt: "ERR", algos: { [TPA]: { status: "NEW" } } });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r).toMatchObject({ flatVerified: false, reason: "POSITION_STATE_UNKNOWN", cancelled: [] });
    // verifyFlat langsung:
    expect(await verifyFlat(makeEx({ positionAmt: "ERR", algos: {} }), SYM)).toBeNull();
  });

  it("16. posisi berubah antara query dan cancel -> abort sisa cancel (fail-closed)", async () => {
    const ex = makeEx({
      positionAmt: [0, 0, 50],  // verify awal flat, verify sebelum cancel#2 -> terbuka lagi
      algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } },
    });
    const r = await cleanupProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.reason).toBe("POSITION_REOPENED");
    expect(r.cancelled).toHaveLength(1);            // cancel pertama jalan saat masih flat
    expect(ex.calls).not.toContain(`cancel:${TPA}`); // sisa di-ABORT
  });
});

describe("bracketCleanup — collectOwnedProtectiveOrders (unit)", () => {
  it("DB-first menemukan algo aktif; -2013 = tidak ada; listing gagal tetap jalan", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: { [SLA]: { status: "NEW" }, [TPA]: { status: "NEW" } },
      openListErr: true,
    });
    const r = await collectOwnedProtectiveOrders({ ex, repo: makeRepo(ENTRY), symbol: SYM, positionId: 1 });
    expect(r.owned.sort()).toEqual([SLA, TPA].sort());
    expect(r.ambiguous).toHaveLength(0);
  });

  it("cancel hasil tak pasti terus-menerus -> UNCONFIRMED (bounded, tidak loop)", async () => {
    const ex = makeEx({
      positionAmt: 0,
      algos: { [TPA]: { status: "NEW", cancelErr: { message: "timeout" }, queryErr: { message: "timeout" } } },
    });
    const r = await cancelWithConfirmation(ex, TPA);
    expect(r.confirmed).toBe(false);
    expect(r.finalStatus).toBe("QUERY_UNKNOWN");
    expect(ex.calls.filter((c) => c.startsWith("cancel:"))).toHaveLength(3); // initial + 2 retry
  });
});
