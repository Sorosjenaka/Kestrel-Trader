// FETCHER DATA BTCUSDT 2026 (1m) + agregasi 3m/5m dari Binance Futures.
import https from "https";
import fs from "fs";

const START = Date.parse("2026-01-01T00:00:00Z");
const END = Date.now();
const OUT_DIR = "/opt/kestrel/scripts/data";

interface Bar { openTime: number; open: number; high: number; low: number; close: number; volume: number; }

function fetchBatch(startTime: number, endTime: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1500`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (!Array.isArray(j)) return reject(new Error("bad response: " + data.substring(0, 150)));
          resolve(j);
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function aggregate(bars: Bar[], minutes: number): Bar[] {
  const ms = minutes * 60_000;
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let curKey = -1;
  for (const b of bars) {
    const key = Math.floor(b.openTime / ms);
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      cur = { openTime: key * ms, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main() {
  console.log(`Fetch BTCUSDT 1m from ${new Date(START).toISOString()} to ${new Date(END).toISOString()}`);
  const all: Bar[] = [];
  let cur = START;
  let batch = 0;
  while (cur < END && batch < 400) {
    const rows = await fetchBatch(cur, END);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) {
      all.push({ openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    cur = rows[rows.length - 1][0] + 60_000;
    batch++;
    if (batch % 25 === 0) console.log(`  batch ${batch}: ${all.length} bars -> ${new Date(cur).toISOString()}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  const seen = new Set<number>();
  const uniq = all.filter((b) => { if (seen.has(b.openTime)) return false; seen.add(b.openTime); return true; });
  uniq.sort((a, b) => a.openTime - b.openTime);
  fs.writeFileSync(`${OUT_DIR}/btcusdt_1m_2026.json`, JSON.stringify(uniq));
  console.log(`1m: ${uniq.length} bars saved`);
  for (const m of [3, 5]) {
    const agg = aggregate(uniq, m);
    fs.writeFileSync(`${OUT_DIR}/btcusdt_${m}m_2026.json`, JSON.stringify(agg));
    console.log(`${m}m: ${agg.length} bars saved`);
  }
  console.log("FETCH_DONE");
}
main().catch((e) => { console.error("FETCH_FAILED", e); process.exit(1); });
