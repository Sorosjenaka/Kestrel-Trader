// apps/server/src/learning/vaultMemoryLoader.ts
// Membaca vault/memory/*.md (diisi user via Obsidian) sebagai konteks behavior/rules
// untuk systemPrompt LLM. Cache by mtime; fail-safe: file rusak/tidak ada → prompt normal.
import fs from "node:fs";
import path from "node:path";

export interface VaultMemoryFile {
  name: string;
  content: string;
  priority: number;
  mtimeMs: number;
}

const PRIORITY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1, low: 0 };
const MAX_CHARS = Number(process.env.VAULT_MEMORY_MAX_CHARS ?? 4000);

function resolveMemoryDir(): string | null {
  const candidates = [
    process.env.VAULT_MEMORY_DIR,
    path.resolve(process.cwd(), "vault/memory"),
    path.resolve(process.cwd(), "../../vault/memory"),
    "/opt/kestrel/vault/memory",
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      /* coba kandidat berikutnya */
    }
  }
  return null;
}

let cache: { stamp: string; block: string } | null = null;

function readMemoryFiles(): VaultMemoryFile[] {
  const dir = resolveMemoryDir();
  if (!dir) return [];
  const out: VaultMemoryFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      const raw = fs.readFileSync(full, "utf8");
      const prioMatch = raw.match(/^priority:\s*(\w+)/m);
      out.push({
        name,
        content: raw,
        priority: PRIORITY_RANK[prioMatch?.[1]?.toLowerCase() ?? "normal"] ?? 1,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* file terhapus saat dibaca — skip */
    }
  }
  return out;
}

// Stamp berubah bila ada file baru/berubah; blok prompt di-cache sampai stamp berubah.
function buildBlock(): string {
  const files = readMemoryFiles();
  if (files.length === 0) return "";
  const stamp = files.map((f) => `${f.name}:${f.mtimeMs}`).join("|");
  if (cache && cache.stamp === stamp) return cache.block;

  files.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  let used = 0;
  const parts: string[] = [];
  for (const f of files) {
    const body = f.content.replace(/^---[\s\S]*?---\s*/m, "").trim(); // buang YAML frontmatter
    if (!body) continue;
    const room = MAX_CHARS - used;
    if (room <= 0) break;
    const chunk = body.length > room ? body.slice(0, room) + "\n…(dipotong)" : body;
    used += chunk.length;
    parts.push(`### ${f.name}\n${chunk}`);
  }
  const block = `\n\n=== MEMORY VAULT (behavior & rules dari trader; patuhi saat menilai setup) ===\n${parts.join("\n\n")}\nPertahankan format keluaran sesuai instruksi utama (mis. JSON bila diminta) — memory ini hanya konteks tambahan.\n=== AKHIR MEMORY VAULT ===`;
  cache = { stamp, block };
  return block;
}

/** Blok konteks memory vault untuk ditempel ke systemPrompt. "" bila kosong/gagal. */
export function getVaultMemoryBlock(): string {
  try {
    return buildBlock();
  } catch {
    return "";
  }
}

/** Reset cache (untuk pengujian). */
export function resetVaultMemoryCache(): void {
  cache = null;
}
