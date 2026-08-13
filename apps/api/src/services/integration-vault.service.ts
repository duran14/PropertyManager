/**
 * Bóveda de credenciales de terceros — le da su primer uso real a
 * IntegrationConfig, que existe en el schema desde el MVP y nunca se
 * conectó a nada. Usuario/contraseña se guardan como un JSON cifrado de
 * una sola pieza; nunca se devuelven en claro a ningún endpoint HTTP
 * (getIntegrationCredentials es solo para uso interno del servidor).
 */
import { prisma } from '../config/db.js';
import { decrypt, encrypt } from '../config/crypto.js';
import { writeAudit } from './audit.service.js';

export type ScreeningProvider = 'frontlobby_portal' | 'sterling_portal';

interface VaultCredentials {
  username: string;
  password: string;
}

export async function saveIntegrationCredentials(input: {
  tenantId: string;
  provider: ScreeningProvider;
  username: string;
  password: string;
  // Quién guardó/reemplazó la credencial. Opcional porque el servicio no
  // depende de auth, pero el router siempre lo manda (requireAuth garantiza
  // req.user) — sin esto, plantar o pisar la contraseña de una agencia
  // quedaba sin ningún rastro.
  userId?: string;
}): Promise<void> {
  const payload: VaultCredentials = { username: input.username, password: input.password };
  await prisma.integrationConfig.upsert({
    where: { tenantId_provider: { tenantId: input.tenantId, provider: input.provider } },
    update: { encryptedCredentials: encrypt(JSON.stringify(payload)), status: 'pending' },
    create: {
      tenantId: input.tenantId,
      provider: input.provider,
      encryptedCredentials: encrypt(JSON.stringify(payload)),
      status: 'pending',
    },
  });

  // Nunca se audita username/password, solo qué proveedor cambió y quién lo
  // hizo — mismo patrón que calendar-connection.service.ts para credenciales
  // de terceros.
  await writeAudit({
    tenantId: input.tenantId,
    actorId: input.userId ?? 'system',
    actorType: input.userId ? 'user' : 'system',
    action: 'integration.credentials_saved',
    entityType: 'integration_config',
    entityId: input.provider,
    payload: { provider: input.provider },
  });
}

export async function getIntegrationCredentials(
  tenantId: string,
  provider: ScreeningProvider,
): Promise<VaultCredentials | null> {
  const row = await prisma.integrationConfig.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
  });
  if (!row) return null;
  return JSON.parse(decrypt(row.encryptedCredentials)) as VaultCredentials;
}

export async function markIntegrationStatus(
  tenantId: string,
  provider: ScreeningProvider,
  status: 'connected' | 'error',
): Promise<void> {
  await prisma.integrationConfig.updateMany({
    where: { tenantId, provider },
    data: { status, lastSyncedAt: new Date() },
  });
}

export async function listIntegrationStatuses(
  tenantId: string,
): Promise<Array<{ provider: ScreeningProvider; status: string; lastSyncedAt: Date | null }>> {
  const rows = await prisma.integrationConfig.findMany({
    where: { tenantId, provider: { in: ['frontlobby_portal', 'sterling_portal'] } },
    select: { provider: true, status: true, lastSyncedAt: true },
  });
  return rows.map((row) => ({ provider: row.provider as ScreeningProvider, status: row.status, lastSyncedAt: row.lastSyncedAt }));
}
