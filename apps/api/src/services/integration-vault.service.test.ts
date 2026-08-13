import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import {
  getIntegrationCredentials,
  listIntegrationStatuses,
  markIntegrationStatus,
  saveIntegrationCredentials,
} from './integration-vault.service.js';

const TENANT_ID = 'tenant_test_integration_vault';

async function cleanup() {
  await prisma.integrationConfig.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Vault Test', province: 'BC' } });
});

afterEach(cleanup);

describe('saveIntegrationCredentials / getIntegrationCredentials', () => {
  it('guarda cifrado y lo devuelve descifrado', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID,
      provider: 'frontlobby_portal',
      username: 'agency@example.com',
      password: 'super-secret-pw',
    });

    const row = await prisma.integrationConfig.findFirstOrThrow({
      where: { tenantId: TENANT_ID, provider: 'frontlobby_portal' },
    });
    expect(row.encryptedCredentials).not.toContain('super-secret-pw');
    expect(row.status).toBe('pending');

    const creds = await getIntegrationCredentials(TENANT_ID, 'frontlobby_portal');
    expect(creds).toEqual({ username: 'agency@example.com', password: 'super-secret-pw' });
  });

  it('devuelve null si no hay credenciales guardadas', async () => {
    expect(await getIntegrationCredentials(TENANT_ID, 'sterling_portal')).toBeNull();
  });

  it('guardar de nuevo reemplaza la credencial anterior, no crea una fila nueva', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'a@example.com', password: 'pw1',
    });
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'b@example.com', password: 'pw2',
    });

    const rows = await prisma.integrationConfig.findMany({
      where: { tenantId: TENANT_ID, provider: 'frontlobby_portal' },
    });
    expect(rows).toHaveLength(1);
    expect(await getIntegrationCredentials(TENANT_ID, 'frontlobby_portal'))
      .toEqual({ username: 'b@example.com', password: 'pw2' });
  });
});

describe('markIntegrationStatus', () => {
  it('actualiza el estado y lastSyncedAt', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'sterling_portal', username: 'u', password: 'p',
    });
    await markIntegrationStatus(TENANT_ID, 'sterling_portal', 'connected');

    const row = await prisma.integrationConfig.findFirstOrThrow({
      where: { tenantId: TENANT_ID, provider: 'sterling_portal' },
    });
    expect(row.status).toBe('connected');
    expect(row.lastSyncedAt).not.toBeNull();
  });
});

describe('listIntegrationStatuses', () => {
  it('lista sin exponer credenciales', async () => {
    await saveIntegrationCredentials({
      tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p',
    });
    const list = await listIntegrationStatuses(TENANT_ID);
    expect(list).toEqual([
      { provider: 'frontlobby_portal', status: 'pending', lastSyncedAt: null },
    ]);
  });
});
