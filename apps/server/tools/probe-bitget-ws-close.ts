// apps/server/tools/probe-bitget-ws-close.ts
// READ-ONLY live probe: kenapa socket BITGET ditutup (code 1006) berulang?
//
// Gejala live (25 Okt 2026, journal artatrade.service): link BITGET WS_CLOSED
// code=1006 (abnormal closure, tanpa close frame) tiap ~2-2,5 menit sepanjang
// jam, sementara venue lain stabil.
//
// Hipotesis A: format ping v2 salah. Kode produksi mengirim `{"op":"ping"}`
// (gaya v1) sementara handler pesan produksi sendiri mengecek `raw === "pong"`
// (gaya v2 = string polos). Bila bursa v2 mengabaikan `{"op":"ping"}`, bursa
// akan memutus koneksi karena tidak menerima ping yang valid.
//
// Hipotesis B: bursa v2 mewajibkan client mengirim string polos "ping" tiap
// <=30 dtk; server membalas string polos "pong".
//
// Probe TIDAK melakukan order, TIDAK menandatangani request, hanya subscribe
// feed publik dan mengukur kapan socket ditutup.
//
// Cara pakai:
//   npx tsx apps/server/tools/probe-bitget-ws-close.ts [--ping-mode none|op|raw] [--seconds 75]
//
//   none = tanpa ping (kontrol)
//   op   = kirim {"op":"ping"} (kode produksi saat ini)
//   raw  = kirim string polos "ping" (kandidat perbaikan)
import WebSocket from "ws";

const args = process.argv.slice(2);
const modeIdx = args.indexOf("--ping-mode");
const PING_MODE = (modeIdx >= 0 ? args[modeIdx + 1] : "none") as "none" | "op" | "raw";
const secondsIdx = args.indexOf("--seconds");
const SECONDS = secondsIdx >= 0 ? Number(args[secondsIdx + 1]) : 75;

const ENDPOINT = "wss://ws.bitget.com/v2/ws/public";
const INST_ID = "BTCUSDT";
const PING_INTERVAL_MS = 20_000;

const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

console.log(`[probe] endpoint=${ENDPOINT} ping-mode=${PING_MODE} durasi=${SECONDS}s`);

const ws = new WebSocket(ENDPOINT, { handshakeTimeout: 12_000 });

let msgCount = 0;
let tradeCount = 0;
let closed = false;
let pongCount = 0;

ws.on("open", () => {
  console.log(`[${el()}] OPEN`);
  // Samakan dengan kode produksi: instType "SPOT" (v2), channel trade.
  ws.send(JSON.stringify({
    op: "subscribe",
    args: [{ instType: "SPOT", channel: "trade", instId: INST_ID }],
  }));
  if (PING_MODE !== "none") {
    const t = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(t);
      const payload = PING_MODE === "op"
        ? JSON.stringify({ op: "ping" })
        : "ping";
      ws.send(payload);
      console.log(`[${el()}] PING terkirim (${PING_MODE})`);
    }, PING_INTERVAL_MS);
    ws.on("close", () => clearInterval(t));
  }
});

ws.on("message", (raw) => {
  msgCount++;
  const text = raw.toString();
  if (text === "pong") pongCount++;
  let m: any;
  try { m = JSON.parse(text); } catch { return; }
  if (m?.data && Array.isArray(m.data)) {
    if (m.data.some((r: any) => r?.tradeId)) tradeCount++;
  }
  if (msgCount <= 3 || m?.event === "subscribe" || text === "pong" || m?.event === "error") {
    console.log(`[${el()}] MSG #${msgCount} ${text.slice(0, 140)}`);
  }
});

ws.on("error", (e) => console.log(`[${el()}] ERROR ${e.message}`));
ws.on("close", (code, reason) => {
  closed = true;
  console.log(`[${el()}] CLOSED code=${code} reason="${reason?.toString()?.slice(0, 60)}" msg=${msgCount} trades=${tradeCount}`);
});

setTimeout(() => {
  if (!closed) {
    console.log(`[${el()}] MASIH TERBUKA setelah ${SECONDS}s — msg=${msgCount} trades=${tradeCount} pong=${pongCount}`);
    try { ws.close(); } catch { /* noop */ }
  }
  console.log(`[probe] RINGKASAN ping-mode=${PING_MODE} closed=${closed} msg=${msgCount} trades=${tradeCount} pong=${pongCount}`);
  process.exit(0);
}, SECONDS * 1000);
