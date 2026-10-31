import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLocalDatabase } from "./prepare-local.mjs";

export function localLaunchPlan(args = []) {
  const modeArg = args.find(arg => arg.startsWith("--mode="));
  const mode = modeArg?.slice(7).toUpperCase() ?? "SWING";
  if (!["SCALP", "SWING", "BOTH"].includes(mode)) throw new Error("INVALID_TRADING_MODE");
  return { mode, profile: "local", script: `dev:${mode.toLowerCase()}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = localLaunchPlan(process.argv.slice(2));
  if (process.argv.includes("--print-plan")) {
    console.log(JSON.stringify(plan));
  } else {
    // Explicit local profile skips account env files and enforces PAPER, ARM OFF.
    // Invoke npm's JS entry directly so Windows does not require a command shell.
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("Run this launcher with npm run dev:local");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await prepareLocalDatabase(root);
    const child = spawn(process.execPath, [npmCli, "run", plan.script, "--workspace", "apps/server"], {
      cwd: root,
      env: { ...process.env, ARTA_ENV_PROFILE: plan.profile },
      stdio: "inherit",
    });
    child.on("error", () => { console.error("LOCAL_LAUNCH_FAILED"); process.exitCode = 1; });
    child.on("exit", code => { process.exitCode = code ?? 1; });
  }
}
