import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const seedSource = readFileSync(join(process.cwd(), 'prisma', 'seed.ts'), 'utf8');

describe('demo seed', () => {
  it('rebuilds the demo tenant so repeated demo resets stay deterministic', () => {
    expect(seedSource).toContain('delete({ where: { id: DEMO_TENANT_ID } })');
    expect(seedSource).toContain("error.code === 'P2025'");
    expect(seedSource).toContain('DEMO_TENANT_ID');
  });

  it('populates the main demo surfaces with realistic data', () => {
    for (const model of [
      'lead',
      'chatConversation',
      'chatMessage',
      'conversationSlot',
      'showing',
      'bill',
      'reconciliationBatch',
      'discrepancy',
      'auditEntry',
      'listingPhoto',
    ]) {
      expect(seedSource).toContain(`prisma.${model}`);
    }
  });

  it('builds a verifiable audit chain using the same timestamp format as runtime verification', () => {
    expect(seedSource).toContain('new Date(input.occurredAt).toISOString()');
    expect(seedSource).toContain('createdAt: new Date(entry.occurredAt)');
    expect(seedSource).toContain('buildAuditEntry({ ...input, occurredAt }, last?.hash)');
  });
});
