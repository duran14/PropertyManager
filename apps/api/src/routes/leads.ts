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
import { getReplyAddressFromConversation, handleInboundMessage } from '../services/chatbot.service.js';
import { createConversationEvent } from '../services/conversation-events.service.js';
import { buildShortlistPrefillContact, getPublicShortlist, hashShortlistToken } from '../services/shortlist.service.js';
import { getAvailableSlots, scheduleTour } from '../services/scheduling.service.js';
import { parseShortlistBooking } from '../services/shortlist-booking.service.js';

export const publicRouter = Router();
export const leadsRouter = Router();

publicRouter.get('/shortlists/:token', async (req, res, next) => {
  try {
    const result = await getPublicShortlist(req.params.token);
    if (!result) return void res.status(404).json({ error: 'Shortlist not found or expired' });
    const slotMap = Object.fromEntries(result.shortlist.conversation.slots.map((slot) => [slot.key, slot.value]));
    const mapUnit = (unit: typeof result.units[number]) => ({
      id: unit!.id, name: unit!.name, rentCents: unit!.rentCents, bedrooms: unit!.bedrooms,
      bathrooms: unit!.bathrooms, squareFeet: unit!.squareFeet, amenities: unit!.amenities,
      petPolicy: unit!.petPolicy, availableFrom: unit!.availableFrom, isActive: unit!.isActive,
      property: { name: unit!.property.name, address: unit!.property.address, city: unit!.property.city, province: unit!.property.province },
      photos: unit!.listingPhotos.map((photo) => ({ url: photo.enhancedUrl ?? photo.originalUrl })),
    });
    res.json({
      selectedUnitId: result.shortlist.selectedUnitId,
      contact: buildShortlistPrefillContact(slotMap, result.shortlist.conversation.lead),
      tenantName: result.tenantName,
      tenantId: result.shortlist.tenantId,
      units: result.units.map(mapUnit),
      catalog: result.catalog.map((unit) => ({
        id: unit.id, name: unit.name, slug: unit.slug, rentCents: unit.rentCents,
        bedrooms: unit.bedrooms, bathrooms: unit.bathrooms, squareFeet: unit.squareFeet,
        amenities: unit.amenities, petPolicy: unit.petPolicy, parking: unit.parking,
        utilities: unit.utilities, availableFrom: unit.availableFrom,
        property: { name: unit.property.name, address: unit.property.address, city: unit.property.city, province: unit.property.province },
        photos: unit.listingPhotos.map((photo) => ({ url: photo.enhancedUrl ?? photo.originalUrl, isPrimary: photo.isPrimary })),
      })),
    });
  } catch (error) { next(error); }
});

publicRouter.post('/shortlists/:token/select', async (req, res, next) => {
  try {
    const shortlist = await prisma.propertyShortlist.findFirst({ where: { tokenHash: hashShortlistToken(req.params.token), expiresAt: { gt: new Date() } } });
    const unitId = String(req.body?.unitId ?? '');
    if (!shortlist || !shortlist.unitIds.includes(unitId)) return void res.status(400).json({ error: 'Invalid shortlist selection' });
    await prisma.propertyShortlist.update({ where: { id: shortlist.id }, data: { selectedUnitId: unitId, status: 'selected' } });
    await prisma.chatConversation.update({ where: { id: shortlist.conversationId }, data: { unitId } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

publicRouter.get('/shortlists/:token/slots', async (req, res, next) => {
  try {
    const shortlist = await prisma.propertyShortlist.findFirst({ where: { tokenHash: hashShortlistToken(req.params.token), expiresAt: { gt: new Date() } } });
    if (!shortlist?.selectedUnitId) return void res.status(400).json({ error: 'Select a property first' });
    res.json(await getAvailableSlots(shortlist.tenantId, shortlist.selectedUnitId, getAdapters().showmojo));
  } catch (error) { next(error); }
});

publicRouter.post('/shortlists/:token/schedule', async (req, res, next) => {
  try {
    const shortlist = await prisma.propertyShortlist.findFirst({ where: { tokenHash: hashShortlistToken(req.params.token), expiresAt: { gt: new Date() } }, include: { conversation: { include: { lead: true } } } });
    if (!shortlist?.selectedUnitId || !shortlist.conversation.lead) return void res.status(400).json({ error: 'Select a property first' });
    const lead = shortlist.conversation.lead;
    let booking;
    try {
      booking = parseShortlistBooking(req.body);
    } catch {
      return void res.status(400).json({ error: 'Name, phone, a valid email, and a tour time are required' });
    }
    const unit = await prisma.unit.findFirst({
      where: { id: shortlist.selectedUnitId, tenantId: shortlist.tenantId },
      include: { property: { select: { name: true, address: true, city: true, province: true } } },
    });
    if (!unit) return void res.status(404).json({ error: 'Selected property not found' });
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        name: booking.name,
        phone: booking.phone,
        email: booking.email,
        ...(booking.notes ? { message: booking.notes } : {}),
      },
    });
    const result = await scheduleTour({ tenantId: shortlist.tenantId, unitId: shortlist.selectedUnitId, leadId: lead.id, slotIndex: booking.slotIndex, prospectName: booking.name, prospectPhone: booking.phone, prospectEmail: booking.email, conversationId: shortlist.conversationId, adapter: getAdapters().showmojo });
    await prisma.propertyShortlist.update({ where: { id: shortlist.id }, data: { status: 'scheduled', scheduledAt: new Date(), remindersStopped: true, nextReminderAt: null } });
    const unitLabel = `${unit.property.name} — ${unit.name}`;
    const unitAddress = `${unit.property.address}, ${unit.property.city}, ${unit.property.province}`;
    await prisma.$transaction([
      prisma.chatConversation.update({
        where: { id: shortlist.conversationId },
        data: { state: 'handoff', unitId: unit.id },
      }),
      prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: shortlist.conversationId, key: 'tour_scheduled_at' } },
        update: { value: result.scheduledAt },
        create: { conversationId: shortlist.conversationId, key: 'tour_scheduled_at', value: result.scheduledAt },
      }),
      prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: shortlist.conversationId, key: 'scheduled_unit_address' } },
        update: { value: unitAddress },
        create: { conversationId: shortlist.conversationId, key: 'scheduled_unit_address', value: unitAddress },
      }),
      prisma.conversationSlot.upsert({
        where: { conversationId_key: { conversationId: shortlist.conversationId, key: 'scheduled_unit_label' } },
        update: { value: unitLabel },
        create: { conversationId: shortlist.conversationId, key: 'scheduled_unit_label', value: unitLabel },
      }),
    ]);
    await getAdapters().messaging[shortlist.conversation.channel].send({
      to: getReplyAddressFromConversation(shortlist.conversation.externalId),
      channel: shortlist.conversation.channel,
      body: `Your tour for ${unitLabel} at ${unitAddress} is scheduled for ${new Date(result.scheduledAt).toLocaleString('en-CA')}. I'll keep the confirmation here for you.`,
    });
    res.json({ ...result, unitLabel, unitAddress });
  } catch (error) { next(error); }
});

// =============== RUTAS PÚBLICAS ===============

publicRouter.get('/units', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'] ?? req.query.tenant;
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }

    const city = typeof req.query.city === 'string' ? req.query.city : undefined;
    const bedroomsParam = typeof req.query.bedrooms === 'string' ? req.query.bedrooms : undefined;
    const bedroomsMinParam = typeof req.query.bedroomsMin === 'string' ? req.query.bedroomsMin : undefined;
    const bedroomsMaxParam = typeof req.query.bedroomsMax === 'string' ? req.query.bedroomsMax : undefined;
    const budgetParam = typeof req.query.budget === 'string' ? req.query.budget : undefined;
    const petsParam = typeof req.query.pets === 'string' ? req.query.pets : undefined;

    const units = await prisma.unit.findMany({
      where: { tenantId, isActive: true },
      include: {
        property: { select: { name: true, address: true, city: true, province: true } },
        listingPhotos: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 6,
        },
      },
      orderBy: { rentCents: 'asc' },
    });

    const filtered = units.filter((unit) => {
      if (city) {
        const unitCity = unit.property.city.toLowerCase();
        const queryCity = city.toLowerCase();
        const cityMatches = unitCity.includes(queryCity) || queryCity.includes(unitCity);
        if (!cityMatches) return false;
      }
      if (bedroomsParam) {
        const isMinimum = bedroomsParam.endsWith('+');
        const requested = Number.parseInt(bedroomsParam.replace('+', ''), 10);
        if (!Number.isNaN(requested)) {
          if (isMinimum) {
            if (unit.bedrooms === null || unit.bedrooms < requested) return false;
          } else if (unit.bedrooms !== requested) {
            return false;
          }
        }
      }
      if (bedroomsMinParam) {
        const min = Number.parseInt(bedroomsMinParam, 10);
        if (!Number.isNaN(min) && (unit.bedrooms === null || unit.bedrooms < min)) return false;
      }
      if (bedroomsMaxParam) {
        const max = Number.parseInt(bedroomsMaxParam, 10);
        if (!Number.isNaN(max) && (unit.bedrooms === null || unit.bedrooms > max)) return false;
      }
      if (budgetParam) {
        const budgetCents = Number.parseFloat(budgetParam) * 100;
        if (!Number.isNaN(budgetCents) && unit.rentCents > budgetCents) return false;
      }
      if (petsParam && petsParam !== 'none') {
        const policy = unit.petPolicy?.toLowerCase() ?? '';
        if (petsParam.includes('cat') && !/cat|pet friendly/.test(policy)) return false;
        if (petsParam.includes('dog') && !/dog|pet friendly/.test(policy)) return false;
      }
      return true;
    });

    res.json({
      units: filtered.map((unit) => ({
        id: unit.id,
        name: unit.name,
        slug: unit.slug,
        rentCents: unit.rentCents,
        bedrooms: unit.bedrooms,
        bathrooms: unit.bathrooms,
        squareFeet: unit.squareFeet,
        amenities: unit.amenities,
        petPolicy: unit.petPolicy,
        parking: unit.parking,
        utilities: unit.utilities,
        availableFrom: unit.availableFrom,
        property: {
          name: unit.property.name,
          address: unit.property.address,
          city: unit.property.city,
          province: unit.property.province,
        },
        photos: unit.listingPhotos.map((photo) => ({
          url: photo.enhancedUrl ?? photo.originalUrl,
          isPrimary: photo.isPrimary,
        })),
      })),
    });
  } catch (err) {
    next(err);
  }
});

publicRouter.get('/units/:slug', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'] ?? req.query.tenant;
    if (typeof tenantId !== 'string') {
      res.status(400).json({ error: 'x-tenant-id header is required' });
      return;
    }
    const unit = await prisma.unit.findFirst({
      where: { tenantId, slug: req.params.slug, isActive: true },
      include: {
        property: true,
        listingPhotos: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
      },
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
        bedrooms: unit.bedrooms,
        bathrooms: unit.bathrooms,
        squareFeet: unit.squareFeet,
        amenities: unit.amenities,
        petPolicy: unit.petPolicy,
        parking: unit.parking,
        utilities: unit.utilities,
        availableFrom: unit.availableFrom,
        photos: unit.listingPhotos.map((photo) => ({
          url: photo.enhancedUrl ?? photo.originalUrl,
          isPrimary: photo.isPrimary,
        })),
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
    const tenantId = req.headers['x-tenant-id'] ?? req.query.tenant;
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

publicRouter.get('/units/:slug/slots', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'] ?? req.query.tenant;
    if (typeof tenantId !== 'string') return void res.status(400).json({ error: 'x-tenant-id header is required' });
    const unit = await prisma.unit.findFirst({ where: { tenantId, slug: req.params.slug, isActive: true }, select: { id: true } });
    if (!unit) return void res.status(404).json({ error: 'Unit not found' });
    res.json(await getAvailableSlots(tenantId, unit.id, getAdapters().showmojo));
  } catch (err) { next(err); }
});

const publicScheduleSchema = z.object({
  slotIndex: z.number().int().min(0),
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
});

publicRouter.post('/units/:slug/schedule', async (req, res, next) => {
  try {
    const tenantId = req.headers['x-tenant-id'] ?? req.query.tenant;
    if (typeof tenantId !== 'string') return void res.status(400).json({ error: 'x-tenant-id header is required' });
    const unit = await prisma.unit.findFirst({
      where: { tenantId, slug: req.params.slug, isActive: true },
      include: { property: { select: { name: true, address: true, city: true, province: true } } },
    });
    if (!unit) return void res.status(404).json({ error: 'Unit not found' });
    const parsed = publicScheduleSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid data', details: parsed.error.flatten() });

    let lead = await prisma.lead.findFirst({ where: { tenantId, email: parsed.data.email }, orderBy: { updatedAt: 'desc' } });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          tenantId,
          name: parsed.data.name,
          phone: parsed.data.phone,
          email: parsed.data.email,
          status: 'new_',
          source: 'unit_url',
        },
      });
    }

    const result = await scheduleTour({
      tenantId,
      unitId: unit.id,
      leadId: lead.id,
      slotIndex: parsed.data.slotIndex,
      prospectName: parsed.data.name,
      prospectPhone: parsed.data.phone,
      prospectEmail: parsed.data.email,
      adapter: getAdapters().showmojo,
    });

    const unitLabel = `${unit.property.name} — ${unit.name}`;
    const unitAddress = `${unit.property.address}, ${unit.property.city}, ${unit.property.province}`;
    res.json({ scheduledAt: result.scheduledAt, unitLabel, unitAddress });
  } catch (err) { next(err); }
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
        assignedUser: {
          select: { id: true, firstName: true, lastName: true, email: true, role: true },
        },
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
const workflowSchema = z.object({
  operationalStatus: z
    .enum(['needs_review', 'assigned', 'waiting_on_prospect', 'needs_handoff', 'closed'])
    .optional(),
  assignedUserId: z.string().nullable().optional(),
});

leadsRouter.patch('/:id/workflow', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = workflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid workflow update', details: parsed.error.flatten() });
      return;
    }

    if (parsed.data.assignedUserId) {
      const assignee = await prisma.user.findFirst({
        where: { id: parsed.data.assignedUserId, tenantId: user.tenantId, isActive: true },
        select: { id: true },
      });
      if (!assignee) {
        res.status(404).json({ error: 'Assigned user not found' });
        return;
      }
    }

    const lead = await prisma.lead.updateMany({
      where: { id: req.params.id, tenantId: user.tenantId },
      data: {
        ...(parsed.data.operationalStatus !== undefined
          ? { operationalStatus: parsed.data.operationalStatus }
          : {}),
        ...(parsed.data.assignedUserId !== undefined
          ? { assignedUserId: parsed.data.assignedUserId }
          : {}),
      },
    });
    if (lead.count === 0) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
