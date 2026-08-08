import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChannel, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import {
  completeShowingAndInvite,
  createRentalApplication,
  getPublicRentalApplication,
  hashApplicationToken,
  resolveApplicationNotifyTargets,
  submitRentalApplication,
  type NotifiableStaff,
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

describe('resolveApplicationNotifyTargets', () => {
  const broker: NotifiableStaff = { id: 'u_broker', email: 'broker@test.ca', notificationChannel: null, notificationAddress: null };
  const assignee: NotifiableStaff = { id: 'u_assignee', email: 'assignee@test.ca', notificationChannel: null, notificationAddress: null };
  const pmA: NotifiableStaff = { id: 'u_pm_a', email: 'pma@test.ca', notificationChannel: null, notificationAddress: null };
  const pmB: NotifiableStaff = { id: 'u_pm_b', email: 'pmb@test.ca', notificationChannel: null, notificationAddress: null };
  const staff = [broker, assignee, pmA, pmB];

  it('prefers the showing broker over everyone else', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: 'u_broker',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([broker]);
  });

  it('falls back to the lead assignee when there is no broker', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([assignee]);
  });

  it('falls back to every property manager when there is neither broker nor assignee', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff,
      propertyManagerIds: ['u_pm_a', 'u_pm_b'],
    })).toEqual([pmA, pmB]);
  });

  it('skips an id that does not resolve to a known staff member', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: 'u_deleted',
      assignedUserId: 'u_assignee',
      staff,
      propertyManagerIds: ['u_pm_a'],
    })).toEqual([assignee]);
  });

  it('returns an empty list when nothing resolves', () => {
    expect(resolveApplicationNotifyTargets({
      brokerUserId: null,
      assignedUserId: null,
      staff: [],
      propertyManagerIds: [],
    })).toEqual([]);
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
});

function validSubmission() {
  return {
    annualIncome: 82000,
    employerName: 'Acme Corp',
    references: 'Jane Doe — previous landlord — 604-555-0111',
    applicantFullName: 'Carlos Duran',
    consentApplication: true,
    consentCreditCheck: true,
    consentPoliceCheck: true,
    idDocumentFilename: 'id.png',
    idDocumentMimeType: 'image/png',
    idDocumentBase64: Buffer.from('fake-image-bytes').toString('base64'),
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

  it('rejects a submission without a name', async () => {
    const { token } = await seedInvitedApplication();
    const { messaging } = fakeMessaging();

    const result = await submitRentalApplication(
      token,
      { ...validSubmission(), applicantFullName: '   ' },
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
});
