// Process supervisor. Importing this module never starts the trading server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT), "..");
const SERVER_ENTRY = path.join(ROOT_DIR, "apps/server/dist/index.js");
const LOG_FILE = path.join(ROOT_DIR, "logs/watchdog.log");

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  process.stdout.write(line);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line);
}

export function createWatchdog({ spawnProcess = spawn, request = fetch, writeLog = log,
  healthUrl = process.env.HEALTH_URL || `http://127.0.0.1:${process.env.PORT || 8787}/api/health`,
  restartDelayMs = 2000, stopGraceMs = 10_000 } = {}) {
  let child = null;
  let retryTimer = null;
  let healthTimer = null;
  let forceTimer = null;
  let failures = 0;
  let probing = false;
  let restarting = false;
  let stopped = false;

  function startServer() {
    if (stopped || child) return;
    restarting = false;
    failures = 0;
    // Spawn Node directly: the supervised PID is the server, never cmd/npm.
    const instance = spawnProcess(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT_DIR, shell: false, windowsHide: true, stdio: "inherit", env: { ...process.env },
    });
    child = instance;
    writeLog("Server process started.");
    const exited = () => {
      if (child !== instance) return;
      child = null;
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = null;
      if (!stopped && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; startServer(); }, restartDelayMs);
      }
    };
    instance.once("exit", exited);
    instance.once("error", () => { writeLog("Server process could not start."); exited(); });
  }

  function stopChild() {
    if (!child || restarting) return;
    restarting = true;
    const instance = child;
    instance.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      if (child === instance) instance.kill("SIGKILL");
    }, stopGraceMs);
  }

  async function checkHealth() {
    if (stopped || probing || restarting || !child) return false;
    probing = true;
    try {
      const response = await request(healthUrl, { signal: AbortSignal.timeout(3000) });
      const payload = response.ok ? await response.json() : null;
      if (payload?.status === "ok") { failures = 0; return true; }
    } catch { /* failed probes count toward a bounded restart */ }
    finally { probing = false; }
    failures++;
    writeLog(`Health probe failed (${failures}/3).`);
    if (failures >= 3) stopChild();
    return false;
  }

  function start() {
    startServer();
    if (!healthTimer) healthTimer = setInterval(checkHealth, 5000);
  }

  function stop() {
    stopped = true;
    if (healthTimer) clearInterval(healthTimer);
    if (retryTimer) clearTimeout(retryTimer);
    healthTimer = retryTimer = null;
    stopChild();
  }
  return { start, startServer, checkHealth, stop };
}

export function runWatchdogLoop() {
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error("Build the server before starting the process watchdog.");
  const watchdog = createWatchdog();
  // A short-lived PowerShell thread cannot prevent sleep.
  if (process.platform === "win32") log("For 24/7 operation, configure the Windows AC sleep policy explicitly.");
  process.once("SIGINT", () => watchdog.stop());
  process.once("SIGTERM", () => watchdog.stop());
  watchdog.start();
  return watchdog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try { runWatchdogLoop(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
