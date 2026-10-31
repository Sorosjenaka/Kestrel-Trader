-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Symbol" (
    "symbol" TEXT NOT NULL PRIMARY KEY,
    "baseAsset" TEXT NOT NULL,
    "quoteAsset" TEXT NOT NULL DEFAULT 'USDT',
    "contractType" TEXT NOT NULL DEFAULT 'PERPETUAL',
    "underlyingType" TEXT NOT NULL DEFAULT 'COIN',
    "status" TEXT NOT NULL DEFAULT 'TRADING',
    "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "volume24hUsd" REAL NOT NULL DEFAULT 0,
    "minNotional" REAL NOT NULL DEFAULT 5,
    "tickSize" REAL NOT NULL DEFAULT 0.01,
    "stepSize" REAL NOT NULL DEFAULT 0.001,
    "maxLeverage" INTEGER,
    "maxLeverageUpdatedAt" DATETIME,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "eligibleReason" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "EventLog_type_createdAt_idx" ON "EventLog"("type", "createdAt");
