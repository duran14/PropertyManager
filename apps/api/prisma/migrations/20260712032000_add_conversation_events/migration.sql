CREATE TABLE "conversation_events" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "leadId" TEXT,
  "actorUserId" TEXT,
  "type" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "tone" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_events_tenantId_conversationId_createdAt_idx"
  ON "conversation_events"("tenantId", "conversationId", "createdAt");

CREATE INDEX "conversation_events_tenantId_leadId_createdAt_idx"
  ON "conversation_events"("tenantId", "leadId", "createdAt");

ALTER TABLE "conversation_events"
  ADD CONSTRAINT "conversation_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_events"
  ADD CONSTRAINT "conversation_events_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_events"
  ADD CONSTRAINT "conversation_events_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversation_events"
  ADD CONSTRAINT "conversation_events_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversation_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_events_tenant_select"
  ON "conversation_events"
  FOR SELECT
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY "conversation_events_tenant_insert"
  ON "conversation_events"
  FOR INSERT
  WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY "conversation_events_tenant_update"
  ON "conversation_events"
  FOR UPDATE
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY "conversation_events_tenant_delete"
  ON "conversation_events"
  FOR DELETE
  USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
