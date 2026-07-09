import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20260709145000_enable_rls_tenant_isolation',
  'migration.sql',
);

const tenantScopedTables = [
  'tenants',
  'users',
  'properties',
  'units',
  'leases',
  'tenant_records',
  'owners',
  'transactions',
  'bills',
  'reconciliation_batches',
  'discrepancies',
  'approval_requests',
  'audit_entries',
  'integration_configs',
  'leads',
  'chat_conversations',
  'showings',
  'listing_photos',
];

const childTablesScopedByConversation = ['conversation_slots', 'chat_messages'];

describe('RLS tenant isolation migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('enables RLS for every tenant-scoped business table', () => {
    for (const table of tenantScopedTables) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`CREATE POLICY "${table}_tenant_select"`);
      expect(migration).toContain(`CREATE POLICY "${table}_tenant_insert"`);
    }
  });

  it('scopes conversation child tables through their parent conversation tenant', () => {
    for (const table of childTablesScopedByConversation) {
      expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`CREATE POLICY "${table}_tenant_select"`);
      expect(migration).toContain(`"chat_conversations"`);
    }
  });

  it('keeps audit entries append-only for non-owner database roles', () => {
    expect(migration).not.toContain('CREATE POLICY "audit_entries_tenant_update"');
    expect(migration).not.toContain('CREATE POLICY "audit_entries_tenant_delete"');
  });
});
