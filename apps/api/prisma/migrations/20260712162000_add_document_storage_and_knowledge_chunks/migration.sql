-- Durable document object references and searchable knowledge chunks.

ALTER TABLE "knowledge_documents"
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "extractionStatus" TEXT NOT NULL DEFAULT 'pending';

CREATE TABLE "knowledge_chunks" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "knowledge_chunks_tenantId_sourceType_sourceId_idx"
  ON "knowledge_chunks"("tenantId", "sourceType", "sourceId");

CREATE INDEX "knowledge_chunks_tenantId_title_idx"
  ON "knowledge_chunks"("tenantId", "title");

ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_knowledge_chunks ON "knowledge_chunks"
  USING ("tenantId" = current_setting('app.tenant_id', true));
