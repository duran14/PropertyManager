ALTER TABLE "webhook_receipts"
  ADD COLUMN "claimToken" TEXT;

UPDATE "webhook_receipts"
  SET "claimToken" = "id"
  WHERE "claimToken" IS NULL;

ALTER TABLE "webhook_receipts"
  ALTER COLUMN "claimToken" SET NOT NULL;
