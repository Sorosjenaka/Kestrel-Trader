// Isolated worker: child receives no exchange/provider credential environment.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const safeEnv = Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP"].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const child = spawn(process.platform === "win32" ? "python" : "python3",
  ["research/swing_forward_paper.py", ...process.argv.slice(2)], { cwd: root, env: safeEnv, stdio: "inherit", windowsHide: true });
child.on("error",()=>{ process.stderr.write("Unable to start isolated PAPER Python worker.\n");process.exitCode=1; });
child.on("exit",code=>{process.exitCode=code??1;});
process.on("SIGINT",()=>child.kill("SIGINT"));
process.on("SIGTERM",()=>child.kill("SIGTERM"));
