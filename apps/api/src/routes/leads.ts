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
import { promises as fs } from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { ChatChannel } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { getAdapters } from '../config/adapters.js';
import { getEnv } from '../config/env.js';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
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
import { bookShowingFromCalendar, getSchedulingAvailability } from '../services/scheduling.service.js';
import { parseShortlistBooking } from '../services/shortlist-booking.service.js';
import {
  getIdDocumentForDownload,
  getPublicRentalApplication,
  submitRentalApplication,
} from '../services/rental-application.service.js';
import { resolveStorageKeyWithinRoot } from '../services/document-storage.service.js';
import { approveScreening, recordManualScreeningReport } from '../services/screening.service.js';
import { actorFromUser, writeAudit } from '../services/audit.service.js';

export const publicRouter = Router();
export const leadsRouter = Router();

// La columna `annualIncome` es `Int` en Prisma (rango de un int32 de
// Postgres). El body llega como JSON sin tipado real: un decimal
// (82000.50), un valor > 2^31, o `Infinity` (que `JSON.parse` produce de
// `1e999`, y para el que `typeof Infinity === 'number'` sigue siendo
// cierto) harían que Prisma lance al escribir → 500 genérico. Para
// entonces `submitRentalApplication` ya escribió el documento de
// identificación a disco, así que cada reintento dejaría un archivo
// huérfano. Por eso esta validación corre ANTES de llamar al servicio.
const MAX_ANNUAL_INCOME = 2_000_000_000;

type ParsedAnnualIncome = { ok: true; value: number | null } | { ok: false; error: string };

export function parseAnnualIncome(value: unknown): ParsedAnnualIncome {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, error: 'annualIncome must be a whole number' };
  }
  if (value < 0 || value > MAX_ANNUAL_INCOME) {
    return { ok: false, error: 'annualIncome must be between 0 and ' + MAX_ANNUAL_INCOME };
  }
  return { ok: true, value };
}

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
    const availability = await getSchedulingAvailability(shortlist.tenantId, shortlist.selectedUnitId);
    if (!availability.ok) {
      const status = availability.reason === 'unit_not_found' ? 404 : 503;
      res.status(status).json({ error: availability.reason });
      return;
    }
    res.json({ slots: availability.slots });
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
    // Se resuelve por el startAt exacto que el prospecto vio, NO por índice
    // contra una disponibilidad recién recalculada: `getSchedulingAvailability`
    // corre `from = now + minNoticeHours`, así que si pasaron minutos entre el
    // GET de horarios y este POST, la cabeza de la lista pudo caerse y todos
    // los índices siguientes correrse uno hacia abajo. Reindexar aquí
    // reservaría silenciosamente el hueco equivocado. `bookShowingFromCalendar`
    // ya hace este mismo match por startAt contra disponibilidad fresca
    // internamente y devuelve `slot_no_longer_offered` si ya no está — no hace
    // falta duplicar esa validación aquí.
    const booked = await bookShowingFromCalendar({
      tenantId: shortlist.tenantId,
      unitId: shortlist.selectedUnitId,
      leadId: lead.id,
      startAt: new Date(booking.startAt),
      prospectName: booking.name,
      prospectPhone: booking.phone,
      prospectEmail: booking.email,
      conversationId: shortlist.conversationId,
    });
    if (!booked.ok) {
      res.status(booked.status).json({ error: booked.error });
      return;
    }
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
        update: { value: booked.scheduledAt },
        create: { conversationId: shortlist.conversationId, key: 'tour_scheduled_at', value: booked.scheduledAt },
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
      body: `Your tour for ${unitLabel} at ${unitAddress} is scheduled for ${new Date(booked.scheduledAt).toLocaleString('en-CA')}. I'll keep the confirmation here for you.`,
    });
    res.json({ ...booked, unitLabel, unitAddress });
  } catch (error) { next(error); }
});

publicRouter.get('/applications/:token', async (req, res, next) => {
  try {
    const application = await getPublicRentalApplication(req.params.token);
    if (!application) return void res.status(404).json({ error: 'Application not found or expired' });
    res.json({
      status: application.status,
      tenantName: application.tenant.name,
      showingAt: application.showing.scheduledAt,
      unit: application.unit
        ? {
          name: application.unit.name,
          property: application.unit.property,
        }
        : null,
    });
  } catch (error) { next(error); }
});

publicRouter.post('/applications/:token', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const annualIncome = parseAnnualIncome(body.annualIncome);
    if (!annualIncome.ok) {
      return void res.status(400).json({ error: annualIncome.error });
    }
    const result = await submitRentalApplication(
      req.params.token,
      {
        annualIncome: annualIncome.value,
        employerName: typeof body.employerName === 'string' ? body.employerName : null,
        references: typeof body.references === 'string' ? body.references : null,
        applicantFullName: typeof body.applicantFullName === 'string' ? body.applicantFullName : '',
        applicantFirstName: typeof body.applicantFirstName === 'string' ? body.applicantFirstName : '',
        applicantLastName: typeof body.applicantLastName === 'string' ? body.applicantLastName : '',
        dateOfBirth: typeof body.dateOfBirth === 'string' ? body.dateOfBirth : '',
        currentAddress: typeof body.currentAddress === 'string' ? body.currentAddress : '',
        currentCity: typeof body.currentCity === 'string' ? body.currentCity : '',
        currentProvince: typeof body.currentProvince === 'string' ? body.currentProvince : '',
        currentPostalCode: typeof body.currentPostalCode === 'string' ? body.currentPostalCode : '',
        currentAddressStartDate: typeof body.currentAddressStartDate === 'string' ? body.currentAddressStartDate : '',
        consentApplication: body.consentApplication === true,
        consentCreditCheck: body.consentCreditCheck === true,
        consentPoliceCheck: body.consentPoliceCheck === true,
        idDocumentFilename: typeof body.idDocumentFilename === 'string' ? body.idDocumentFilename : null,
        idDocumentMimeType: typeof body.idDocumentMimeType === 'string' ? body.idDocumentMimeType : null,
        idDocumentBase64: typeof body.idDocumentBase64 === 'string' ? body.idDocumentBase64 : null,
      },
      { messaging: getAdapters().messaging },
    );
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
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
    const availability = await getSchedulingAvailability(tenantId, unit.id);
    if (!availability.ok) {
      const status = availability.reason === 'unit_not_found' ? 404 : 503;
      res.status(status).json({ error: availability.reason });
      return;
    }
    res.json({ slots: availability.slots });
  } catch (err) { next(err); }
});

const publicScheduleSchema = z.object({
  // ISO exacto del hueco elegido, no un índice — ver el comentario en la
  // ruta de shortlists más arriba para el porqué (drift de `slotIndex`
  // contra una disponibilidad recalculada).
  startAt: z.string().datetime(),
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

    // Igual que en la ruta de shortlists: se resuelve por el startAt exacto,
    // no reindexando contra disponibilidad recién recalculada.
    // `bookShowingFromCalendar` revalida ese startAt contra disponibilidad
    // fresca y devuelve `slot_no_longer_offered` si ya no está.
    const booked = await bookShowingFromCalendar({
      tenantId,
      unitId: unit.id,
      leadId: lead.id,
      startAt: new Date(parsed.data.startAt),
      prospectName: parsed.data.name,
      prospectPhone: parsed.data.phone,
      prospectEmail: parsed.data.email,
    });
    if (!booked.ok) {
      res.status(booked.status).json({ error: booked.error });
      return;
    }

    const unitLabel = `${unit.property.name} — ${unit.name}`;
    const unitAddress = `${unit.property.address}, ${unit.property.city}, ${unit.property.province}`;
    res.json({ scheduledAt: booked.scheduledAt, unitLabel, unitAddress });
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

// Fase 2.2: descarga del reporte completo de screening (crédito o
// antecedentes penales). El resumen (`{tipo}CheckSummary`) ya viaja en
// GET /showings/:id/application para decidir rápido; esta ruta es para
// cuando ese resumen no basta y hace falta el PDF completo del proveedor.
leadsRouter.get('/applications/:applicationId/report/:kind', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { applicationId, kind } = req.params;
    if (kind !== 'credit' && kind !== 'criminal') {
      res.status(400).json({ error: 'Invalid report kind' });
      return;
    }
    // Aislamiento por tenant: la fila se busca filtrada por el tenantId del
    // usuario autenticado ANTES de tocar el disco. Un usuario de otro tenant
    // no puede pedir este reporte aunque adivinara el applicationId o el
    // storageKey, porque la fila que los contiene ni siquiera se encuentra
    // fuera de su tenantId.
    const application = await prisma.rentalApplication.findFirst({
      where: { id: applicationId, tenantId: user.tenantId },
      select: { creditCheckReportKey: true, criminalCheckReportKey: true },
    });
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const key = kind === 'credit' ? application.creditCheckReportKey : application.criminalCheckReportKey;
    if (!key) {
      res.status(404).json({ error: 'Report not available' });
      return;
    }

    const env = getEnv();
    const target = resolveStorageKeyWithinRoot(env.DOCUMENT_STORAGE_DIR, key);
    if (target === null) {
      res.status(400).json({ error: 'Invalid report path' });
      return;
    }
    const file = await fs.readFile(target);
    // PII sensible: la descarga queda trazada. Payload: solo el kind.
    try {
      await writeAudit({
        tenantId: user.tenantId,
        ...actorFromUser(user.userId, user.role),
        action: 'rental_application.screening_report.downloaded',
        entityType: 'rental_application',
        entityId: applicationId,
        payload: { kind },
      });
    } catch (auditError) {
      console.error('[leads] writeAudit failed after screening-report download:', auditError);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${kind}-report.pdf"`);
    res.send(file);
  } catch (err) {
    next(err);
  }
});

// Fase 3: descarga del documento de identificación subido en el formulario
// público (Fase 2A) — existía el archivo guardado pero nunca una ruta que lo
// sirviera. Mismo patrón que la ruta de reportes de screening de arriba; la
// lógica vive en getIdDocumentForDownload (testeable directo, ver
// rental-application.service.test.ts) porque este repo no tiene
// infraestructura de supertest.
leadsRouter.get('/applications/:applicationId/id-document', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { applicationId } = req.params;
    const result = await getIdDocumentForDownload(applicationId, user.tenantId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // Acceso a PII: la descarga queda trazada. Payload: solo identificadores.
    try {
      await writeAudit({
        tenantId: user.tenantId,
        ...actorFromUser(user.userId, user.role),
        action: 'rental_application.id_document.downloaded',
        entityType: 'rental_application',
        entityId: applicationId,
        payload: {},
      });
    } catch (auditError) {
      console.error('[leads] writeAudit failed after id-document download:', auditError);
    }
    // Defensa en profundidad (Critical 1, revisión final): aunque
    // getIdDocumentForDownload ya filtra contentType contra una allowlist,
    // nosniff evita que el navegador ignore el Content-Type declarado y
    // reinterprete el body por su cuenta.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', 'inline; filename="id-document"');
    res.send(result.file);
  } catch (err) {
    next(err);
  }
});

// Fase 2.2: aprobación manual del checkeo real (FrontLobby/Sterling). Un
// checkeo de crédito real cuesta $18.99 por corrida — nunca se dispara solo,
// necesita que un property_manager/broker apruebe explícitamente aquí.
leadsRouter.post(
  '/applications/:applicationId/screening/:kind/approve',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { applicationId, kind } = req.params;
      if (kind !== 'credit' && kind !== 'criminal') {
        res.status(400).json({ error: 'Invalid screening kind' });
        return;
      }
      const result = await approveScreening(applicationId, user.tenantId, kind);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const uploadReportSchema = z.object({
  mimeType: z.string().min(5),
  base64: z.string().min(10),
  filename: z.string().optional(),
});
const MAX_REPORT_BASE64_LENGTH = 1_500_000; // mismo tope que idDocumentBase64 en rental-application.service.ts

// Fase 2.2 (Task 2): carga manual de un reporte de screening (PDF/OCR) que
// el staff obtuvo por fuera de la app, de cualquier proveedor de crédito o
// antecedentes penales. A diferencia de la ruta de aprobación de arriba,
// esta es una acción humana explícita que puede registrar un resultado sin
// importar el estado actual del checkeo — ver el comentario de
// `recordManualScreeningReport` en screening.service.ts.
leadsRouter.post(
  '/applications/:applicationId/screening/:kind/upload-report',
  requireAuth,
  requireRole('property_manager', 'broker'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const { applicationId, kind } = req.params;
      if (kind !== 'credit' && kind !== 'criminal') {
        res.status(400).json({ error: 'Invalid screening kind' });
        return;
      }
      const parsed = uploadReportSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid upload', details: parsed.error.flatten() });
        return;
      }
      if (parsed.data.base64.length > MAX_REPORT_BASE64_LENGTH) {
        res.status(400).json({ error: 'The report file is too large' });
        return;
      }
      const result = await recordManualScreeningReport(applicationId, user.tenantId, kind, parsed.data);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, verdict: result.verdict });
    } catch (err) {
      next(err);
    }
  },
);

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
    const ch = (channel ?? 'whatsapp') as ChatChannel;
    const result = await handleInboundMessage(
      { tenantId: user.tenantId, from, body, channel: ch },
      { glm: adapters.glm, messaging: adapters.messaging[ch] },
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
