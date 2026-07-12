/**
 * Rutas de Prospección (Módulo A).
 *
 * PÚBLICAS (sin auth):
 *  GET  /public/units/:slug           — datos de una unidad para la URL pública (SEO)
 *  POST /public/units/:slug/contact   — formulario de contacto desde la URL pública
 *
 * PRIVADAS (auth):
 *  GET  /leads                        — lista de leads
 *  PATCH /leads/:id/status            — actualiza estado del lead
 *  POST /leads/simulate-chat          — simula un mensaje entrante del chatbot (dev)
 */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { requireAuth, requireUser } from '../auth/context.js';
import {
  createLeadFromUnitUrl,
  buildLeadProspectProfile,
  summarizeLatestLeadActivity,
  isLeadStatus,
  listLeads,
  updateLeadStatus,
} from '../services/leads.service.js';
import { handleInboundMessage } from '../services/chatbot.service.js';
import { createConversationEvent } from '../services/conversation-events.service.js';

export const publicRouter = Router();
export const leadsRouter = Router();

// =============== RUTAS PÚBLICAS ===============

publicRouter.get('/units/:slug', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }
    const unit = await prisma.unit.findFirst({
      where: { tenantId, slug: req.params.slug, isActive: true },
      include: { property: true },
    });
    if (!unit) {
      res.status(404).json({ error: 'Unit not found' });
      return;
    }
    res.json({
      unit: {
        name: unit.name,
        slug: unit.slug,
        rentCents: unit.rentCents,
        property: {
          name: unit.property.name,
          address: unit.property.address,
          city: unit.property.city,
          province: unit.property.province,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

const contactSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  message: z.string().max(1000).optional(),
});

publicRouter.post('/units/:slug/contact', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }
    const unit = await prisma.unit.findFirst({
      where: { tenantId, slug: req.params.slug, isActive: true },
      select: { id: true },
    });
    if (!unit) {
      res.status(404).json({ error: 'Unit not found' });
      return;
    }
    const parsed = contactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid data', details: parsed.error.flatten() });
      return;
    }
    const result = await createLeadFromUnitUrl({
      tenantId,
      unitId: unit.id,
      ...parsed.data,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =============== RUTAS PRIVADAS ===============

leadsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const leads = await listLeads(user.tenantId, {
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      source: typeof req.query.source === 'string' ? req.query.source : undefined,
    });
    res.json({ leads });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      include: {
        unit: { select: { name: true, property: { select: { name: true, address: true, city: true } } } },
        conversations: {
          orderBy: { updatedAt: 'desc' },
          include: {
            slots: { select: { key: true, value: true } },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 5,
              select: { id: true, role: true, content: true, createdAt: true },
            },
          },
        },
        showings: {
          orderBy: { scheduledAt: 'asc' },
          include: {
            unit: { select: { name: true, property: { select: { name: true, address: true, city: true } } } },
          },
        },
        conversationEvents: {
          orderBy: { createdAt: 'desc' },
          include: { actorUser: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    res.json({
      lead: {
        ...lead,
        prospectProfile: buildLeadProspectProfile(lead.conversations),
        latestActivity: summarizeLatestLeadActivity(lead.conversationEvents),
        notes: lead.conversationEvents.filter((event) => event.type === 'note.internal_added'),
      },
    });
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({ status: z.string() });

leadsRouter.patch('/:id/status', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    if (!isLeadStatus(parsed.data.status)) {
      res.status(400).json({ error: 'Invalid lead status' });
      return;
    }
    const lead = await prisma.lead.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      select: {
        id: true,
        status: true,
        conversations: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    await updateLeadStatus(req.params.id, user.tenantId, parsed.data.status);
    const conversation = lead?.conversations[0];
    if (lead && conversation && lead.status !== parsed.data.status) {
      await createConversationEvent({
        tenantId: user.tenantId,
        conversationId: conversation.id,
        leadId: lead.id,
        actorUserId: user.userId,
        type: 'lead.status_changed',
        payload: { fromStatus: lead.status, toStatus: parsed.data.status },
      });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Endpoint de dev para probar el chatbot sin Twilio real.
leadsRouter.post('/simulate-chat', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { from, body, channel } = req.body as { from?: string; body?: string; channel?: string };
    if (!from || !body) {
      res.status(400).json({ error: 'from and body are required' });
      return;
    }
    const adapters = getAdapters();
    const ch = (channel ?? 'whatsapp') as 'whatsapp' | 'sms' | 'telegram' | 'web' | 'email';
    const result = await handleInboundMessage(
      { tenantId: user.tenantId, from, body, channel: ch },
      { glm: adapters.glm, messaging: adapters.messaging[ch], showmojo: adapters.showmojo },
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
