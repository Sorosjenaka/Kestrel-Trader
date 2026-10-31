#!/usr/bin/env node
// Fail-closed child runner. Creates the output directory BEFORE redirecting,
// records both wrapper and child exit codes, and writes the final manifest
// atomically. A child failure is never converted into wrapper success.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const out = path.resolve(arg("out", "data/run-manifest"));
const runId = arg("run-id", `RUN-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15)}`);
const parent = arg("parent", null);
const commandAt = process.argv.indexOf("--");
if (commandAt < 0 || !process.argv[commandAt + 1]) {
  console.error("USAGE: node tools/run-with-manifest.mjs --out DIR --run-id ID -- CMD [ARGS...]");
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const stdoutPath = path.join(out, "stdout.log");
const stderrPath = path.join(out, "stderr.log");
const manifestPath = path.join(out, "manifest.json");
const startedAt = new Date().toISOString();
const cmd = process.argv.slice(commandAt + 1);
const child = spawn(cmd[0], cmd.slice(1), { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const outStream = fs.createWriteStream(stdoutPath);
const errStream = fs.createWriteStream(stderrPath);
let spawnError = null;
child.stdout.pipe(outStream);
child.stderr.pipe(errStream);
child.on("error", (e) => { spawnError = e.message; });
const writeManifest = (extra) => {
  const final = {
    schemaVersion: 1, runId, parentRunId: parent || null, purpose: arg("purpose", "child-run"),
    command: cmd.slice(0, 1).concat(cmd.slice(1).map((x) => x.replace(/(api[_-]?key|secret|token)=[^ ]+/gi, "$1=[REDACTED]"))),
    cwd: process.cwd(), startedAt, endedAt: new Date().toISOString(),
    wrapperExit: extra.wrapperExit ?? null, childExit: extra.childExit ?? null,
    signal: extra.signal ?? null, terminationReason: extra.terminationReason ?? null,
    resultValidity: extra.resultValidity ?? "UNVERIFIED", spawnError,
    evidence: { stdout: "stdout.log", stderr: "stderr.log", manifest: "manifest.json" },
  };
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(final, null, 2));
  fs.renameSync(tmp, manifestPath);
  return final;
};
writeManifest({ resultValidity: "RUNNING" });
let finished = false;
child.on("close", (code, signal) => {
  if (finished) return;
  finished = true;
  outStream.end(); errStream.end();
  const wrapperExit = code === 0 && !signal && !spawnError ? 0 : (code ?? 1);
  writeManifest({ wrapperExit, childExit: code, signal: signal ?? null,
    terminationReason: spawnError ? "SPAWN_ERROR" : signal ? `SIGNAL_${signal}` : code === 0 ? "CHILD_SUCCESS" : "CHILD_FAILURE",
    resultValidity: code === 0 && !signal && !spawnError ? "PROCESS_SUCCESS" : "FAILED" });
  process.exitCode = wrapperExit;
});
// A harness timeout/stop must not leave a stale RUNNING manifest.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    if (finished) return;
    finished = true;
    try { child.kill("SIGTERM"); } catch {}
    writeManifest({ wrapperExit: 1, childExit: null, signal: sig, terminationReason: "WRAPPER_TERMINATED", resultValidity: "INTERRUPTED" });
    process.exitCode = 1;
    setTimeout(() => process.exit(143), 100);
  });
}
