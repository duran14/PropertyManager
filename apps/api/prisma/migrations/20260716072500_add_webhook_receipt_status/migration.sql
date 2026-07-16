ALTER TABLE "webhook_receipts"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'processing',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE POLICY "webhook_receipts_tenant_update"
  ON "webhook_receipts" FOR UPDATE
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
