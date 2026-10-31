// apps/server/src/exec/accountManager.ts
// MANAJEMEN MULTI-AKUN BINANCE FUTURES
// Keamanan: API Key/Secret hanya dibaca dari env vars saat startup.
// Tidak pernah di-log, tidak pernah dikembalikan sebagai string plaintext via getter publik.

import { BinanceUsdMClient } from "./binanceUsdMClient.js";
import { env } from "../core/env.js";
import { logger } from "../core/logger.js";

export interface AccountConfig {
  id: string; // Label internal, misal "MAIN", "SUB_1"
  apiKey: string;
  apiSecret: string;
}

/**
 * Manages multiple Binance Futures accounts.
 * Initializes clients lazily or eagerly depending on configuration.
 */
export class BinanceAccountManager {
  private readonly configs: Map<string, AccountConfig> = new Map();
  private readonly clients: Map<string, BinanceUsdMClient> = new Map();
  private readonly routingStrategy: "ROUND_ROBIN" | "PRIMARY_ONLY";
  private roundRobinIndex = 0;

  constructor() {
    // Parse environment variables for up to 5 accounts (extensible)
    this.loadAccountFromEnv(1);
    this.loadAccountFromEnv(2);
    
    this.routingStrategy = (process.env.BINANCE_ROUTING_STRATEGY as any) || "ROUND_ROBIN";
    
    if (this.configs.size === 0) {
      throw new Error("NO_BINANCE_ACCOUNTS_CONFIGURED: Set BINANCE_API_KEY_1 and BINANCE_SECRET_KEY_1 in .env");
    }
    
    logger.info({ count: this.configs.size }, "BinanceAccountManager initialized with %d account(s)", this.configs.size);
  }

  private loadAccountFromEnv(index: number): void {
    const idKey = `BINANCE_ACCOUNT_ID_${index}`;
    const keyKey = `BINANCE_API_KEY_${index}`;
    const secretKey = `BINANCE_SECRET_KEY_${index}`;

    // Fallback to single-account vars for backward compatibility if index 1
    let apiKey = process.env[keyKey];
    let apiSecret = process.env[secretKey];
    let accountId = process.env[idKey];

    if (!apiKey && index === 1) {
      apiKey = env.BINANCE_API_KEY;
      apiSecret = env.BINANCE_API_SECRET;
      accountId = accountId || "MAIN";
    }

    if (apiKey && apiSecret) {
      const label = accountId || `ACC_${index}`;
      this.configs.set(label, { id: label, apiKey, apiSecret });
      
      // Pre-initialize client to fail fast on bad keys
      try {
        const client = new BinanceUsdMClient({ apiKey, apiSecret });
        this.clients.set(label, client);
      } catch (err) {
        logger.error({ err, accountId: label }, "Failed to initialize Binance client for account");
        throw err;
      }
    }
  }

  /**
   * Returns a configured BinanceUsdMClient instance for the given account ID.
   * If accountId is null/undefined, uses routing strategy.
   */
  getClient(accountId?: string): BinanceUsdMClient {
    if (accountId && this.clients.has(accountId)) {
      return this.clients.get(accountId)!;
    }

    // Routing logic
    const availableIds = Array.from(this.clients.keys());
    if (availableIds.length === 0) throw new Error("NO_AVAILABLE_CLIENTS");

    if (this.routingStrategy === "PRIMARY_ONLY") {
      return this.clients.get(availableIds[0])!;
    }

    // ROUND_ROBIN
    const selectedId = availableIds[this.roundRobinIndex % availableIds.length];
    this.roundRobinIndex++;
    return this.clients.get(selectedId)!;
  }

  /**
   * Gets the next available account ID based on routing strategy.
   * Used when opening a NEW position to determine which wallet holds it.
   */
  getNextAccountId(): string {
    const availableIds = Array.from(this.configs.keys());
    if (availableIds.length === 0) throw new Error("NO_ACCOUNTS_AVAILABLE");

    if (this.routingStrategy === "PRIMARY_ONLY") {
      return availableIds[0];
    }

    const selectedId = availableIds[this.roundRobinIndex % availableIds.length];
    this.roundRobinIndex++;
    return selectedId;
  }

  getAllAccountIds(): string[] {
    return Array.from(this.configs.keys());
  }
}

export const accountManager = new BinanceAccountManager();