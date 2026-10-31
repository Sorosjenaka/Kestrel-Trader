/** Verify the local operational state before announcing a completed shutdown. */
// 25 Okt 2026 (FASE 1 auth): default memakai apiFetch (kirim x-api-token dari
// sessionStorage); parameter `request` dipertahankan untuk test.
import { apiFetch } from "./api.js";

export async function shutdownTerminal(request: typeof fetch = apiFetch as typeof fetch): Promise<void> {
  const result = await request("/api/settings/kill", { method: "POST" });
  if (!result.ok) throw new Error(`Penutupan belum terkonfirmasi (HTTP ${result.status}).`);
  const body = await result.json();
  if (body.ok !== true) throw new Error("Server belum mengonfirmasi penutupan.");
  const [positionsRes, settingsRes, botRes] = await Promise.all([
    request("/api/positions?status=OPEN"), request("/api/settings"), request("/api/bot/status"),
  ]);
  if (![positionsRes, settingsRes, botRes].every((r) => r.ok)) {
    throw new Error("Tidak dapat memverifikasi posisi, ARM, dan bot sesudah penutupan.");
  }
  const [positions, settings, bot] = await Promise.all([
    positionsRes.json(), settingsRes.json(), botRes.json(),
  ]);
  if (!Array.isArray(positions.positions) || positions.positions.length > 0 ||
      settings.arm !== false || bot.isRunning !== false) {
    throw new Error("Penutupan belum selesai: periksa posisi, ARM, dan status bot.");
  }
}
