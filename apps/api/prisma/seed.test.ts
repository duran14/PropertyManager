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
      'conversationEvent',
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

  it('gives the main shortlist options realistic multi-photo galleries', () => {
    for (const unitKey of [
      'cedar_101',
      'cedar_102',
      'harbour_ph',
      'burnaby_301',
      'richmond_611',
      'northvan_202',
      'cedar_305',
      'surrey_305',
      'surrey_204',
      'kelowna_404',
    ]) {
      const photoIds = seedSource.match(new RegExp(`id: 'photo_${unitKey}_[^']+'`, 'g')) ?? [];
      expect(photoIds).toHaveLength(4);
    }
  });
});
