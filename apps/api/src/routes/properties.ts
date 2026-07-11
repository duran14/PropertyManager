import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { parseListInput, slugifyUnit } from '../services/property-inventory.service.js';

export const propertiesRouter = Router();

const propertySchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300),
  city: z.string().min(1).max(100),
  province: z.string().min(2).max(40).default('BC'),
  postalCode: z.string().max(20).optional().or(z.literal('')),
});

const unitSchema = z.object({
  name: z.string().min(1).max(120),
  rentCents: z.number().int().nonnegative(),
  bedrooms: z.number().int().nonnegative().optional().nullable(),
  bathrooms: z.number().nonnegative().optional().nullable(),
  squareFeet: z.number().int().nonnegative().optional().nullable(),
  availableFrom: z.string().datetime().optional().nullable().or(z.literal('')),
  amenities: z.union([z.string(), z.array(z.string())]).optional(),
  petPolicy: z.string().max(1000).optional().or(z.literal('')),
  parking: z.string().max(1000).optional().or(z.literal('')),
  utilities: z.string().max(1000).optional().or(z.literal('')),
  isActive: z.boolean().optional(),
});

propertiesRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const properties = await prisma.property.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      include: {
        units: {
          orderBy: { createdAt: 'desc' },
          include: { listingPhotos: { take: 3, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
        },
      },
    });
    res.json({ properties });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid property', details: parsed.error.flatten() });
      return;
    }

    const property = await prisma.property.create({
      data: {
        tenantId: user.tenantId,
        name: parsed.data.name,
        address: parsed.data.address,
        city: parsed.data.city,
        province: parsed.data.province,
        postalCode: parsed.data.postalCode || null,
      },
      include: { units: true },
    });
    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.post('/:propertyId/units', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = unitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid unit', details: parsed.error.flatten() });
      return;
    }

    const property = await prisma.property.findFirst({
      where: { id: req.params.propertyId, tenantId: user.tenantId },
    });
    if (!property) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    const unit = await prisma.unit.create({
      data: unitData(user.tenantId, property.id, property.name, parsed.data),
      include: { property: true, listingPhotos: true },
    });

    res.status(201).json({ unit });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.patch('/units/:unitId', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = unitSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid unit', details: parsed.error.flatten() });
      return;
    }

    const existing = await prisma.unit.findFirst({
      where: { id: req.params.unitId, tenantId: user.tenantId },
      include: { property: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Unit not found' });
      return;
    }

    const unit = await prisma.unit.update({
      where: { id: existing.id },
      data: unitUpdateData(existing.property.name, parsed.data),
      include: { property: true, listingPhotos: true },
    });

    res.json({ unit });
  } catch (err) {
    next(err);
  }
});

function unitData(
  tenantId: string,
  propertyId: string,
  propertyName: string,
  data: z.infer<typeof unitSchema>,
) {
  return {
    tenantId,
    propertyId,
    name: data.name,
    rentCents: data.rentCents,
    slug: slugifyUnit(propertyName, data.name),
    bedrooms: data.bedrooms ?? null,
    bathrooms: data.bathrooms ?? null,
    squareFeet: data.squareFeet ?? null,
    availableFrom: data.availableFrom ? new Date(data.availableFrom) : null,
    amenities: parseListInput(data.amenities),
    petPolicy: data.petPolicy || null,
    parking: data.parking || null,
    utilities: data.utilities || null,
    isActive: data.isActive ?? true,
  };
}

function unitUpdateData(propertyName: string, data: Partial<z.infer<typeof unitSchema>>) {
  const update: Record<string, unknown> = {};
  if (data.name !== undefined) {
    update.name = data.name;
    update.slug = slugifyUnit(propertyName, data.name);
  }
  if (data.rentCents !== undefined) update.rentCents = data.rentCents;
  if (data.bedrooms !== undefined) update.bedrooms = data.bedrooms;
  if (data.bathrooms !== undefined) update.bathrooms = data.bathrooms;
  if (data.squareFeet !== undefined) update.squareFeet = data.squareFeet;
  if (data.availableFrom !== undefined) update.availableFrom = data.availableFrom ? new Date(data.availableFrom) : null;
  if (data.amenities !== undefined) update.amenities = parseListInput(data.amenities);
  if (data.petPolicy !== undefined) update.petPolicy = data.petPolicy || null;
  if (data.parking !== undefined) update.parking = data.parking || null;
  if (data.utilities !== undefined) update.utilities = data.utilities || null;
  if (data.isActive !== undefined) update.isActive = data.isActive;
  return update;
}
