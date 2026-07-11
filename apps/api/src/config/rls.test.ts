import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
const migration = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readFileSync(join(migrationsDir, entry.name, 'migration.sql'), 'utf8'))
  .join('\n');

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
  'tenant_onboarding_profiles',
];

const childTablesScopedByConversation = ['conversation_slots', 'chat_messages'];

describe('RLS tenant isolation migration', () => {
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
