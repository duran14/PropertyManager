import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/db.js';

const HOUR = 60 * 60 * 1000;

export function hashShortlistToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function nextReminderDate(createdAt: Date, reminderCount: number): Date | null {
  const delays = [2 * HOUR, 24 * HOUR, 72 * HOUR];
  const delay = delays[reminderCount];
  return delay === undefined ? null : new Date(createdAt.getTime() + delay);
}

export function buildShortlistPrefillContact(
  slots: Record<string, string>,
  lead?: { name?: string | null; phone?: string | null; email?: string | null } | null,
) {
  return {
    name: slots.prospect_name ?? lead?.name ?? '',
    phone: slots.contact_phone ?? '',
    email: slots.contact_email ?? '',
  };
}

export async function createShortlist(input: {
  tenantId: string;
  conversationId: string;
  unitIds: string[];
}) {
  const token = randomBytes(24).toString('base64url');
  const now = new Date();
  const shortlist = await prisma.propertyShortlist.create({
    data: {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      unitIds: input.unitIds,
      tokenHash: hashShortlistToken(token),
      expiresAt: new Date(now.getTime() + 14 * 24 * HOUR),
      nextReminderAt: nextReminderDate(now, 0),
    },
  });
  return { shortlist, token };
}

export async function getPublicShortlist(token: string) {
  const shortlist = await prisma.propertyShortlist.findFirst({
    where: { tokenHash: hashShortlistToken(token), expiresAt: { gt: new Date() } },
    include: { conversation: { include: { lead: true, slots: true } } },
  });
  if (!shortlist) return null;

  const [units, catalogUnits, tenant] = await Promise.all([
    prisma.unit.findMany({
      where: { id: { in: shortlist.unitIds }, tenantId: shortlist.tenantId },
      include: { property: true, listingPhotos: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
    }),
    prisma.unit.findMany({
      where: { tenantId: shortlist.tenantId, isActive: true },
      include: {
        property: { select: { name: true, address: true, city: true, province: true } },
        listingPhotos: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 6 },
      },
      orderBy: { rentCents: 'asc' },
    }),
    prisma.tenant.findUnique({
      where: { id: shortlist.tenantId },
      select: { name: true },
    }),
  ]);

  const byId = new Map(units.map((unit) => [unit.id, unit]));
  await prisma.propertyShortlist.update({ where: { id: shortlist.id }, data: { viewedAt: new Date() } });
  return {
    shortlist,
    units: shortlist.unitIds.map((id) => byId.get(id)).filter(Boolean),
    catalog: catalogUnits,
    tenantName: tenant?.name ?? 'Property Management',
  };
}

export async function rotateShortlistToken(shortlistId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await prisma.propertyShortlist.update({ where: { id: shortlistId }, data: { tokenHash: hashShortlistToken(token) } });
  return token;
}
