-- Normalize legacy textual timestamps to the integer milliseconds written by Prisma.

-- Applies only when an operator deploys migrations. Never run against business data implicitly.


UPDATE "Setting" SET "updatedAt" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "updatedAt"), 4, 3) AS INTEGER)
WHERE typeof("updatedAt") = 'text' AND strftime('%s', "updatedAt") IS NOT NULL;

UPDATE "EventLog" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "Symbol" SET "maxLeverageUpdatedAt" = CAST(strftime('%s', "maxLeverageUpdatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "maxLeverageUpdatedAt"), 4, 3) AS INTEGER)
WHERE typeof("maxLeverageUpdatedAt") = 'text' AND strftime('%s', "maxLeverageUpdatedAt") IS NOT NULL;

UPDATE "Symbol" SET "updatedAt" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "updatedAt"), 4, 3) AS INTEGER)
WHERE typeof("updatedAt") = 'text' AND strftime('%s', "updatedAt") IS NOT NULL;

UPDATE "LeverageHistory" SET "observedAt" = CAST(strftime('%s', "observedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "observedAt"), 4, 3) AS INTEGER)
WHERE typeof("observedAt") = 'text' AND strftime('%s', "observedAt") IS NOT NULL;

UPDATE "LeverageHistory" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "SetupCandidate" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "BacktestRun" SET "fromDate" = CAST(strftime('%s', "fromDate") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "fromDate"), 4, 3) AS INTEGER)
WHERE typeof("fromDate") = 'text' AND strftime('%s', "fromDate") IS NOT NULL;

UPDATE "BacktestRun" SET "toDate" = CAST(strftime('%s', "toDate") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "toDate"), 4, 3) AS INTEGER)
WHERE typeof("toDate") = 'text' AND strftime('%s', "toDate") IS NOT NULL;

UPDATE "BacktestRun" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "BacktestTrade" SET "entryAt" = CAST(strftime('%s', "entryAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "entryAt"), 4, 3) AS INTEGER)
WHERE typeof("entryAt") = 'text' AND strftime('%s', "entryAt") IS NOT NULL;

UPDATE "BacktestTrade" SET "exitAt" = CAST(strftime('%s', "exitAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "exitAt"), 4, 3) AS INTEGER)
WHERE typeof("exitAt") = 'text' AND strftime('%s', "exitAt") IS NOT NULL;

UPDATE "BacktestTrade" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "Position" SET "tp1FilledAt" = CAST(strftime('%s', "tp1FilledAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "tp1FilledAt"), 4, 3) AS INTEGER)
WHERE typeof("tp1FilledAt") = 'text' AND strftime('%s', "tp1FilledAt") IS NOT NULL;

UPDATE "Position" SET "tp2FilledAt" = CAST(strftime('%s', "tp2FilledAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "tp2FilledAt"), 4, 3) AS INTEGER)
WHERE typeof("tp2FilledAt") = 'text' AND strftime('%s', "tp2FilledAt") IS NOT NULL;

UPDATE "Position" SET "openedAt" = CAST(strftime('%s', "openedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "openedAt"), 4, 3) AS INTEGER)
WHERE typeof("openedAt") = 'text' AND strftime('%s', "openedAt") IS NOT NULL;

UPDATE "Position" SET "closedAt" = CAST(strftime('%s', "closedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "closedAt"), 4, 3) AS INTEGER)
WHERE typeof("closedAt") = 'text' AND strftime('%s', "closedAt") IS NOT NULL;

UPDATE "OrderExec" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "OrderExec" SET "filledAt" = CAST(strftime('%s', "filledAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "filledAt"), 4, 3) AS INTEGER)
WHERE typeof("filledAt") = 'text' AND strftime('%s', "filledAt") IS NOT NULL;

UPDATE "Trade" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "LearningEntry" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "PlaybookRule" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "PlaybookRule" SET "updatedAt" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "updatedAt"), 4, 3) AS INTEGER)
WHERE typeof("updatedAt") = 'text' AND strftime('%s', "updatedAt") IS NOT NULL;

UPDATE "ParameterVersion" SET "activatedAt" = CAST(strftime('%s', "activatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "activatedAt"), 4, 3) AS INTEGER)
WHERE typeof("activatedAt") = 'text' AND strftime('%s', "activatedAt") IS NOT NULL;

UPDATE "ParameterVersion" SET "rollbackAt" = CAST(strftime('%s', "rollbackAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "rollbackAt"), 4, 3) AS INTEGER)
WHERE typeof("rollbackAt") = 'text' AND strftime('%s', "rollbackAt") IS NOT NULL;

UPDATE "ParameterVersion" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "DecisionLog" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "SwingSignalLog" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "ResearchFinding" SET "decidedAt" = CAST(strftime('%s', "decidedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "decidedAt"), 4, 3) AS INTEGER)
WHERE typeof("decidedAt") = 'text' AND strftime('%s', "decidedAt") IS NOT NULL;

UPDATE "ResearchFinding" SET "createdAt" = CAST(strftime('%s', "createdAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "createdAt"), 4, 3) AS INTEGER)
WHERE typeof("createdAt") = 'text' AND strftime('%s', "createdAt") IS NOT NULL;

UPDATE "ResearchFinding" SET "updatedAt" = CAST(strftime('%s', "updatedAt") AS INTEGER) * 1000 + CAST(substr(strftime('%f', "updatedAt"), 4, 3) AS INTEGER)
WHERE typeof("updatedAt") = 'text' AND strftime('%s', "updatedAt") IS NOT NULL;

CREATE INDEX IF NOT EXISTS "EventLog_createdAt_idx" ON "EventLog"("createdAt");
