import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { requireAuth, requireRole, requireUser } from '../auth/context.js';
import { prisma } from '../config/db.js';
import { getEnv } from '../config/env.js';
import { parseListInput, slugifyUnit } from '../services/property-inventory.service.js';
import { closeOwnerStatement, previewOwnerStatement } from '../services/owner-statement.service.js';
import { getListingFeed } from '../services/listing-feed.service.js';

export const propertiesRouter = Router();

export const propertySchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300),
  city: z.string().min(1).max(100),
  province: z.string().min(2).max(40).default('BC'),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  ownerId: z.string().optional().nullable(),
  managementFeePercentBps: z.number().int().min(0).max(10_000).optional(),
  reserveFundTargetCents: z.number().int().min(0).optional(),
  yearBuilt: z.number().int().min(1800).max(2100).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
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

/**
 * `Property.ownerId` es una FK simple a `Owner.id`: `Owner` tiene su propio
 * `tenantId`, y no hay ningún constraint compuesto en el esquema que
 * garantice que ambos coincidan. Sin esta validación, un usuario
 * autenticado que conozca o adivine el `id` de un Owner de OTRO tenant
 * podría vincular su propiedad a ese dueño ajeno, y
 * previewOwnerStatement/closeOwnerStatement emitirían el estado de cuenta a
 * nombre de esa persona. `raw` vacío/null/undefined siempre es válido (sin
 * dueño asignado); un `raw` con valor solo es válido si el Owner existe Y
 * pertenece a `tenantId`.
 */
export async function resolveOwnerId(
  tenantId: string,
  raw: string | null | undefined,
): Promise<{ ok: true; ownerId: string | null } | { ok: false }> {
  if (!raw) return { ok: true, ownerId: null };
  const owner = await prisma.owner.findFirst({ where: { id: raw, tenantId } });
  if (!owner) return { ok: false };
  return { ok: true, ownerId: owner.id };
}

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

// Fase 4.1: qué está y qué no está entrando al feed de sindicación. Sin
// esto la omisión es silenciosa y el PM cree que sindica más de lo que
// sindica.
//
// Ojo con el orden de rutas de Express: esta ruta es estática
// (`/syndication-status`) y debe declararse ANTES de cualquier
// `propertiesRouter.get('/:propertyId', ...)` que exista en este router, o
// Express tomaría "syndication-status" como si fuera un `propertyId` y esta
// ruta jamás se ejecutaría.
//
// Fix (Task 4, ronda de corrección 1): el conteo NO se deriva del CSV
// (contar líneas físicas infla el resultado con cualquier campo citado por
// RFC 4180 que traiga un salto de línea, ej. una dirección multilínea).
// `getListingFeed` devuelve `syndicatedCount` ya calculado desde el arreglo
// de entradas, antes de serializar.
// Fix (Important 1, ronda de corrección final): la ruta del feed vive en la
// API (`app.ts` monta `publicRouter` en `/public`), así que su URL real es
// `${API_URL}/public/listing-feed` — no `${WEB_URL}/api/public/...`. Ese
// `/api` venía del proxy de desarrollo de Vite (que además hace `rewrite`
// quitándolo); en producción no hay ningún proxy que lo resuelva, así que
// publicar esa forma le da al PM una URL que un crawler externo no puede
// alcanzar. Extraída a función pura para poder fijar la forma con un test
// sin depender de Express ni de env vars reales.
export function buildFeedUrl(apiUrl: string, tenantId: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return `${base}/public/listing-feed?tenant=${encodeURIComponent(tenantId)}`;
}

propertiesRouter.get('/syndication-status', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const { syndicatedCount, skipped } = await getListingFeed(user.tenantId, new Date());
    res.json({
      syndicated: syndicatedCount,
      skipped,
      feedUrl: buildFeedUrl(getEnv().API_URL, user.tenantId),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Arma el `data` del create de propiedad a partir del input ya validado.
 *
 * Extraída del handler para poder testearla: este repo no tiene supertest, y
 * los tests que llaman a `prisma.property.create` directo no ejercitan el
 * whitelist del handler — que fue exactamente donde se perdieron
 * silenciosamente los campos de sindicación (Critical de la revisión de esta
 * tarea: `POST /` nunca incluía `yearBuilt`/`latitude`/`longitude`, solo
 * `PATCH /:propertyId` porque ese sí hace `...parsed.data`).
 */
export function buildPropertyCreateData(
  input: z.infer<typeof propertySchema>,
  tenantId: string,
  ownerId: string | null,
): Prisma.PropertyUncheckedCreateInput {
  return {
    tenantId,
    name: input.name,
    address: input.address,
    city: input.city,
    province: input.province,
    postalCode: input.postalCode || null,
    ownerId,
    ...(input.managementFeePercentBps === undefined
      ? {}
      : { managementFeePercentBps: input.managementFeePercentBps }),
    ...(input.reserveFundTargetCents === undefined
      ? {}
      : { reserveFundTargetCents: input.reserveFundTargetCents }),
    ...(input.yearBuilt === undefined ? {} : { yearBuilt: input.yearBuilt }),
    ...(input.latitude === undefined ? {} : { latitude: input.latitude }),
    ...(input.longitude === undefined ? {} : { longitude: input.longitude }),
  };
}

propertiesRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = propertySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid property', details: parsed.error.flatten() });
      return;
    }

    const ownerResolution = await resolveOwnerId(user.tenantId, parsed.data.ownerId);
    if (!ownerResolution.ok) {
      res.status(400).json({ error: 'Owner not found' });
      return;
    }

    const property = await prisma.property.create({
      data: buildPropertyCreateData(parsed.data, user.tenantId, ownerResolution.ownerId),
      include: { units: true },
    });
    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.patch('/:propertyId', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const parsed = propertySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid property', details: parsed.error.flatten() });
      return;
    }

    const existing = await prisma.property.findFirst({
      where: { id: req.params.propertyId, tenantId: user.tenantId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    // Solo valida el dueño si el cliente mandó `ownerId` explícitamente
    // (asignar o desasignar). Si no vino en el body, `ownerId` queda fuera
    // de `ownerIdUpdate` y `...parsed.data` tampoco trae la clave, así que
    // el valor existente no se toca.
    let ownerIdUpdate: { ownerId: string | null } | Record<string, never> = {};
    if ('ownerId' in parsed.data) {
      const ownerResolution = await resolveOwnerId(user.tenantId, parsed.data.ownerId);
      if (!ownerResolution.ok) {
        res.status(400).json({ error: 'Owner not found' });
        return;
      }
      ownerIdUpdate = { ownerId: ownerResolution.ownerId };
    }

    const property = await prisma.property.update({
      where: { id: existing.id },
      data: {
        ...parsed.data,
        postalCode: parsed.data.postalCode === '' ? null : parsed.data.postalCode,
        // Pisa el `ownerId` crudo de `...parsed.data` (si vino) con el
        // valor ya validado contra el tenant — nunca se escribe sin pasar
        // por resolveOwnerId.
        ...ownerIdUpdate,
      },
      include: { units: true },
    });
    res.json({ property });
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

propertiesRouter.get('/:propertyId/statement-preview', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const period = typeof req.query.period === 'string' ? req.query.period : '';
    const result = await previewOwnerStatement({
      tenantId: user.tenantId,
      propertyId: req.params.propertyId,
      period,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ preview: result.preview });
  } catch (err) {
    next(err);
  }
});

propertiesRouter.post(
  '/:propertyId/statements',
  requireAuth,
  requireRole('property_manager'),
  async (req, res, next) => {
    try {
      const user = requireUser(req);
      const period = typeof req.body?.period === 'string' ? req.body.period : '';
      const result = await closeOwnerStatement({
        tenantId: user.tenantId,
        propertyId: req.params.propertyId,
        period,
        actorUserId: user.userId,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json({ statementId: result.statementId });
    } catch (err) {
      next(err);
    }
  },
);

propertiesRouter.get('/:propertyId/statements', requireAuth, async (req, res, next) => {
  try {
    const user = requireUser(req);
    const statements = await prisma.ownerStatement.findMany({
      where: { propertyId: req.params.propertyId, tenantId: user.tenantId },
      orderBy: { periodStart: 'desc' },
    });
    res.json({ statements });
  } catch (err) {
    next(err);
  }
});
