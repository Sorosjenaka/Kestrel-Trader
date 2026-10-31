// apps/server/tools/probe-drex-chart-render.ts
// 24 Okt 2026 — PROBE LOKAL (offline, tanpa jaringan): apakah renderer chart PNG
// pure-Node menghasilkan PNG yang VALID dan bisa dibaca?
//
// Membuktikan: signature PNG benar, IHDR benar, dan gambar TIDAK kosong
// (ada pixel non-background = ada candlestick yang tergambar).
import { writeFileSync } from "node:fs";
import { renderChartPng, renderChartBase64 } from "../src/agents/drexChart.js";

function syntheticBars(n: number, start = 80000) {
  const bars = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 120 + (i % 11 === 0 ? 260 : 0);
    const open = price;
    const close = open + drift * 0.6;
    const high = Math.max(open, close) + 40 + (i % 5) * 12;
    const low = Math.min(open, close) - 40 - (i % 3) * 15;
    bars.push({ openTime: 1_760_000_000_000 + i * 3_600_000, open, high, low, close, volume: 1000 + i });
    price = close;
  }
  return bars;
}

const bars = syntheticBars(120);
const png = renderChartPng(bars, {
  symbol: "BTCUSDT",
  timeframe: "1h",
  maxBars: 120,
  levels: { entry: bars[bars.length - 1]!.close, sl: bars[bars.length - 1]!.close * 0.98, tp: bars[bars.length - 1]!.close * 1.04 },
});

const b64 = renderChartBase64(bars, { symbol: "BTCUSDT", timeframe: "1h", maxBars: 120 });
const out = "/tmp/drex-chart-probe.png";
writeFileSync(out, png);

const sig = png.subarray(0, 8).toString("hex");
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
const bitDepth = png[24];
const colorType = png[25];
// Hitung pixel non-background: dekompres IDAT.
import { inflateSync } from "node:zlib";
let idat = Buffer.alloc(0);
let off = 8;
while (off < png.length) {
  const len = png.readUInt32BE(off);
  const type = png.subarray(off + 4, off + 8).toString("ascii");
  if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(off + 8, off + 8 + len)]);
  off += 12 + len;
}
const raw = inflateSync(idat);
const stride = width * 3;
let nonBg = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  if (filter !== 0) { console.log("FILTER_BARU:", filter, "di baris", y); break; }
  for (let x = 0; x < width; x++) {
    const o = y * (stride + 1) + 1 + x * 3;
    if (raw[o] !== 11 || raw[o + 1] !== 14 || raw[o + 2] !== 20) nonBg++;
  }
}

console.log("== PROBE RENDER CHART PNG (pure-Node, tanpa chromium) ==");
console.log(`file            : ${out}`);
console.log(`png bytes       : ${png.length}`);
console.log(`base64 chars    : ${b64.length}`);
console.log(`signature       : ${sig} (harus 89504e470d0a1a0a)`);
console.log(`IHDR            : ${width}x${height} depth=${bitDepth} colorType=${colorType} (2=RGB)`);
console.log(`pixel non-bg    : ${nonBg} (harus > 0 => ada isi chart)`);
console.log(`PNG_VALID       : ${sig === "89504e470d0a1a0a" && width > 0 && height > 0 && nonBg > 0 ? "YA" : "TIDAK"}`);
