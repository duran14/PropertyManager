import { describe, expect, it } from 'vitest';
import { buildKnowledgeChunks, rankKnowledgeChunks } from './knowledge-retrieval.service.js';

describe('knowledge retrieval service', () => {
  it('chunks document text into searchable passages', () => {
    const chunks = buildKnowledgeChunks({
      sourceType: 'document',
      sourceId: 'doc_1',
      title: 'Pet Policy',
      text: 'Cats are considered with approval. Dogs require manager review.',
      maxChunkLength: 32,
    });

    expect(chunks).toEqual([
      {
        sourceType: 'document',
        sourceId: 'doc_1',
        title: 'Pet Policy',
        content: 'Cats are considered with',
        chunkIndex: 0,
      },
      {
        sourceType: 'document',
        sourceId: 'doc_1',
        title: 'Pet Policy',
        content: 'approval. Dogs require manager',
        chunkIndex: 1,
      },
      {
        sourceType: 'document',
        sourceId: 'doc_1',
        title: 'Pet Policy',
        content: 'review.',
        chunkIndex: 2,
      },
    ]);
  });

  it('ranks chunks by query term overlap', () => {
    const chunks = [
      { sourceType: 'document', sourceId: 'doc_1', title: 'Pets', content: 'Cats are considered with approval.', chunkIndex: 0 },
      { sourceType: 'property', sourceId: 'unit_1', title: 'Apt 102', content: 'Parking is included underground.', chunkIndex: 0 },
      { sourceType: 'document', sourceId: 'doc_2', title: 'Fees', content: 'Application fee is waived.', chunkIndex: 0 },
    ];

    expect(rankKnowledgeChunks(chunks, 'cat approval policy')[0]).toMatchObject({
      sourceId: 'doc_1',
      score: 2,
    });
  });
});
