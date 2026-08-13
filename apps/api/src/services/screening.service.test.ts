import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../config/db.js';
import {
  approveScreening,
  markScreeningTimedOut,
  pollScreeningResult,
  runScreeningRequest,
  triggerScreeningIfConsented,
} from './screening.service.js';
import * as integrationVaultService from './integration-vault.service.js';
import { saveIntegrationCredentials } from './integration-vault.service.js';

const TENANT_ID = 'tenant_test_screening_service';

async function cleanup() {
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.unit.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.property.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

async function seed(overrides: { consented?: boolean; fullName?: string } = {}) {
  await prisma.tenant.create({ data: { id: TENANT_ID, name: 'Screening Service Test', province: 'BC' } });
  await prisma.user.create({
    data: {
      tenantId: TENANT_ID, email: `pm-${TENANT_ID}@example.com`, passwordHash: 'x',
      firstName: 'Pat', lastName: 'Manager', role: 'property_manager',
    },
  });
  const property = await prisma.property.create({
    data: { tenantId: TENANT_ID, name: 'Pacific Ridge', address: '100 Test St', city: 'Vancouver', province: 'BC' },
  });
  const unit = await prisma.unit.create({
    data: { tenantId: TENANT_ID, propertyId: property.id, name: 'Unit 101', rentCents: 200_000, slug: `unit-101-${TENANT_ID}` },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, name: 'Ana', phone: '+16045550111', status: 'contacted', source: 'manual' },
  });
  const showing = await prisma.showing.create({
    data: { tenantId: TENANT_ID, leadId: lead.id, unitId: unit.id, scheduledAt: new Date(), status: 'completed' },
  });
  const consentedAt = overrides.consented === false ? null : new Date();
  const application = await prisma.rentalApplication.create({
    data: {
      tenantId: TENANT_ID, showingId: showing.id, leadId: lead.id, unitId: unit.id,
      tokenHash: `hash_${TENANT_ID}`, expiresAt: new Date(Date.now() + 86_400_000),
      status: 'submitted', applicantFullName: overrides.fullName ?? 'Ana Prospect',
      dateOfBirth: new Date('1990-05-15'), currentAddress: '123 Test St',
      currentCity: 'Vancouver', currentProvince: 'British Columbia', currentPostalCode: 'V6B 1A1',
      consentApplicationAt: consentedAt, consentCreditCheckAt: consentedAt, consentPoliceCheckAt: consentedAt,
    },
  });
  return { applicationId: application.id };
}

beforeEach(cleanup);
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
});

describe('triggerScreeningIfConsented', () => {
  it('marca ambos checkeos como requested cuando hay consentimiento', async () => {
    const { applicationId } = await seed();
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
    expect(row.criminalCheckStatus).toBe('requested');
    expect(row.creditCheckRequestedAt).not.toBeNull();
  });

  it('no dispara nada sin consentimiento', async () => {
    const { applicationId } = await seed({ consented: false });
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBeNull();
    expect(row.criminalCheckStatus).toBeNull();
  });
});

describe('runScreeningRequest', () => {
  it('persiste pending y la referencia del proveedor', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
    expect(row.creditCheckProviderRef).toMatch(/^mock_credit_/);
  });
});

describe('pollScreeningResult', () => {
  it('al completarse guarda el reporte, el resumen, y notifica al staff', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'criminal');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'criminal', midway.criminalCheckProviderRef!);

    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.criminalCheckStatus).toBe('passed');
    expect(row.criminalCheckSummary).toContain('No criminal record');
    expect(row.criminalCheckReportKey).not.toBeNull();
    expect(row.criminalCheckCompletedAt).not.toBeNull();
  });

  it('un solicitante marcado "Flagged" produce el veredicto flagged', async () => {
    const { applicationId } = await seed({ fullName: 'Flagged Applicant' });
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('flagged');
  });

  it('devuelve done:false mientras sigue pending', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'pending', providerRef: midway.creditCheckProviderRef!,
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(false);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
  });

  it('un fallo del adapter marca failed y avisa al staff, sin lanzar', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'failed', reason: 'Portal login failed',
    });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);
    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('failed');
    expect(row.creditCheckSummary).toContain('Portal login failed');
  });
});

// Finding 1 (review de Tarea 4): un sondeo que agota sus reintentos sin
// resultado del proveedor no puede quedar 'pending' para siempre.
// `markScreeningTimedOut` es la función que el worker llama al detectar el
// agotamiento (ver worker.screening.test.ts para la lógica de detección).
describe('markScreeningTimedOut', () => {
  it('cierra el checkeo como failed con un resumen de timeout y notifica al staff', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    const { getAdapters } = await import('../config/adapters.js');
    const emailSpy = vi.spyOn(getAdapters().messaging.email, 'send');

    await markScreeningTimedOut(applicationId, TENANT_ID, 'credit');

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('failed');
    expect(row.creditCheckSummary).toMatch(/did not arrive/i);
    expect(row.creditCheckCompletedAt).not.toBeNull();
    expect(emailSpy).toHaveBeenCalled();
  });
});

// Finding 4: un reintento de BullMQ (attempts: 3 en screeningRequestQueue)
// no debe volver a llamar runCheck si ya se envió con éxito — eso
// dispararía una segunda solicitud real al proveedor.
describe('runScreeningRequest — idempotencia', () => {
  it('si ya existe un providerRef, no repite runCheck y solo reencola el sondeo', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    const firstProviderRef = midway.creditCheckProviderRef;
    expect(firstProviderRef).toMatch(/^mock_credit_/);

    const { getAdapters } = await import('../config/adapters.js');
    const runCheckSpy = vi.spyOn(getAdapters().screening, 'runCheck');

    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    expect(runCheckSpy).not.toHaveBeenCalled();
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckProviderRef).toBe(firstProviderRef);
    expect(row.creditCheckStatus).toBe('pending');
  });
});

// Finding 3: los dos enqueues de triggerScreeningIfConsented son
// independientes — el fallo de uno no debe dejar al otro (ni a sí mismo)
// como 'requested' sin ningún job detrás.
describe('triggerScreeningIfConsented — fallo al encolar', () => {
  it('si un enqueue falla, ese checkeo se cierra failed sin bloquear al otro', async () => {
    const { applicationId } = await seed();

    const { screeningRequestQueue } = await import('../jobs/queues.js');
    type AddResult = Awaited<ReturnType<typeof screeningRequestQueue.add>>;
    const addSpy = vi.spyOn(screeningRequestQueue, 'add')
      .mockResolvedValueOnce({} as AddResult) // credit: encola bien
      .mockRejectedValueOnce(new Error('Redis unavailable')); // criminal: revienta

    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
    expect(row.criminalCheckStatus).toBe('failed');
    expect(row.criminalCheckSummary).toContain('Could not schedule');

    addSpy.mockRestore();
  });
});

// Finding 1 del review final: el adapter real (Playwright) todavía no
// existe — `createAdapters` construye SIEMPRE el mock. Un veredicto
// fabricado ("Score 740, no collections") no puede llegar al manager
// indistinguible de uno real: se marca como simulado en el summary
// persistido y en el aviso al staff. El status del enum NO cambia.
describe('marca de resultado simulado', () => {
  it('prefija el summary persistido de un veredicto del mock', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('passed'); // el enum sigue igual
    expect(row.creditCheckSummary).toMatch(/^\[SIMULATED\] /);
    expect(row.creditCheckSummary).toContain('Score 740');
  });

  it('marca también el aviso al staff', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    const emailSpy = vi.spyOn(getAdapters().messaging.email, 'send');

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    expect(emailSpy).toHaveBeenCalled();
    const sent = emailSpy.mock.calls[0]![0];
    expect(sent.body).toContain('[SIMULATED]');
    expect(sent.subject).toContain('[SIMULATED]');
  });

  it('no marca un fallo: ahí no hay veredicto fabricado que confundir', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { getAdapters } = await import('../config/adapters.js');
    vi.spyOn(getAdapters().screening, 'pollResult').mockResolvedValue({
      status: 'failed', reason: 'Portal login failed',
    });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckSummary).toBe('Portal login failed');
  });
});

// Finding 4 del review final: `persistTerminalResult` es el único punto de
// escritura de un resultado terminal, y tiene que ser a prueba de cadenas
// de jobs duplicadas y de fugas entre tenants.
describe('persistTerminalResult — guards de estado y tenant', () => {
  it('un cierre tardío no pisa un veredicto ya persistido ni notifica de nuevo', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!);

    const settled = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(settled.creditCheckStatus).toBe('passed');

    const { getAdapters } = await import('../config/adapters.js');
    const emailSpy = vi.spyOn(getAdapters().messaging.email, 'send');

    // Cadena vieja que llega tarde: el timeout de sondeo de otro job.
    await markScreeningTimedOut(applicationId, TENANT_ID, 'credit');

    const after = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(after.creditCheckStatus).toBe('passed');
    expect(after.creditCheckSummary).toBe(settled.creditCheckSummary);
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it('no escribe el resultado si el tenantId no corresponde a la solicitud', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit');

    await markScreeningTimedOut(applicationId, 'tenant_ajeno', 'credit');

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('pending');
    expect(row.creditCheckSummary).toBeNull();
  });
});

// Task 5: cuando el tenant conectó FrontLobby real, el checkeo de crédito
// nunca se dispara solo — cuesta $18.99 reales por corrida, así que queda
// 'awaiting_approval' hasta que un property_manager/broker lo apruebe
// explícitamente. Antecedentes penales sigue siendo mock (Sterling real
// todavía no existe) y no cambia su comportamiento.
describe('triggerScreeningIfConsented — con FrontLobby real conectado', () => {
  it('deja creditCheckStatus en awaiting_approval y NO encola ningún job', async () => {
    const { applicationId } = await seed();
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });

    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('awaiting_approval');
    // criminal sigue siendo mock — comportamiento de hoy, sin cambios.
    expect(row.criminalCheckStatus).toBe('requested');
  });
});

describe('approveScreening', () => {
  it('transiciona awaiting_approval -> requested y devuelve ok', async () => {
    const { applicationId } = await seed();
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });
    await triggerScreeningIfConsented(applicationId, TENANT_ID);

    const result = await approveScreening(applicationId, TENANT_ID, 'credit');

    expect(result).toEqual({ ok: true });
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('requested');
  });

  it('devuelve ok:false si el estado no es awaiting_approval (evita doble cobro)', async () => {
    const { applicationId } = await seed();
    const result = await approveScreening(applicationId, TENANT_ID, 'credit');
    expect(result).toEqual({ ok: false, reason: 'Not awaiting approval' });
  });
});

// Finding del review de Task 5: `triggerScreeningIfConsented` decide UNA VEZ
// si el checkeo es mock o real, y encola sin delay cuando es mock. Si un
// property_manager guarda credenciales reales de FrontLobby justo en la
// ventana entre ese enqueue y la ejecución del job, una segunda resolución
// del adapter en `runScreeningRequest` correría el checkeo REAL — con cargo
// de $18.99 — sin haber pasado nunca por 'awaiting_approval'/
// `approveScreening`. `forceMock` cierra esa ventana: el trigger automático
// manda `forceMock: true` en el job, y `runScreeningRequest` lo honra sin
// volver a consultar la bóveda.
describe('runScreeningRequest — forceMock cierra la ventana de carrera mock/real', () => {
  it('con forceMock, sigue usando el mock aunque se hayan guardado credenciales reales después del enqueue, y no vuelve a consultar la bóveda', async () => {
    const { applicationId } = await seed();

    // El trigger automático corre SIN credenciales: decide mock y encolaría
    // { forceMock: true } (probado por separado en el describe de arriba).
    // Simulamos la carrera guardando las credenciales reales DESPUÉS de esa
    // decisión, pero ANTES de que el job realmente corra.
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });

    const credentialsSpy = vi.spyOn(integrationVaultService, 'getIntegrationCredentials');

    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);

    // Nunca se re-resolvió el adapter contra la bóveda — si lo hubiera
    // hecho, habría encontrado las credenciales reales recién guardadas y
    // habría intentado construir FrontLobbyScreeningAdapter (Playwright
    // real) en vez del mock.
    expect(credentialsSpy).not.toHaveBeenCalled();

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    // El mock siempre responde 'pending' con una referencia mock_credit_N —
    // si hubiera corrido real, esto sería un providerRef de FrontLobby o el
    // checkeo habría fallado al intentar una navegación de Playwright real.
    expect(row.creditCheckStatus).toBe('pending');
    expect(row.creditCheckProviderRef).toMatch(/^mock_credit_/);
  });

  it('propaga forceMock al job de sondeo cuando runCheck deja el checkeo pending', async () => {
    const { applicationId } = await seed();

    const { screeningPollQueue } = await import('../jobs/queues.js');
    const addSpy = vi.spyOn(screeningPollQueue, 'add');

    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);

    expect(addSpy).toHaveBeenCalledWith(
      'poll-screening-result',
      expect.objectContaining({ forceMock: true }),
      expect.anything(),
    );
  });

  it('propaga forceMock al reencolar el sondeo en la rama de idempotencia (providerRef ya existente)', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);

    const { screeningPollQueue } = await import('../jobs/queues.js');
    const addSpy = vi.spyOn(screeningPollQueue, 'add');

    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);

    expect(addSpy).toHaveBeenCalledWith(
      'poll-screening-result',
      expect.objectContaining({ forceMock: true }),
      expect.anything(),
    );
  });
});

// Finding (extensión de Task 5): la misma ventana de carrera que `forceMock`
// cierra en `runScreeningRequest` seguía abierta en el SONDEO. Este job se
// encola con `delay: 15 * 60_000` — una ventana mucho más larga que la del
// envío inicial — así que si el checkeo se disparó como mock y en esos 15
// minutos se guardan credenciales reales de FrontLobby, `pollScreeningResult`
// re-resolvía el adapter real y llamaba `pollResult('credit', 'mock_credit_N')`
// — una referencia que el adapter real no puede interpretar.
describe('pollScreeningResult — forceMock cierra la ventana de carrera mock/real', () => {
  it('con forceMock, sigue usando el mock para sondear aunque se hayan guardado credenciales reales después del envío, y no vuelve a consultar la bóveda', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    // Credenciales reales llegan DESPUÉS del envío, dentro de la ventana de
    // 15 minutos del sondeo.
    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });

    const credentialsSpy = vi.spyOn(integrationVaultService, 'getIntegrationCredentials');

    const { done } = await pollScreeningResult(
      applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!, true,
    );

    // Nunca se re-resolvió el adapter contra la bóveda — si lo hubiera
    // hecho, habría encontrado las credenciales reales recién guardadas y
    // habría intentado construir FrontLobbyScreeningAdapter (Playwright
    // real) en vez de sondear el mock con una referencia mock_credit_N.
    expect(credentialsSpy).not.toHaveBeenCalled();

    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.creditCheckStatus).toBe('passed');
  });

  it('el summary persistido sigue marcado [SIMULATED] aunque haya credenciales reales al momento del sondeo', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'credit', true);
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    await saveIntegrationCredentials({ tenantId: TENANT_ID, provider: 'frontlobby_portal', username: 'u', password: 'p' });

    await pollScreeningResult(applicationId, TENANT_ID, 'credit', midway.creditCheckProviderRef!, true);

    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    // Si `persistTerminalResult` hubiera vuelto a resolver el adapter para
    // decidir el prefijo, habría encontrado credenciales reales y guardado
    // el veredicto del mock SIN el prefijo — indistinguible de uno real.
    expect(row.creditCheckSummary).toMatch(/^\[SIMULATED\] /);
  });

  it('sin forceMock, sigue resolviendo el adapter contra la bóveda como hoy (comportamiento sin cambios)', async () => {
    const { applicationId } = await seed();
    await runScreeningRequest(applicationId, TENANT_ID, 'criminal');
    const midway = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });

    const { done } = await pollScreeningResult(applicationId, TENANT_ID, 'criminal', midway.criminalCheckProviderRef!);

    expect(done).toBe(true);
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: applicationId } });
    expect(row.criminalCheckStatus).toBe('passed');
  });
});
