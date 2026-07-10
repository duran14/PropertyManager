/**
 * Servicio de Fotos IA — gestiona el flujo de mejora de fotos con Autoenhance.ai.
 *
 * Flujo:
 *  1. El PM sube una foto → se guarda como ListingPhoto (status: uploaded)
 *  2. El PM solicita una mejora (enhance / object_removal / virtual_staging)
 *  3. El servicio llama a Autoenhance.ai → recibe orderId
 *  4. Se encola un job BullMQ que consulta el estado (o espera el webhook)
 *  5. Cuando Autoenhance termina → webhook actualiza enhancedUrl + status: enhanced
 *  6. La foto mejorada queda disponible para publicación
 */
import type { PhotoEnhancementAdapter, EnhancementType } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { writeAudit } from './audit.service.js';

export interface UploadPhotoInput {
  tenantId: string;
  unitId: string;
  originalUrl: string;
  isPrimary?: boolean;
  uploadedByUserId: string;
}

export async function uploadPhoto(input: UploadPhotoInput) {
  // Si es primary, quitar el flag de las demás fotos de la unidad.
  if (input.isPrimary) {
    await prisma.listingPhoto.updateMany({
      where: { tenantId: input.tenantId, unitId: input.unitId, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  const photo = await prisma.listingPhoto.create({
    data: {
      tenantId: input.tenantId,
      unitId: input.unitId,
      originalUrl: input.originalUrl,
      isPrimary: input.isPrimary ?? false,
      status: 'uploaded',
      enhancementType: 'none',
    },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.uploadedByUserId,
    actorType: 'user',
    action: 'photo.uploaded',
    entityType: 'listing_photo',
    entityId: photo.id,
    payload: { unitId: input.unitId, originalUrl: input.originalUrl },
  });

  return photo;
}

export interface RequestEnhancementInput {
  photoId: string;
  tenantId: string;
  enhancementType: EnhancementType;
  style?: string;
  requestedByUserId: string;
}

/**
 * Solicita una mejora de foto a Autoenhance.ai.
 * Crea el job y deja la foto en estado 'processing'.
 */
export async function requestEnhancement(
  input: RequestEnhancementInput,
  adapter: PhotoEnhancementAdapter,
): Promise<{ orderId: string; photoId: string }> {
  const photo = await prisma.listingPhoto.findFirst({
    where: { id: input.photoId, tenantId: input.tenantId },
  });
  if (!photo) throw new Error('Photo not found');

  const result = await adapter.requestEnhancement({
    imageUrl: photo.originalUrl,
    type: input.enhancementType,
    style: input.style,
  });

  await prisma.listingPhoto.update({
    where: { id: photo.id },
    data: {
      autoenhanceOrderId: result.orderId,
      status: 'processing',
      enhancementType: input.enhancementType,
    },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.requestedByUserId,
    actorType: 'user',
    action: 'photo.enhancement_requested',
    entityType: 'listing_photo',
    entityId: photo.id,
    payload: { orderId: result.orderId, type: input.enhancementType, style: input.style },
  });

  return { orderId: result.orderId, photoId: photo.id };
}

/**
 * Procesa el webhook de Autoenhance.ai cuando una imagen está lista.
 * Actualiza la foto con la URL mejorada.
 */
export async function handleEnhancementComplete(input: {
  tenantId: string;
  orderId: string;
  enhancedUrl?: string;
  status: 'completed' | 'failed';
}): Promise<void> {
  const photo = await prisma.listingPhoto.findFirst({
    where: { tenantId: input.tenantId, autoenhanceOrderId: input.orderId },
  });
  if (!photo) {
    console.warn(`[Photos] Webhook para orden desconocida: ${input.orderId}`);
    return;
  }

  await prisma.listingPhoto.update({
    where: { id: photo.id },
    data: {
      status: input.status === 'completed' ? 'enhanced' : 'failed',
      enhancedUrl: input.enhancedUrl,
    },
  });

  await writeAudit({
    tenantId: input.tenantId,
    actorId: 'autoenhance_webhook',
    actorType: 'system',
    action: input.status === 'completed' ? 'photo.enhanced' : 'photo.enhancement_failed',
    entityType: 'listing_photo',
    entityId: photo.id,
    payload: { orderId: input.orderId, enhancedUrl: input.enhancedUrl },
  });
}

/** Lista las fotos de una unidad (con su estado de mejora). */
export async function listUnitPhotos(tenantId: string, unitId: string) {
  return prisma.listingPhoto.findMany({
    where: { tenantId, unitId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}
