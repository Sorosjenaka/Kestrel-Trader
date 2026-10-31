// 25 Okt 2026 (FASE 1 auth, perintah operator) — regression test middleware
// mutasi: tanpa/salah token DITOLAK, token benar LOLOS, token kosong TIDAK
// fail-open (503), loopback TIDAK bypass, GET/health tetap terbuka,
// TV webhook EXACT tetap lolos (auth sendiri), token tidak bocor di response.
import { describe, expect, it } from "vitest";
import { mutationAuthMiddleware, tokenMatches } from "../src/api/authMutations.js";
import type { NextFunction, Request, Response } from "express";

function fakeReq(method: string, path: string, headers: Record<string, string | string[] | undefined> = {}, baseUrl = "/api") {
  return { method, path, baseUrl, headers } as unknown as Request;
}
function fakeRes() {
  const r: { status?: number; body?: unknown; ended: boolean } = { ended: false };
  return {
    ...r,
    status(code: number) { (r as any).status = code; return this; },
    json(body: unknown) { (r as any).body = body; (r as any).ended = true; return this; },
    get state() { return r; },
  } as unknown as Response & { state: typeof r };
}
function run(mw: ReturnType<typeof mutationAuthMiddleware>, req: Request): { passed: boolean; status?: number; body?: unknown } {
  const res = fakeRes() as any;
  let passed = false;
  mw(req, res, (() => { passed = true; }) as NextFunction);
  return { passed, status: res.state?.status, body: res.state?.body };
}

const TOKEN = "rahasia-uji-123";
const mw = mutationAuthMiddleware({ getToken: () => TOKEN });

describe("mutationAuthMiddleware", () => {
  it("GET/HEAD/OPTIONS selalu lolos (health & read-only tetap aman)", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(run(mw, fakeReq(m, "/health")).passed).toBe(true);
    }
  });

  it("POST tanpa token -> 401 (tidak lolos)", () => {
    const r = run(mw, fakeReq("POST", "/positions/open"));
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("POST dengan token salah -> 401", () => {
    const r = run(mw, fakeReq("POST", "/positions/open", { "x-api-token": "salah" }));
    expect(r.passed).toBe(false);
    expect(r.status).toBe(401);
  });

  it("token kosong di server -> 503 AUTH_NOT_CONFIGURED (BUKAN fail-open)", () => {
    const mwOff = mutationAuthMiddleware({ getToken: () => undefined });
    const r = run(mwOff, fakeReq("POST", "/positions/open", { "x-api-token": "apa-saja" }));
    expect(r.passed).toBe(false);
    expect(r.status).toBe(503);
    expect((r.body as any)?.error).toBe("AUTH_NOT_CONFIGURED");
  });

  it("loopback TIDAK lagi bypass: header x-forwarded/remoteAddr diabaikan, token tetap wajib", () => {
    const req = fakeReq("POST", "/positions/open", { "x-forwarded-for": "127.0.0.1" });
    expect(run(mw, req).passed).toBe(false);
  });

  it("token benar -> lolos", () => {
    const r = run(mw, fakeReq("POST", "/positions/open", { "x-api-token": TOKEN }));
    expect(r.passed).toBe(true);
  });

  it("POST /api/tv/webhook EXACT tetap dikecualikan (punya auth sendiri)", () => {
    expect(run(mw, fakeReq("POST", "/tv/webhook")).passed).toBe(true);
    // prefix tidak ikut kecualikan
    expect(run(mw, fakeReq("POST", "/tv/webhook/extra")).passed).toBe(false);
  });

  it("respons error tidak memuat isi token", () => {
    const r = run(mw, fakeReq("POST", "/x", { "x-api-token": TOKEN + "x" }));
    expect(JSON.stringify(r.body ?? {})).not.toContain(TOKEN);
  });
});

describe("tokenMatches", () => {
  it("cocok hanya untuk string identik; non-string/kosong selalu false", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("abc", "abcd")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
    expect(tokenMatches(["abc"], "abc")).toBe(false);
  });
});
