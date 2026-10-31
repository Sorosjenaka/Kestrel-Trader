import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function resolveDatabaseUrl(raw: string, platform = process.platform): string {
  const value = raw.trim().replace(/^file:/i, "").split("?")[0]!;
  if (!value) throw new Error("DATABASE_URL_EMPTY");
  if (platform === "win32" && /^\/(home|opt|var|srv)\//.test(value)) {
    if (value.startsWith("/opt/kestrel/")) {
      const rel = value.slice("/opt/kestrel/".length);
      return "file:" + path.resolve(projectRoot, rel).replace(/\\/g, "/");
    }
    throw new Error("DATABASE_PATH_PLATFORM_MISMATCH: use the explicit local profile or a Windows database URL");
  }
  if (platform !== "win32" && /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error("DATABASE_PATH_PLATFORM_MISMATCH");
  }
  const absolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
    ? value : path.resolve(projectRoot, "prisma", value);
  return "file:" + absolute.replace(/\\/g, "/");
}
