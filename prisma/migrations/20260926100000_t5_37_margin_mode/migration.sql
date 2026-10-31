-- T-5.37: Position.marginMode — semua trade wajib tercatat CROSS (perintah operator).
-- Idempoten via tools/apply-migration.mjs.
ALTER TABLE "Position" ADD COLUMN "marginMode" TEXT NOT NULL DEFAULT 'CROSS';
UPDATE "Position" SET "marginMode" = 'CROSS' WHERE "marginMode" IS NULL OR "marginMode" = '' OR "marginMode" <> 'CROSS';
