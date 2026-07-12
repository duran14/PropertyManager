import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { extractTextFromDocumentUpload } from '../services/document-extraction.service.js';
import { normalizeDocumentUpload } from '../services/document-intake.service.js';
import {
  buildDocumentStorageKey,
  createLocalDocumentStorage,
  decodeBase64Payload,
} from '../services/document-storage.service.js';
import { buildKnowledgeChunks } from '../services/knowledge-retrieval.service.js';

export const documentsRouter = Router();

const documentSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(120),
  category: z.enum(['logo', 'pricing', 'policy', 'compliance', 'property', 'unit', 'other']),
  entityType: z.enum(['tenant', 'property', 'unit', 'lead']).optional(),
  entityId: z.string().optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  textContent: z.string().max(20000).optional().nullable(),
  storageUrl: z.string().url().optional().nullable().or(z.literal('')),
  fileBase64: z.string().max(1_500_000).optional().nullable(),
});

documentsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const documents = await prisma.knowledgeDocument.findMany({
      where: {
        tenantId: user.tenantId,
        ...(typeof req.query.entityType === 'string' ? { entityType: req.query.entityType } : {}),
        ...(typeof req.query.entityId === 'string' ? { entityId: req.query.entityId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        category: true,
        entityType: true,
        entityId: true,
        description: true,
        textContent: true,
        storageKey: true,
        storageUrl: true,
        extractionStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ documents });
  } catch (err) {
    next(err);
  }
});

documentsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid document', details: parsed.error.flatten() });
      return;
    }

    const normalized = normalizeDocumentUpload(parsed.data);
    const documentId = randomUUID();
    const extraction = extractTextFromDocumentUpload({
      mimeType: normalized.mimeType,
      fileBase64: normalized.fileBase64,
      providedTextContent: normalized.textContent,
    });
    const storedFile = normalized.fileBase64
      ? await storeUploadedDocument({
        tenantId: user.tenantId,
        documentId,
        filename: normalized.filename,
        mimeType: normalized.mimeType,
        fileBase64: normalized.fileBase64,
      })
      : null;

    const document = await prisma.$transaction(async (tx) => {
      const created = await tx.knowledgeDocument.create({
        data: {
          id: documentId,
          tenantId: user.tenantId,
          filename: normalized.filename,
          mimeType: normalized.mimeType,
          category: normalized.category,
          entityType: normalized.entityType,
          entityId: normalized.entityId,
          description: normalized.description,
          textContent: extraction.textContent,
          storageKey: storedFile?.storageKey ?? null,
          storageUrl: storedFile?.storageUrl ?? normalized.storageUrl ?? null,
          fileBase64: null,
          extractionStatus: extraction.extractionStatus,
        },
      });

      const chunks = buildKnowledgeChunks({
        sourceType: 'document',
        sourceId: created.id,
        title: created.filename,
        text: [created.description, created.textContent].filter(Boolean).join('\n\n'),
      });
      if (chunks.length > 0) {
        await tx.knowledgeChunk.createMany({
          data: chunks.map((chunk) => ({
            tenantId: user.tenantId,
            sourceType: chunk.sourceType,
            sourceId: chunk.sourceId,
            title: chunk.title,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
          })),
        });
      }

      return created;
    });
    res.status(201).json({ document });
  } catch (err) {
    next(err);
  }
});

async function storeUploadedDocument(input: {
  tenantId: string;
  documentId: string;
  filename: string;
  mimeType: string;
  fileBase64: string;
}) {
  const env = getEnv();
  const storage = createLocalDocumentStorage({
    rootDir: path.resolve(env.DOCUMENT_STORAGE_DIR),
    publicBaseUrl: env.DOCUMENT_STORAGE_PUBLIC_BASE_URL || undefined,
  });
  return storage.putObject({
    key: buildDocumentStorageKey(input),
    body: decodeBase64Payload(input.fileBase64),
    contentType: input.mimeType,
  });
}
