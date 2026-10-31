// apps/server/src/api/authMutations.ts
//
// 25 Okt 2026 (perintah operator — FASE 1 AUTH MUTASI):
// Middleware autentikasi route mutasi /api/ (POST/PUT/DELETE/PATCH).
//
// Kebijakan:
//   - TOKEN TIDAK PERNAH fail-open: token kosong/tidak dikonfigurasi = mutasi
//     DITOLAK (503 AUTH_NOT_CONFIGURED), BUKAN dibuka. Boot TIDAK boleh gagal
//     karena token hilang — posisi tetap terawasi; hanya mutasi API yang ditahan.
//   - Loopback BUKAN otorisasi: request lokal harus tetap membawa token
//     (jangan mengandalkan nginx/loopback sebagai satu-satunya otorisasi).
//   - GET/HEAD/OPTIONS (termasuk /api/health) tetap terbuka — read-only.
//   - Pengecualian EXACT: POST /api/tv/webhook (punya auth sendiri via
//     TV_WEBHOOK_SECRET di tv.ts). Jangan memperluas ke prefix.
//   - Perbandingan token constant-time (timingSafeEqual) — jangan bocorkan
//     token ke log/URL/response body mana pun.
//
// Sumber token: env API_MUTATION_TOKEN (server-side, dari .env). Token tidak
// pernah masuk bundle frontend, URL, atau log. Caller browser mengirim header
// `x-api-token` dari sessionStorage yang diisi operator; caller service lokal
// membaca .env langsung.

import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const MUTATION_TOKEN_HEADER = "x-api-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Constant-time string compare; panjang berbeda = false tanpa bocor timing isi. */
export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface MutationAuthDeps {
  /** Nilai token saat ini (dibaca per-request agar rotasi env terbaca). */
  getToken: () => string | undefined;
  /** Path EXACT yang dikecualikan (punya auth sendiri). Default: POST /api/tv/webhook. */
  exemptExact?: { method: string; path: string }[];
}

/**
 * Middleware Express untuk mount di "/api/".
 * req.baseUrl + req.path = path absolut (mis. "/api/positions/open").
 */
export function mutationAuthMiddleware(deps: MutationAuthDeps) {
  const exempt = deps.exemptExact ?? [{ method: "POST", path: "/api/tv/webhook" }];
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const fullPath = req.baseUrl + req.path;
    if (exempt.some((e) => req.method === e.method && fullPath === e.path)) {
      next();
      return;
    }
    const token = deps.getToken();
    if (!token) {
      // BUKAN fail-open: tahan mutasi, biarkan proses hidup (posisi tetap
      // diawasi supervisor in-process; hanya API mutasi yang berhenti).
      res.status(503).json({
        error: "AUTH_NOT_CONFIGURED",
        detail: "API_MUTATION_TOKEN tidak dikonfigurasi; semua mutasi ditolak sampai token diset.",
      });
      return;
    }
    if (!tokenMatches(req.headers[MUTATION_TOKEN_HEADER], token)) {
      res.status(401).json({ error: "x-api-token tidak valid atau hilang" });
      return;
    }
    next();
  };
}
