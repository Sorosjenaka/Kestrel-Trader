// apps/web/src/lib/api.ts
//
// 25 Okt 2026 (FASE 1 auth, perintah operator):
// Jalur autentikasi browser untuk endpoint mutasi. Token TIDAK pernah:
//   - di-hardcode di bundle frontend,
//   - dikirim lewat URL/query,
//   - dicetak ke console/log.
// Operator memasukkan token sekali via dialog/Settings; disimpan di
// sessionStorage (hilang saat tab ditutup) dan dikirim sebagai header
// `x-api-token` hanya pada request non-GET.

const TOKEN_KEY = "artatrade_api_token";

export function getApiToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage tidak tersedia — abaikan; request akan 401 dan prompt lagi */
  }
}

/** Minta token ke operator bila belum ada. Return "" bila dibatalkan. */
export function promptApiToken(reason?: string): string {
  const hint = reason ? ` (${reason})` : "";
  const val = window.prompt(
    `API token mutasi${hint}.\n` +
      "Disimpan di sesi browser ini saja (sessionStorage) · tidak di bundle, URL, atau log.\n" +
      "Ambil dari file .env server (API_MUTATION_TOKEN) milik Anda sendiri:",
    getApiToken() || "",
  );
  const token = (val ?? "").trim();
  if (token) setApiToken(token);
  return token;
}

export class ApiAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ApiAuthError";
  }
}

/**
 * fetch wrapper: menyuntik `x-api-token` pada request mutasi (non-GET).
 * Melempar ApiAuthError saat 401/503 supaya caller bisa meminta token baru
 * (bukan menampilkan error generik yang menyesatkan).
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    let token = getApiToken();
    if (!token) token = promptApiToken("diperlukan untuk aksi ini");
    if (token) headers.set("x-api-token", token);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 || res.status === 503) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 503 && body?.error === "AUTH_NOT_CONFIGURED") {
      throw new ApiAuthError(503, "Server tidak mengonfigurasi API_MUTATION_TOKEN; mutasi ditahan oleh server.");
    }
    // Token salah/kedaluwarsa: minta yang baru SEKALI lalu ulangi request.
    const retry = promptApiToken("token ditolak server");
    if (retry) {
      headers.set("x-api-token", retry);
      const res2 = await fetch(input, { ...init, headers });
      if (!res2.ok && (res2.status === 401 || res2.status === 503)) {
        throw new ApiAuthError(res2.status, "Autentikasi mutasi ditolak server.");
      }
      return res2;
    }
    throw new ApiAuthError(res.status, "Autentikasi mutasi dibatalkan/ditolak.");
  }
  return res;
}
