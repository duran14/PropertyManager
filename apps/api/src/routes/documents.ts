import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { normalizeDocumentUpload } from '../services/document-intake.service.js';

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
        storageUrl: true,
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
    const document = await prisma.knowledgeDocument.create({
      data: {
        tenantId: user.tenantId,
        ...normalized,
        storageUrl: normalized.storageUrl || null,
      },
    });
    res.status(201).json({ document });
  } catch (err) {
    next(err);
  }
});
