-- Row-Level Security: tenant isolation at the database boundary.
--
-- Policies read the tenant from a transaction/session setting:
--   SELECT set_config('app.tenant_id', '<tenant-id>', true);
--
-- Prisma migrations run as the table owner, which bypasses RLS unless FORCE RLS
-- is enabled. Production should use a non-owner application role so these
-- policies become the database backstop behind app-level tenant filters.

-- Tenant root table.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenants_tenant_select" ON "tenants"
  FOR SELECT USING ("id" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenants_tenant_insert" ON "tenants"
  FOR INSERT WITH CHECK ("id" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenants_tenant_update" ON "tenants"
  FOR UPDATE USING ("id" = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK ("id" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenants_tenant_delete" ON "tenants"
  FOR DELETE USING ("id" = (SELECT current_setting('app.tenant_id', true)));

-- Direct tenant-scoped tables.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_tenant_select" ON "users" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "users_tenant_insert" ON "users" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "users_tenant_update" ON "users" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "users_tenant_delete" ON "users" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "properties" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "properties_tenant_select" ON "properties" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "properties_tenant_insert" ON "properties" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "properties_tenant_update" ON "properties" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "properties_tenant_delete" ON "properties" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "units" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "units_tenant_select" ON "units" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "units_tenant_insert" ON "units" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "units_tenant_update" ON "units" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "units_tenant_delete" ON "units" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "leases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leases_tenant_select" ON "leases" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leases_tenant_insert" ON "leases" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leases_tenant_update" ON "leases" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leases_tenant_delete" ON "leases" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "tenant_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_records_tenant_select" ON "tenant_records" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_records_tenant_insert" ON "tenant_records" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_records_tenant_update" ON "tenant_records" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_records_tenant_delete" ON "tenant_records" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners_tenant_select" ON "owners" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "owners_tenant_insert" ON "owners" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "owners_tenant_update" ON "owners" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "owners_tenant_delete" ON "owners" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "transactions_tenant_select" ON "transactions" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "transactions_tenant_insert" ON "transactions" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "transactions_tenant_update" ON "transactions" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "transactions_tenant_delete" ON "transactions" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bills_tenant_select" ON "bills" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "bills_tenant_insert" ON "bills" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "bills_tenant_update" ON "bills" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "bills_tenant_delete" ON "bills" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "reconciliation_batches" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "reconciliation_batches_tenant_select" ON "reconciliation_batches" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "reconciliation_batches_tenant_insert" ON "reconciliation_batches" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "reconciliation_batches_tenant_update" ON "reconciliation_batches" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "reconciliation_batches_tenant_delete" ON "reconciliation_batches" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "discrepancies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "discrepancies_tenant_select" ON "discrepancies" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "discrepancies_tenant_insert" ON "discrepancies" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "discrepancies_tenant_update" ON "discrepancies" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "discrepancies_tenant_delete" ON "discrepancies" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_requests_tenant_select" ON "approval_requests" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "approval_requests_tenant_insert" ON "approval_requests" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "approval_requests_tenant_update" ON "approval_requests" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "approval_requests_tenant_delete" ON "approval_requests" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "audit_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_entries_tenant_select" ON "audit_entries" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "audit_entries_tenant_insert" ON "audit_entries" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "integration_configs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_configs_tenant_select" ON "integration_configs" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "integration_configs_tenant_insert" ON "integration_configs" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "integration_configs_tenant_update" ON "integration_configs" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "integration_configs_tenant_delete" ON "integration_configs" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leads_tenant_select" ON "leads" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leads_tenant_insert" ON "leads" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leads_tenant_update" ON "leads" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "leads_tenant_delete" ON "leads" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "chat_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_conversations_tenant_select" ON "chat_conversations" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "chat_conversations_tenant_insert" ON "chat_conversations" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "chat_conversations_tenant_update" ON "chat_conversations" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "chat_conversations_tenant_delete" ON "chat_conversations" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "showings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "showings_tenant_select" ON "showings" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "showings_tenant_insert" ON "showings" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "showings_tenant_update" ON "showings" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "showings_tenant_delete" ON "showings" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

ALTER TABLE "listing_photos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "listing_photos_tenant_select" ON "listing_photos" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "listing_photos_tenant_insert" ON "listing_photos" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "listing_photos_tenant_update" ON "listing_photos" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "listing_photos_tenant_delete" ON "listing_photos" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

-- Child tables scoped by their parent chat conversation.
ALTER TABLE "conversation_slots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conversation_slots_tenant_select" ON "conversation_slots"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "conversation_slots"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "conversation_slots_tenant_insert" ON "conversation_slots"
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "conversation_slots"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "conversation_slots_tenant_update" ON "conversation_slots"
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "conversation_slots"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "conversation_slots"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "conversation_slots_tenant_delete" ON "conversation_slots"
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "conversation_slots"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );

ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat_messages_tenant_select" ON "chat_messages"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "chat_messages"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "chat_messages_tenant_insert" ON "chat_messages"
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "chat_messages"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "chat_messages_tenant_update" ON "chat_messages"
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "chat_messages"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "chat_messages"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
CREATE POLICY "chat_messages_tenant_delete" ON "chat_messages"
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM "chat_conversations"
      WHERE "chat_conversations"."id" = "chat_messages"."conversationId"
        AND "chat_conversations"."tenantId" = (SELECT current_setting('app.tenant_id', true))
    )
  );
