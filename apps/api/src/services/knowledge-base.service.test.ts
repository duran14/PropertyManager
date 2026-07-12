import { describe, expect, it } from 'vitest';
import { buildObsidianMarkdownFiles } from './knowledge-base.service.js';

describe('knowledge base service', () => {
  it('builds Obsidian-ready markdown files from app-owned records', () => {
    const files = buildObsidianMarkdownFiles({
      tenantName: 'Pacific Ridge',
      onboarding: {
        services: ['Leasing', 'Tenant screening'],
        values: ['Transparent'],
        pricingNotes: 'Placement fee applies.',
        petPolicy: 'Cats considered.',
        aiTone: 'Warm and professional.',
      },
      properties: [
        {
          name: 'Cedar Court',
          address: '1200 Granville St',
          city: 'Vancouver',
          province: 'BC',
          units: [
            {
              name: 'Apt 102',
              rentCents: 265000,
              bedrooms: 1,
              bathrooms: 1,
              amenities: ['balcony'],
              petPolicy: 'Cats ok',
              isActive: true,
            },
          ],
        },
      ],
      documents: [{ filename: 'Pet Policy.pdf', category: 'policy', description: 'Default pet rules' }],
    });

    expect(files.map((file) => file.path)).toEqual([
      'Company/Pacific Ridge.md',
      'Properties/Cedar Court.md',
      'Documents/Pet Policy.md',
    ]);
    expect(files[1].content).toContain('## Units');
    expect(files[1].content).toContain('- Apt 102: $2,650/month');
  });
});
