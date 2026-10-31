// apps/server/tools/probe-live-readonly.ts — probe READ-ONLY exchange (19 Okt 2026).
// Tujuan: memverifikasi jalur data LIVE yang dipakai depth guard / ladder TANPA
// mengirim order dan TANPA menyentuh ARM. Semua panggilan GET publik/private-read.
// Output tidak pernah memuat key/secret.
//
// Jalankan: cd apps/server && npx tsx tools/probe-live-readonly.ts [SYMBOL]
import { env } from "../src/core/env.js";
import { BinanceUsdMClient } from "../src/exec/binanceUsdMClient.js";

async function main(): Promise<void> {
  const symbol = (process.argv[2] ?? "BTCUSDT").toUpperCase();
  if (!env.BINANCE_API_KEY || !env.BINANCE_API_SECRET) {
    console.log(JSON.stringify({ ok: false, reason: "BINANCE_KEY_MISSING", readOnly: true }));
    process.exitCode = 2;
    return;
  }
  const client = new BinanceUsdMClient({
    apiKey: env.BINANCE_API_KEY,
    apiSecret: env.BINANCE_API_SECRET,
    timeoutMs: 8000,
  });
  const out: Record<string, unknown> = {
    readOnly: true,
    armTouched: false,
    executionMode: env.BINANCE_EXECUTION_MODE,
    symbol,
    checkedAt: new Date().toISOString(),
  };
  try {
    const book = await client.getDepth(symbol, 5);
    const bid = Number(book.bids[0]?.[0]);
    const ask = Number(book.asks[0]?.[0]);
    out.depth = {
      ok: book.bids.length > 0 && book.asks.length > 0,
      bids: book.bids.length,
      asks: book.asks.length,
      bestBid: Number.isFinite(bid) ? bid : null,
      bestAsk: Number.isFinite(ask) ? ask : null,
      spreadBps: Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 10_000 : null,
    };
  } catch (err) {
    out.depth = { ok: false, error: (err as Error)?.message?.slice(0, 160) };
  }
  try {
    const algos = await client.getOpenAlgoOrders();
    out.openAlgoOrders = { ok: true, count: algos.length };
  } catch (err) {
    out.openAlgoOrders = { ok: false, error: (err as Error)?.message?.slice(0, 160) };
  }
  try {
    const positions = await client.getPositionRiskAll();
    out.exchangePositions = {
      ok: true,
      open: positions.filter((p) => Number(p.positionAmt) !== 0).length,
    };
  } catch (err) {
    out.exchangePositions = { ok: false, error: (err as Error)?.message?.slice(0, 160) };
  }
  const ok = (out.depth as { ok?: boolean })?.ok === true;
  console.log(JSON.stringify({ ok, ...out }, null, 1));
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, readOnly: true, error: (err as Error)?.message?.slice(0, 200) }));
  process.exit(1);
});
