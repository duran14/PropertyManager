CREATE TABLE "webhook_receipts" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_receipts_tenantId_provider_providerMessageId_key"
  ON "webhook_receipts"("tenantId", "provider", "providerMessageId");

CREATE INDEX "webhook_receipts_tenantId_createdAt_idx"
  ON "webhook_receipts"("tenantId", "createdAt");

ALTER TABLE "webhook_receipts"
  ADD CONSTRAINT "webhook_receipts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "webhook_receipts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_receipts_tenant_select"
  ON "webhook_receipts" FOR SELECT
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY "webhook_receipts_tenant_insert"
  ON "webhook_receipts" FOR INSERT
  WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY "webhook_receipts_tenant_delete"
  ON "webhook_receipts" FOR DELETE
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
