import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChannel, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import {
  completeShowingAndInvite,
  createRentalApplication,
  getPublicRentalApplication,
  hashApplicationToken,
  submitRentalApplication,
  type SubmitApplicationInput,
} from './rental-application.service.js';

const TENANT_ID = 'tenant_test_rental_application';

async function seedShowing(options: { showingId?: string } = {}) {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Rental Application Test Tenant', province: 'BC' },
  });
  const lead = await prisma.lead.create({
    data: { tenantId: TENANT_ID, phone: '+16045557001', source: 'web', status: 'new_' },
  });
  const showing = await prisma.showing.create({
    data: {
      ...(options.showingId ? { id: options.showingId } : {}),
      tenantId: TENANT_ID,
      leadId: lead.id,
      scheduledAt: new Date(),
      status: 'confirmed',
    },
  });
  return { lead, showing };
}

async function cleanup() {
  // `ChatConversation.leadId` no tiene cascade delete (ver schema.prisma):
  // borrar el lead solo lo pone en null y deja la fila (y su externalId
  // único) huérfana. Como `seedShowingWithConversation` reutiliza el mismo
  // externalId en cada test, hay que borrar las conversaciones también o el
  // segundo test que llame a esa función choca con la constraint única
  // (tenantId, externalId).
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.rentalApplication.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

describe('rental application invitations', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates an application with a hashed token and a 14-day expiry', async () => {
    const { lead, showing } = await seedShowing();

    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    expect(token).toBeTruthy();
    expect(application.tokenHash).toBe(hashApplicationToken(token));
    expect(application.tokenHash).not.toBe(token);
    expect(application.status).toBe('invited');
    const daysUntilExpiry = (application.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysUntilExpiry).toBeGreaterThan(13.9);
    expect(daysUntilExpiry).toBeLessThan(14.1);
  });

  it('looks up an application by its plaintext token', async () => {
    const { lead, showing } = await seedShowing();
    const { token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });

    const found = await getPublicRentalApplication(token);

    expect(found?.showingId).toBe(showing.id);
  });

  it('returns null for an unknown token', async () => {
    expect(await getPublicRentalApplication('not-a-real-token')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const { lead, showing } = await seedShowing();
    const { application, token } = await createRentalApplication({
      tenantId: TENANT_ID,
      showingId: showing.id,
      leadId: lead.id,
    });
    await prisma.rentalApplication.update({
      where: { id: application.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await getPublicRentalApplication(token)).toBeNull();
  });
});

function fakeMessaging(options: { shouldFail?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const adapter: MessagingAdapter = {
    channel: 'telegram',
    async send(message: OutboundMessage) {
      if (options.shouldFail) throw new Error('simulated send failure');
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
    async parseWebhook() {
      throw new Error('not used in this test');
    },
  };
  // `email` tiene que estar aquí aunque este test no lo use: la Task 5
  // reutiliza este helper y su ruta de notificación llama a
  // `messaging.email.send`. Sin él, ese acceso reventaría con TypeError
  // dentro de un try/catch y el test pasaría por la razón equivocada.
  return {
    sent,
    messaging: { telegram: adapter, web: adapter, email: adapter } as unknown as Record<ChatChannel, MessagingAdapter>,
  };
}

async function seedShowingWithConversation(channel: 'telegram' | 'web') {
  const { lead, showing } = await seedShowing();
  await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: `${channel}:900100`,
      channel,
      state: 'handoff',
      leadId: lead.id,
    },
  });
  return { lead, showing };
}

describe('completeShowingAndInvite', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('marks the showing completed, creates the application, and sends the link', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { sent, messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(result.applicationUrl);

    const updated = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
    expect(updated.status).toBe('completed');
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application?.status).toBe('invited');
  });

  it('still completes the showing and creates the application when the channel is web (no outbound push)', async () => {
    const { showing } = await seedShowingWithConversation('web');
    const { sent, messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    expect(sent).toHaveLength(0);
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application).not.toBeNull();
  });

  it('still creates the application when the lead has no conversation at all', async () => {
    const { showing } = await seedShowing();
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    const application = await prisma.rentalApplication.findFirst({ where: { showingId: showing.id } });
    expect(application).not.toBeNull();
  });

  it('still completes the showing when the send throws', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging({ shouldFail: true });

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.linkDelivered).toBe(false);
    const updated = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
    expect(updated.status).toBe('completed');
  });

  it('rejects a showing that is already completed', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging();
    await completeShowingAndInvite({ showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' }, { messaging });

    const second = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(second).toEqual({ ok: false, status: 409, error: 'Showing cannot be completed from status: completed' });
    expect(await prisma.rentalApplication.count({ where: { showingId: showing.id } })).toBe(1);
  });

  it('rejects a cancelled showing', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    await prisma.showing.update({ where: { id: showing.id }, data: { status: 'cancelled' } });
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 409, error: 'Showing cannot be completed from status: cancelled' });
  });

  it('returns 404 for a showing that does not belong to the tenant', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging();

    const result = await completeShowingAndInvite(
      { showingId: showing.id, tenantId: 'tenant_someone_else', actorUserId: 'u_broker' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 404, error: 'Showing not found' });
  });

  // Fix 2 (final review): el `findFirst` + chequeo de status y el
  // `prisma.showing.update` no eran atómicos, y como `showingId` es
  // `@unique` en `rental_applications`, dos peticiones concurrentes hacían
  // que la segunda `createRentalApplication` reventara con P2002 (500 al
  // broker) con el showing ya completado. El `updateMany` con guard de
  // status arregla esto: la prueba dispara dos llamadas reales en paralelo
  // contra la misma fila y verifica que solo una gana.
  it('is atomic under two concurrent completions of the same showing (Fix 2)', async () => {
    const { showing } = await seedShowingWithConversation('telegram');
    const { messaging } = fakeMessaging();

    const [resultA, resultB] = await Promise.all([
      completeShowingAndInvite({ showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' }, { messaging }),
      completeShowingAndInvite({ showingId: showing.id, tenantId: TENANT_ID, actorUserId: 'u_broker' }, { messaging }),
    ]);

    const results = [resultA, resultB];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 409 });

    const applications = await prisma.rentalApplication.findMany({ where: { showingId: showing.id } });
    expect(applications).toHaveLength(1);
    const updatedShowing = await prisma.showing.findUniqueOrThrow({ where: { id: showing.id } });
    expect(updatedShowing.status).toBe('completed');
  });
});

function validSubmission(overrides: Partial<SubmitApplicationInput> = {}): SubmitApplicationInput {
  return {
    annualIncome: 82000,
    employerName: 'Acme Corp',
    references: 'Jane Doe — previous landlord — 604-555-0111',
    applicantFullName: 'Carlos Duran',
    // Fase 2.2: FrontLobby pide nombre y apellido por separado.
    applicantFirstName: 'Carlos',
    applicantLastName: 'Duran',
    // Task 5: requeridos para que el screening de crédito/antecedentes
    // tenga con qué hacer match del solicitante.
    dateOfBirth: '1990-05-15',
    currentAddress: '123 Test St',
    currentCity: 'Vancouver',
    currentProvince: 'British Columbia',
    currentPostalCode: 'V6B 1A1',
    currentAddressStartDate: '2022-01-01',
    consentApplication: true,
    consentCreditCheck: true,
    consentPoliceCheck: true,
    idDocumentFilename: 'id.png',
    idDocumentMimeType: 'image/png',
    idDocumentBase64: Buffer.from('fake-image-bytes').toString('base64'),
    ...overrides,
  };
}

async function seedInvitedApplication() {
  const { lead, showing } = await seedShowing();
  const { application, token } = await createRentalApplication({
    tenantId: TENANT_ID,
    showingId: showing.id,
    leadId: lead.id,
  });
  return { lead, showing, application, token };
}

describe('submitRentalApplication', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // Fase 2.2 (adapter real de FrontLobby): nombre y apellido separados en
  // vez de un único `applicantFullName` de texto libre — FrontLobby los
  // pide así en su formulario.
  it('rechaza applicantFirstName vacío con 400', async () => {
    const { token } = await seedInvitedApplication();
    const result = await submitRentalApplication(token, validSubmission({ applicantFirstName: '' }), { messaging: fakeMessaging().messaging });
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('applicantFirstName') });
  });

  it('rechaza currentAddressStartDate no parseable con 400, no 500', async () => {
    const { token } = await seedInvitedApplication();
    const result = await submitRentalApplication(token, validSubmission({ currentAddressStartDate: 'garbage' }), { messaging: fakeMessaging().messaging });
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('currentAddressStartDate') });
  });

  it('guarda applicantFirstName/applicantLastName y deriva applicantFullName', async () => {
    const { token, application } = await seedInvitedApplication();
    await submitRentalApplication(token, validSubmission({ applicantFirstName: 'Ana', applicantLastName: 'García' }), { messaging: fakeMessaging().messaging });
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(row.applicantFirstName).toBe('Ana');
    expect(row.applicantLastName).toBe('García');
    expect(row.applicantFullName).toBe('Ana García');
  });

  it('stores every field and all three consent timestamps', async () => {
    const { token, application } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result).toEqual({ ok: true, applicationId: application.id });
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.status).toBe('submitted');
    expect(saved.submittedAt).not.toBeNull();
    expect(saved.annualIncome).toBe(82000);
    expect(saved.employerName).toBe('Acme Corp');
    expect(saved.applicantFullName).toBe('Carlos Duran');
    expect(saved.idDocumentStorageKey).toBeTruthy();
    expect(saved.consentApplicationAt).not.toBeNull();
    expect(saved.consentCreditCheckAt).not.toBeNull();
    expect(saved.consentPoliceCheckAt).not.toBeNull();
  });

  it.each([
    ['consentApplication'],
    ['consentCreditCheck'],
    ['consentPoliceCheck'],
  ])('rejects the submission when %s is missing', async (missing) => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), [missing]: false },
      { messaging },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.status).toBe(400);
    expect(result.error).toContain(missing);
  });

  it('rechaza el envío sin fecha de nacimiento o dirección', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), dateOfBirth: '' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('dateOfBirth') });
  });

  // El endpoint público no tiene auth: un POST directo (sin pasar por el
  // `type="date"` del formulario) puede mandar cualquier string. Un valor
  // no vacío pero no parseable como fecha debe seguir dando 400, no un 500
  // al reventar `new Date(...)` dentro del `updateMany` de Prisma.
  it('rechaza el envío con una fecha de nacimiento no parseable', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), dateOfBirth: 'garbage' },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining('dateOfBirth') });
  });

  it('guarda fecha de nacimiento y dirección al enviar', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      {
        ...validSubmission(),
        dateOfBirth: '1990-05-15',
        currentAddress: '456 Main St',
        currentCity: 'Burnaby',
        currentProvince: 'British Columbia',
        currentPostalCode: 'V5H 1A1',
      },
      { messaging },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: result.applicationId } });
    expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe('1990-05-15');
    expect(row.currentAddress).toBe('456 Main St');
  });

  it('rejects a submission without a name', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    // Fase 2.2: `applicantFullName` ya no se valida (se deriva de
    // first+last) — el chequeo de "sin nombre" ahora vive en
    // applicantFirstName/applicantLastName.
    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), applicantFirstName: '   ' },
      { messaging },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.status).toBe(400);
  });

  it('rejects a submission with no ID document', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), idDocumentBase64: null, idDocumentFilename: null, idDocumentMimeType: null },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: 'A photo ID document is required' });
  });

  it('rejects an ID document above the size cap', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), idDocumentBase64: 'A'.repeat(1_500_001) },
      { messaging },
    );

    expect(result).toEqual({ ok: false, status: 400, error: 'The ID document is too large' });
  });

  it('returns 404 for an unknown token', async () => {
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication('not-a-real-token', validSubmission(), { messaging });

    expect(result).toEqual({ ok: false, status: 404, error: 'Application not found or expired' });
  });

  it('rejects a second submission without overwriting the first', async () => {
    const { token, application } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();
    await submitRentalApplication(token, validSubmission(), { messaging });

    const second = await submitRentalApplication(
      token,
      { ...validSubmission(), employerName: 'Somewhere Else' },
      { messaging },
    );

    expect(second).toEqual({ ok: false, status: 409, error: 'Application already submitted' });
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.employerName).toBe('Acme Corp');
  });

  it('saves the application even when every notification channel fails', async () => {
    const { token, application } = await seedInvitedApplication();
    await prisma.user.create({
      data: {
        id: 'u_pm_notify_fail',
        tenantId: TENANT_ID,
        email: 'pm-notify-fail@test.ca',
        passwordHash: 'x',
        firstName: 'Pat',
        lastName: 'Manager',
        role: 'property_manager',
      },
    });
    const { messaging } = fakeMessaging({ shouldFail: true });

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result.ok).toBe(true);
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.status).toBe('submitted');

    await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  });

  // Fix 1 (final review): entre el chequeo `status === 'submitted'` y el
  // `update` final hay un `await` que escribe ~1MB a disco
  // (`storage.putObject`). Dos POSTs concurrentes del mismo token pasaban
  // ambos el chequeo, y el segundo `update` pisaba los datos del primero —
  // incluidos los tres timestamps de consentimiento, un dato de
  // cumplimiento legal. El `updateMany` con guard de status arregla esto:
  // la prueba dispara dos envíos reales en paralelo sobre el mismo token.
  it('is atomic under two concurrent submissions of the same token (Fix 1)', async () => {
    const { token, application } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();
    const first = { ...validSubmission(), employerName: 'First Co' };
    const second = { ...validSubmission(), employerName: 'Second Co' };

    const [resultA, resultB] = await Promise.all([
      submitRentalApplication(token, first, { messaging }),
      submitRentalApplication(token, second, { messaging }),
    ]);

    const results = [resultA, resultB];
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 409, error: 'Application already submitted' });

    // La data guardada debe coincidir exactamente con la del envío que ganó
    // — no una mezcla de los dos, y ningún timestamp de consentimiento nulo.
    const winningEmployerName = resultA.ok ? first.employerName : second.employerName;
    const saved = await prisma.rentalApplication.findUniqueOrThrow({ where: { id: application.id } });
    expect(saved.status).toBe('submitted');
    expect(saved.employerName).toBe(winningEmployerName);
    expect(saved.consentApplicationAt).not.toBeNull();
    expect(saved.consentCreditCheckAt).not.toBeNull();
    expect(saved.consentPoliceCheckAt).not.toBeNull();
  });

  // Fix 7 (final review): mismo bug que se corrigió en Fase 1B, ahora en el
  // otro extremo del flujo. `WebChatMockAdapter` reporta éxito sin entregar
  // nada, así que un staff con `notificationChannel = 'web'` nunca debe
  // recibir un intento de envío por ese canal; y `notificationChannel =
  // 'email'` no debe duplicar el correo que ya se manda por separado.
  it('never sends the chat notification through the web channel', async () => {
    const { token } = await seedInvitedApplication();
    const webSent: OutboundMessage[] = [];
    const emailSent: OutboundMessage[] = [];
    const messaging = {
      telegram: fakeMessaging().messaging.telegram,
      web: {
        channel: 'web',
        async send(message: OutboundMessage) {
          webSent.push(message);
          return { messageId: 'web_1' };
        },
        async parseWebhook() {
          throw new Error('not used in this test');
        },
      },
      email: {
        channel: 'email',
        async send(message: OutboundMessage) {
          emailSent.push(message);
          return { messageId: 'email_1' };
        },
        async parseWebhook() {
          throw new Error('not used in this test');
        },
      },
    } as unknown as Record<ChatChannel, MessagingAdapter>;

    await prisma.user.create({
      data: {
        id: 'u_pm_web_channel',
        tenantId: TENANT_ID,
        email: 'pm-web-channel@test.ca',
        passwordHash: 'x',
        firstName: 'Pat',
        lastName: 'Manager',
        role: 'property_manager',
        notificationChannel: 'web',
        notificationAddress: 'web-address',
      },
    });

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result.ok).toBe(true);
    expect(webSent).toHaveLength(0);
    expect(emailSent).toHaveLength(1); // solo la notificación directa por correo

    await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  });

  it('does not duplicate the email notification through the chat path when notificationChannel is email', async () => {
    const { token } = await seedInvitedApplication();
    const emailSent: OutboundMessage[] = [];
    const messaging = {
      telegram: fakeMessaging().messaging.telegram,
      web: fakeMessaging().messaging.web,
      email: {
        channel: 'email',
        async send(message: OutboundMessage) {
          emailSent.push(message);
          return { messageId: `email_${emailSent.length}` };
        },
        async parseWebhook() {
          throw new Error('not used in this test');
        },
      },
    } as unknown as Record<ChatChannel, MessagingAdapter>;

    await prisma.user.create({
      data: {
        id: 'u_pm_email_channel',
        tenantId: TENANT_ID,
        email: 'pm-email-channel@test.ca',
        passwordHash: 'x',
        firstName: 'Pat',
        lastName: 'Manager',
        role: 'property_manager',
        notificationChannel: 'email',
        notificationAddress: 'pm-email-channel@test.ca',
      },
    });

    const result = await submitRentalApplication(token, validSubmission(), { messaging });

    expect(result.ok).toBe(true);
    // Un solo correo, no dos (uno de la ruta directa de email, cero de la
    // ruta de "chat" porque 'email' queda excluida de ahí).
    expect(emailSent).toHaveLength(1);

    await prisma.user.deleteMany({ where: { tenantId: TENANT_ID } });
  });
});
