import { Router } from 'express';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { buildObsidianMarkdownFiles } from '../services/knowledge-base.service.js';
import { rankKnowledgeChunks } from '../services/knowledge-retrieval.service.js';

export const knowledgeBaseRouter = Router();

knowledgeBaseRouter.get('/obsidian-export', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const [tenant, onboarding, properties, documents] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId }, select: { name: true } }),
      prisma.tenantOnboardingProfile.findUnique({ where: { tenantId: user.tenantId } }),
      prisma.property.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { name: 'asc' },
        include: { units: { orderBy: { name: 'asc' } } },
      }),
      prisma.knowledgeDocument.findMany({
        where: { tenantId: user.tenantId },
        orderBy: [{ category: 'asc' }, { filename: 'asc' }],
        select: { filename: true, category: true, description: true, textContent: true },
      }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      files: buildObsidianMarkdownFiles({
        tenantName: tenant.name,
        onboarding,
        properties,
        documents,
      }),
    });
  } catch (err) {
    next(err);
  }
});

knowledgeBaseRouter.get('/search', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.json({ results: [] });
      return;
    }

    const chunks = await prisma.knowledgeChunk.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { updatedAt: 'desc' },
      take: 300,
      select: {
        sourceType: true,
        sourceId: true,
        title: true,
        content: true,
        chunkIndex: true,
      },
    });
    const results = rankKnowledgeChunks(chunks, query).slice(0, 5);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});
