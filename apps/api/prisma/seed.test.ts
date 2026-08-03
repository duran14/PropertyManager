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

  it('adds a local three-photo gallery for Burnaby Heights Loft 410', () => {
    const photoIds = seedSource.match(/id: 'photo_burnaby_410_[^']+'/g) ?? [];
    expect(photoIds).toHaveLength(3);
    expect(seedSource).toContain('/demo-listings/burnaby-heights-loft-410-exterior.png');
    expect(seedSource).toContain('/demo-listings/burnaby-heights-loft-410-living-kitchen.png');
    expect(seedSource).toContain('/demo-listings/burnaby-heights-loft-410-bedroom.png');
  });

  it('completes each previously empty active listing with a three-photo local gallery', () => {
    const galleries = [
      ['kelowna_303', 'kelowna-lakeside-303'],
      ['kits_203', 'kits-point-203'],
      ['northvan_101', 'northvan-bluffs-101'],
      ['richmond_502', 'richmond-gardens-502'],
    ];

    for (const [unitKey, assetSlug] of galleries) {
      const photoIds = seedSource.match(new RegExp(`id: 'photo_${unitKey}_[^']+'`, 'g')) ?? [];
      expect(photoIds).toHaveLength(3);
      expect(seedSource).toContain(`/demo-listings/${assetSlug}-exterior.png`);
      expect(seedSource).toContain(`/demo-listings/${assetSlug}-living-kitchen.png`);
      expect(seedSource).toContain(`/demo-listings/${assetSlug}-bedroom.png`);
    }
  });
});
