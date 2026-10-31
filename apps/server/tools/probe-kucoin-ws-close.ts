// apps/server/tools/probe-kucoin-ws-close.ts
// READ-ONLY live probe: kenapa socket KUCOIN ditutup (code 1000 "Bye") tepat
// ~60 detik setelah connect?
//
// Hipotesis: bursa mewajibkan heartbeat/ping dari client; tanpa ping, bursa
// menutup koneksi setelah idle timeout. Socket adapter (wsLink.ts) punya opsi
// `heartbeatMs` tapi TIDAK PERNAH mengimplementasikannya.
//
// Probe ini TIDAK melakukan order, TIDAK menandatangani request, hanya
// subscribe feed publik dan mengukur:
//   1. apakah ack/welcome/trade datang
//   2. kapan socket ditutup (dan dengan kode apa)
//   3. apakah ping periodik (JSON {type:"ping"}) mencegah penutupan
//
// Cara: npx tsx apps/server/tools/probe-kucoin-ws-close.ts [--ping] [--seconds 75]
import WebSocket from "ws";

const args = process.argv.slice(2);
const SEND_PING = args.includes("--ping");
const secondsIdx = args.indexOf("--seconds");
const SECONDS = secondsIdx >= 0 ? Number(args[secondsIdx + 1]) : 75;

const TOPIC = "/market/match:BTC-USDT";

async function fetchToken(): Promise<{ token: string; endpoint: string }> {
  const r = await fetch("https://api.kucoin.com/api/v1/bullet-public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`bullet-public HTTP ${r.status}`);
  const j: any = await r.json();
  const token = j?.data?.token;
  const srv = j?.data?.instanceServers?.[0];
  if (!token) throw new Error("bullet-public tanpa token");
  let base = String(srv?.endpoint ?? "wss://ws-api-spot.kucoin.com/");
  if (!/^wss?:\/\//i.test(base)) base = `wss://${base}`;
  base = base.replace(/\/+$/, "");
  return { token: String(token), endpoint: `${base}/endpoint` };
}

const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const { token, endpoint } = await fetchToken();
console.log(`[probe] endpoint=${endpoint} ping=${SEND_PING} durasi=${SECONDS}s`);

const ws = new WebSocket(`${endpoint}?token=${encodeURIComponent(token)}`, { handshakeTimeout: 12_000 });

let msgCount = 0;
let tradeCount = 0;
let closed = false;

ws.on("open", () => {
  console.log(`[${el()}] OPEN`);
  ws.send(JSON.stringify({
    id: `at-BTC`, type: "subscribe", topic: TOPIC, privateChannel: false, response: true,
  }));
  if (SEND_PING) {
    // Ping periodik 20 detik, format KuCoin (JSON, bukan frame ping WebSocket).
    const t = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(t);
      ws.send(JSON.stringify({ id: `ping-${Date.now()}`, type: "ping" }));
      console.log(`[${el()}] PING terkirim`);
    }, 20_000);
    ws.on("close", () => clearInterval(t));
  }
});

ws.on("message", (raw) => {
  msgCount++;
  let m: any;
  try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "message" && m.data) {
    const rows = Array.isArray(m.data) ? m.data : [m.data];
    if (rows.some((r: any) => r?.tradeId)) tradeCount++;
  }
  if (msgCount <= 3 || m.type === "ack" || m.type === "welcome" || m.type === "pong") {
    console.log(`[${el()}] MSG #${msgCount} type=${m.type} ${JSON.stringify(m).slice(0, 140)}`);
  }
});

ws.on("error", (e) => console.log(`[${el()}] ERROR ${e.message}`));
ws.on("close", (code, reason) => {
  closed = true;
  console.log(`[${el()}] CLOSED code=${code} reason="${reason?.toString()?.slice(0, 60)}" msg=${msgCount} trades=${tradeCount}`);
});

setTimeout(() => {
  if (!closed) {
    console.log(`[${el()}] MASIH TERBUKA setelah ${SECONDS}s — msg=${msgCount} trades=${tradeCount}`);
    try { ws.close(); } catch { /* noop */ }
  }
  console.log(`[probe] RINGKASAN ping=${SEND_PING} closed=${closed} msg=${msgCount} trades=${tradeCount}`);
  process.exit(0);
}, SECONDS * 1000);
