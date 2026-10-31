// apps/server/src/tv/tvBridge.ts - Webhook Receiver TV + Pine Helper Generator (FR-36, FR-38).
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../core/env.js";
import { db } from "../core/db.js";
import { logger } from "../core/logger.js";

export interface PineGeneratorOptions {
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  title?: string;
}

export interface TvWebhookPayload {
  token?: string;
  secret?: string;
  symbol: string;
  // 30 Sep 2026: TP2/BE dihapus dari sistem; TP1 = single target 100%.
  action: "ENTRY" | "TP1" | "SL" | "ALERT";
  price: number;
  message?: string;
  timestamp?: number;
}

export function generatePineScript(options: PineGeneratorOptions): string {
  const { symbol, side, entryPrice, slPrice, tp1Price, title } = options;
  const scriptTitle = title ?? `Private Trade AI 4-Level Overlay [${symbol}]`;

  return `//@version=5
indicator("${scriptTitle}", overlay=true)

// Private Trade AI - Generator Pine Script 4-Level (FR-38 / US-08)
// Simbol: ${symbol} | Arah: ${side}

// Parameter Level
entryPrice = input.float(${entryPrice.toFixed(4)}, title="Entry Price", group="Level Private Trade")
slPrice    = input.float(${slPrice.toFixed(4)}, title="Stop Loss (SL)", group="Level Private Trade")
tp1Price   = input.float(${tp1Price.toFixed(4)}, title="Take Profit (single target, RR klasik)", group="Level Private Trade")

// Garis Visual Level
plot(entryPrice, title="ENTRY", color=color.blue, linewidth=2, style=plot.style_line)
plot(slPrice,    title="SL",    color=color.red,  linewidth=2, style=plot.style_linebr)
plot(tp1Price,   title="TP1",   color=color.green,linewidth=2, style=plot.style_linebr)

// Label Penanda Level
var label l_entry = na
var label l_sl    = na
var label l_tp1   = na

if barstate.islast
    label.delete(l_entry)
    label.delete(l_sl)
    label.delete(l_tp1)
    l_entry := label.new(bar_index + 2, entryPrice, "ENTRY " + str.tostring(entryPrice), color=color.blue, textcolor=color.white, style=label.style_label_left, size=size.small)
    l_sl    := label.new(bar_index + 2, slPrice,    "SL "    + str.tostring(slPrice),    color=color.red,  textcolor=color.white, style=label.style_label_left, size=size.small)
    l_tp1   := label.new(bar_index + 2, tp1Price,   "TP1 "   + str.tostring(tp1Price),   color=color.green,textcolor=color.white, style=label.style_label_left, size=size.small)

// Kondisi Alert TradingView (Webhook Receiver FR-36)
isLong = "${side}" == "LONG"
hitTp1 = isLong ? ta.crossover(high, tp1Price) : ta.crossunder(low, tp1Price)
hitSl  = isLong ? ta.crossunder(low, slPrice)  : ta.crossover(high, slPrice)

alertcondition(hitTp1, title="TP1 Hit", message='{"symbol":"${symbol}","action":"TP1","price":' + str.tostring(close) + '}')
alertcondition(hitSl,  title="SL Hit",  message='{"symbol":"${symbol}","action":"SL","price":' + str.tostring(close) + '}')
`;
}

// 21 Okt 2026 (fail-closed): fallback statis "artatrade_webhook_secret" DIHAPUS.
// Default itu ada di repo (public/predictable) sehingga siapa pun bisa meniru
// webhook saat TV_WEBHOOK_SECRET tidak dikonfigurasi. Tanpa secret yang
// dikonfigurasi -> webhook SELALU ditolak.
const WEBHOOK_REJECTED_MESSAGE = "Token webhook TradingView tidak valid (autentikasi ditolak)";

// Bandingkan secret secara constant-time (hash kedua sisi + timingSafeEqual,
// aman untuk panjang berbeda) supaya isinya tidak bocor lewat selisih waktu.
function secretEquals(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

// Peringatan sekali per proses kalau secret server belum dikonfigurasi.
// Hanya NAMA variabel yang dicatat - nilai secret/token tidak pernah di-log.
let warnedMissingSecret = false;

export async function processTradingViewWebhook(
  payload: TvWebhookPayload,
  providedToken?: string
): Promise<{ success: boolean; latencyMs: number; message: string }> {
  const startMs = Date.now();
  const configuredSecret = (env.TV_WEBHOOK_SECRET ?? "").trim();

  const token = providedToken || payload.token || payload.secret;

  // Fail-closed: tanpa secret yang dikonfigurasi TIDAK ada token yang boleh
  // meniru webhook. Pesan penolakan SAMA dengan kasus token salah supaya status
  // konfigurasi server tidak bocor ke pemanggil.
  if (!configuredSecret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn("TV_WEBHOOK_SECRET tidak dikonfigurasi - webhook TradingView ditolak (fail-closed)");
    }
    return {
      success: false,
      latencyMs: Date.now() - startMs,
      message: WEBHOOK_REJECTED_MESSAGE,
    };
  }

  if (!token || !secretEquals(token, configuredSecret)) {
    return {
      success: false,
      latencyMs: Date.now() - startMs,
      message: WEBHOOK_REJECTED_MESSAGE,
    };
  }

  // FR-36: Webhook TradingView disimpan untuk audit & reconcile (BUKAN pemicu order live)
  await db.eventLog.create({
    data: {
      type: "TV_WEBHOOK_RECEIVED",
      severity: "info",
      payload: JSON.stringify({
        symbol: payload.symbol,
        action: payload.action,
        price: payload.price,
        message: payload.message ?? "",
        receivedAt: new Date().toISOString(),
      }),
    },
  });

  const latencyMs = Date.now() - startMs;

  return {
    success: true,
    latencyMs,
    message: `Webhook ${payload.action} ${payload.symbol} berhasil disimpan untuk rekonsiliasi (${latencyMs}ms)`,
  };
}
