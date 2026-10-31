-- ResearchFinding: jurnal temuan riset Big Brain (verdict + keputusan operator)
CREATE TABLE "ResearchFinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "experimentType" TEXT NOT NULL,
    "runRefs" TEXT NOT NULL DEFAULT '[]',
    "metrics" TEXT NOT NULL DEFAULT '{}',
    "verdict" TEXT NOT NULL,
    "conclusion" TEXT NOT NULL DEFAULT '',
    "operatorDecision" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ResearchFinding_verdict_createdAt_idx" ON "ResearchFinding"("verdict", "createdAt");
CREATE INDEX "ResearchFinding_operatorDecision_idx" ON "ResearchFinding"("operatorDecision");
