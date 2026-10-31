// ArtaTrade AI - logger terstruktur (NFR-08, NFR-12).
// Field rahasia selalu diredaksi menjadi [REDACTED] - tidak pernah tampil.
import pino from "pino";
import { env } from "./env.js";

export const REDACTED_PATHS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "XKIRO_API_KEY",
  "TV_WEBHOOK_SECRET",
  "*.apiKey",
  "*.apiSecret",
  "*.secret",
  "*.token",
  "req.headers.authorization",
];

export const logger = pino({
  // Test yang mem-mock env tanpa LOG_LEVEL tidak boleh membuat import gagal.
  level: env.LOG_LEVEL ?? "info",
  redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
});

export const REDACTED = "[REDACTED]";
