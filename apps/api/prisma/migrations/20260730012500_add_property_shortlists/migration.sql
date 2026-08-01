CREATE TABLE "property_shortlists" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "unitIds" TEXT[],
  "selectedUnitId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'awaiting_preference',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "viewedAt" TIMESTAMP(3),
  "scheduledAt" TIMESTAMP(3),
  "reminderCount" INTEGER NOT NULL DEFAULT 0,
  "nextReminderAt" TIMESTAMP(3),
  "lastReminderAt" TIMESTAMP(3),
  "remindersStopped" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "property_shortlists_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_shortlists_tokenHash_key" ON "property_shortlists"("tokenHash");
CREATE INDEX "property_shortlists_tenantId_conversationId_idx" ON "property_shortlists"("tenantId", "conversationId");
CREATE INDEX "property_shortlists_status_nextReminderAt_idx" ON "property_shortlists"("status", "nextReminderAt");
ALTER TABLE "property_shortlists" ADD CONSTRAINT "property_shortlists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_shortlists" ADD CONSTRAINT "property_shortlists_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
