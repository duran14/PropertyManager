-- Document intake and lead workflow state.

ALTER TABLE "leads"
  ADD COLUMN "operationalStatus" TEXT DEFAULT 'needs_review',
  ADD COLUMN "assignedUserId" TEXT;

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_assignedUserId_fkey"
  FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "leads_tenantId_operationalStatus_idx" ON "leads"("tenantId", "operationalStatus");
CREATE INDEX "leads_tenantId_assignedUserId_idx" ON "leads"("tenantId", "assignedUserId");

CREATE TABLE "knowledge_documents" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "entityType" TEXT NOT NULL DEFAULT 'tenant',
  "entityId" TEXT,
  "description" TEXT,
  "textContent" TEXT,
  "storageUrl" TEXT,
  "fileBase64" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "knowledge_documents_tenantId_category_idx" ON "knowledge_documents"("tenantId", "category");
CREATE INDEX "knowledge_documents_tenantId_entityType_entityId_idx" ON "knowledge_documents"("tenantId", "entityType", "entityId");

ALTER TABLE "knowledge_documents" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_knowledge_documents ON "knowledge_documents"
  USING ("tenantId" = current_setting('app.tenant_id', true));
