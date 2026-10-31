// tools/boot-check.mjs - boot server dengan timeout, baca /api/health, catat bukti.
// Dipakai T-0.4 / T-0.8. Keluar 0 bila health OK, 1 bila gagal. Tanpa dependency.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "apps", "server", "src", "index.ts");
const OUT = join(ROOT, "tools", "boot-evidence.json");
const PORT = 8787;
const START_TIMEOUT_MS = 20000;

const child = spawn(process.execPath, [TSX, ENTRY], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (d) => { bootLog += String(d); });
child.stderr.on("data", (d) => { bootLog += String(d); });

const t0 = Date.now();
let health = null;
let healthErr = "";
let readyMs = -1;
while (Date.now() - t0 < START_TIMEOUT_MS) {
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/api/health");
    if (r.ok) {
      health = await r.json();
      readyMs = Date.now() - t0;
      break;
    }
  } catch (e) {
    healthErr = String((e && e.message) || e);
  }
  await new Promise((r) => setTimeout(r, 500));
}
const passed = !!(health && health.status === "ok");
const evidence = {
  ts: new Date().toISOString(),
  passed, readyMs, health, healthErr: passed ? "" : healthErr,
  bootLog: bootLog.slice(-1500),
};
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
try { child.kill("SIGKILL"); } catch { /* abaikan */ }
setTimeout(() => process.exit(passed ? 0 : 1), 500);