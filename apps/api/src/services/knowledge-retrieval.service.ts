export interface KnowledgeChunkInput {
  sourceType: string;
  sourceId: string;
  title: string;
  text: string;
  maxChunkLength?: number;
}

export interface KnowledgeChunk {
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  chunkIndex: number;
}

export interface RankedKnowledgeChunk extends KnowledgeChunk {
  score: number;
}

export function buildKnowledgeChunks(input: KnowledgeChunkInput): KnowledgeChunk[] {
  const maxChunkLength = input.maxChunkLength ?? 900;
  const words = normalizeWhitespace(input.text).split(' ').filter(Boolean);
  const chunks: KnowledgeChunk[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const word of words) {
    const nextLength = currentLength + word.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && nextLength > maxChunkLength) {
      chunks.push(toChunk(input, current.join(' '), chunks.length));
      current = [word];
      currentLength = word.length;
    } else {
      current.push(word);
      currentLength = nextLength;
    }
  }

  if (current.length > 0) {
    chunks.push(toChunk(input, current.join(' '), chunks.length));
  }

  return chunks;
}

export function rankKnowledgeChunks(
  chunks: KnowledgeChunk[],
  query: string,
): RankedKnowledgeChunk[] {
  const queryTerms = new Set(tokenize(query));
  return chunks
    .map((chunk) => ({
      ...chunk,
      score: tokenize(`${chunk.title} ${chunk.content}`).filter((term) => queryTerms.has(term))
        .length,
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
}

export function formatKnowledgeContext(chunks: KnowledgeChunk[]): string {
  return chunks
    .map((chunk) => `[${chunk.sourceType}: ${chunk.title}]\n${chunk.content}`)
    .join('\n\n');
}

function toChunk(input: KnowledgeChunkInput, content: string, chunkIndex: number): KnowledgeChunk {
  return {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    title: input.title,
    content,
    chunkIndex,
  };
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(' ')
    .filter((term) => term.length >= 3)
    .map((term) => (term.endsWith('s') && term.length > 3 ? term.slice(0, -1) : term));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
