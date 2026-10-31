// apps/server/src/analysis/dataStatus.ts - Status data kelas-satu.
// 23 Okt 2026 (Tahap 4).
//
// Prinsip: "feed tersambung" != "data segar & lengkap". UI harus bisa
// membedakan: sedang memuat, pemanasan, lengkap, sebagian, basi, terputus,
// tidak didukung. Dan "tidak ada data" BUKAN "data 0".

import { DATA_TTL_MS, type DataStatus, type DataStatusInfo } from "./contracts.js";

export interface FeedHealth {
  /** Kapan data terakhir benar-benar diterima (ms). */
  lastEventAt: number | null;
  /** Kapan koneksi terakhir dibuka. */
  lastConnectAt: number | null;
  /** Kapan koneksi terakhir putus. */
  lastDisconnectAt: number | null;
  /** Feed memang didukung/tidak oleh build ini. */
  supported: boolean;
  /** Sumber yang gagal (network/auth/parse). */
  errors: string[];
  /** Reconnect sejak start. */
  reconnects: number;
  /** Sumber lain yang juga boleh menutupi gap feed ini (mis. REST). */
  fallbackPresent: boolean;
}

export function emptyHealth(supported = true): FeedHealth {
  return {
    lastEventAt: null,
    lastConnectAt: null,
    lastDisconnectAt: null,
    supported,
    errors: [],
    reconnects: 0,
    fallbackPresent: false,
  };
}

export type TtlKind = keyof typeof DATA_TTL_MS;

/**
 * Tentukan status satu feed berdasarkan kesehatan + TTL.
 * Rules:
 *  - tidak didukung -> UNSUPPORTED
 *  - belum pernah ada event & masih koneksi baru -> LOADING
 *  - koneksi putus & tidak ada fallback -> DISCONNECTED
 *  - ada event tapi umur > TTL -> STALE
 *  - ada error sementara tapi data masih dalam TTL -> PARTIAL
 *  - semua baik -> COMPLETE
 */
export function computeStatus(health: FeedHealth, ttlKind: TtlKind, nowMs: number): DataStatusInfo {
  const ttlMs = DATA_TTL_MS[ttlKind];
  if (!health.supported) {
    return { status: "UNSUPPORTED", ageMs: null, ttlMs, missing: [], present: [], reason: "Feed tidak didukung pada build ini." };
  }
  if (health.lastEventAt === null) {
    if (health.lastDisconnectAt !== null && !health.fallbackPresent) {
      return {
        status: "DISCONNECTED", ageMs: null, ttlMs,
        missing: ["feed"], present: [], reason: "Koneksi feed terputus dan belum ada data.",
      };
    }
    return {
      status: "LOADING", ageMs: null, ttlMs,
      missing: ["feed"], present: [], reason: "Menunggu data pertama.",
    };
  }
  const ageMs = Math.max(0, nowMs - health.lastEventAt);
  if (ageMs > ttlMs) {
    const disconnected = health.lastDisconnectAt !== null && health.lastDisconnectAt > health.lastEventAt;
    return {
      status: disconnected && !health.fallbackPresent ? "DISCONNECTED" : "STALE",
      ageMs, ttlMs,
      missing: disconnected ? ["feed"] : [],
      present: [],
      reason: disconnected
        ? "Koneksi feed terputus; data terakhir sudah basi."
        : `Data terakhir ${Math.round(ageMs / 1000)} dtk lalu (batas ${Math.round(ttlMs / 1000)} dtk).`,
    };
  }
  if (health.errors.length > 0) {
    return {
      status: "PARTIAL", ageMs, ttlMs,
      missing: health.errors.slice(0, 5), present: [],
      reason: `Sebagian sumber bermasalah: ${health.errors.slice(0, 2).join(", ")}`,
    };
  }
  return { status: "COMPLETE", ageMs, ttlMs, missing: [], present: [], reason: null };
}

/**
 * Cakupan: hanya boleh 100% bila denominator diketahui.
 * Kalau total tidak diketahui -> present/total null, bukan 100%.
 */
export function computeCoverage(present: number, total: number | null): { present: number; total: number } {
  if (total === null || !Number.isFinite(total) || total <= 0) return { present: 0, total: 0 };
  return { present: Math.max(0, Math.min(present, total)), total };
}
