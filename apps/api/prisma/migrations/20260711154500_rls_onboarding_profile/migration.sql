ALTER TABLE "tenant_onboarding_profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_onboarding_profiles_tenant_select" ON "tenant_onboarding_profiles" FOR SELECT USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_onboarding_profiles_tenant_insert" ON "tenant_onboarding_profiles" FOR INSERT WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_onboarding_profiles_tenant_update" ON "tenant_onboarding_profiles" FOR UPDATE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true))) WITH CHECK ("tenantId" = (SELECT current_setting('app.tenant_id', true)));
CREATE POLICY "tenant_onboarding_profiles_tenant_delete" ON "tenant_onboarding_profiles" FOR DELETE USING ("tenantId" = (SELECT current_setting('app.tenant_id', true)));

