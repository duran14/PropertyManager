/**
 * Demo seed for British Columbia property management workflows.
 *
 * This seed is intentionally deterministic: it rebuilds the demo tenant from
 * scratch so the product demo can be reset before every walkthrough.
 *
 * Password for all demo users: Password123!
 */
import { buildAuditEntry, type AuditActorType } from '@property-manager/core';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DEMO_TENANT_ID = 'tenant_demo_pm';
const DEMO_PASSWORD = 'Password123!';

async function main() {
  console.log('Starting BC demo seed...');

  await prisma.tenant.delete({ where: { id: DEMO_TENANT_ID } }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return undefined;
    }
    throw error;
  });

  const tenant = await prisma.tenant.create({
    data: {
      id: DEMO_TENANT_ID,
      name: 'Pacific Ridge Property Management',
      province: 'BC',
    },
  });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const pm = await prisma.user.create({
    data: {
      id: 'user_demo_pm',
      tenantId: tenant.id,
      email: 'pm@pacificridge.ca',
      passwordHash,
      firstName: 'Diana',
      lastName: 'Reyes',
      role: UserRole.property_manager,
      lastLoginAt: new Date('2026-07-09T15:05:00-07:00'),
    },
  });
  const bookkeeper = await prisma.user.create({
    data: {
      id: 'user_demo_books',
      tenantId: tenant.id,
      email: 'books@pacificridge.ca',
      passwordHash,
      firstName: 'Jorge',
      lastName: 'Liu',
      role: UserRole.bookkeeper,
      lastLoginAt: new Date('2026-07-09T14:52:00-07:00'),
    },
  });
  const broker = await prisma.user.create({
    data: {
      id: 'user_demo_broker',
      tenantId: tenant.id,
      email: 'broker@pacificridge.ca',
      passwordHash,
      firstName: 'Marcus',
      lastName: 'Beaulieu',
      role: UserRole.broker,
      lastLoginAt: new Date('2026-07-09T13:20:00-07:00'),
    },
  });

  const cedarCourt = await prisma.property.create({
    data: {
      id: 'property_cedar_court',
      tenantId: tenant.id,
      name: 'Cedar Court Apartments',
      address: '1200 Granville St',
      city: 'Vancouver',
      province: 'BC',
      postalCode: 'V6Z 1R9',
    },
  });
  const harbourView = await prisma.property.create({
    data: {
      id: 'property_harbour_view',
      tenantId: tenant.id,
      name: 'Harbour View Suites',
      address: '789 Wharf St',
      city: 'Victoria',
      province: 'BC',
      postalCode: 'V8W 1T3',
    },
  });
  const kitsPoint = await prisma.property.create({
    data: {
      id: 'property_kits_point',
      tenantId: tenant.id,
      name: 'Kits Point Walkups',
      address: '2145 Cornwall Ave',
      city: 'Vancouver',
      province: 'BC',
      postalCode: 'V6K 1B5',
    },
  });

  const unit101 = await prisma.unit.create({
    data: {
      id: 'unit_cedar_101',
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 101',
      rentCents: 240000,
      slug: 'cedar-court-apt-101',
    },
  });
  const unit102 = await prisma.unit.create({
    data: {
      id: 'unit_cedar_102',
      tenantId: tenant.id,
      propertyId: cedarCourt.id,
      name: 'Apt 102',
      rentCents: 265000,
      slug: 'cedar-court-apt-102',
    },
  });
  const unitPH = await prisma.unit.create({
    data: {
      id: 'unit_harbour_ph',
      tenantId: tenant.id,
      propertyId: harbourView.id,
      name: 'Penthouse 4',
      rentCents: 385000,
      slug: 'harbour-view-penthouse-4',
    },
  });
  const unitKits = await prisma.unit.create({
    data: {
      id: 'unit_kits_203',
      tenantId: tenant.id,
      propertyId: kitsPoint.id,
      name: 'Suite 203',
      rentCents: 295000,
      slug: 'kits-point-suite-203',
    },
  });

  await prisma.listingPhoto.createMany({
    data: [
      {
        id: 'photo_cedar_101_living',
        tenantId: tenant.id,
        unitId: unit101.id,
        originalUrl: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
        enhancedUrl: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85',
        enhancementType: 'enhance',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_101_living',
        isPrimary: true,
      },
      {
        id: 'photo_cedar_102_kitchen',
        tenantId: tenant.id,
        unitId: unit102.id,
        originalUrl: 'https://images.unsplash.com/photo-1556912172-45b7abe8b7e1',
        enhancedUrl: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136',
        enhancementType: 'object_removal',
        status: 'enhanced',
        autoenhanceOrderId: 'ae_demo_102_kitchen',
        isPrimary: true,
      },
      {
        id: 'photo_harbour_ph_view',
        tenantId: tenant.id,
        unitId: unitPH.id,
        originalUrl: 'https://images.unsplash.com/photo-1493809842364-78817add7ffb',
        enhancedUrl: null,
        enhancementType: 'virtual_staging',
        status: 'processing',
        autoenhanceOrderId: 'ae_demo_ph_view',
        isPrimary: true,
      },
    ],
  });

  const sarah = await prisma.tenantRecord.create({
    data: {
      id: 'tenant_record_sarah',
      tenantId: tenant.id,
      firstName: 'Sarah',
      lastName: 'Chen',
      email: 'sarah.chen@example.ca',
      phone: '+16045551234',
      idVerificationRef: 'idv_sarah_bc_dl',
    },
  });
  const daniel = await prisma.tenantRecord.create({
    data: {
      id: 'tenant_record_daniel',
      tenantId: tenant.id,
      firstName: 'Daniel',
      lastName: 'Morrison',
      email: 'daniel.morrison@example.ca',
      phone: '+16045554321',
    },
  });

  await prisma.lease.createMany({
    data: [
      {
        id: 'lease_sarah_cedar_101',
        tenantId: tenant.id,
        unitId: unit101.id,
        tenantRecordId: sarah.id,
        startDate: new Date('2026-03-01'),
        endDate: new Date('2027-02-28'),
        rentCents: 240000,
        depositCents: 120000,
        status: 'active',
        rtaDraftDocRef: 'rta_draft_sarah_2026_03',
        signedDocRef: 'signed_rta_sarah_2026_03',
        docusignEnvelopeId: 'env_demo_sarah_signed',
        docusignStatus: 'completed',
      },
      {
        id: 'lease_daniel_kits_203',
        tenantId: tenant.id,
        unitId: unitKits.id,
        tenantRecordId: daniel.id,
        startDate: new Date('2026-08-01'),
        endDate: new Date('2027-07-31'),
        rentCents: 295000,
        depositCents: 147500,
        status: 'draft',
        rtaDraftDocRef: 'rta_draft_daniel_2026_08',
        docusignEnvelopeId: 'env_demo_daniel_sent',
        docusignStatus: 'sent',
      },
    ],
  });

  await prisma.owner.createMany({
    data: [
      {
        id: 'owner_patterson',
        tenantId: tenant.id,
        firstName: 'Elizabeth',
        lastName: 'Patterson',
        email: 'e.patterson@example.ca',
        phone: '+16045550101',
      },
      {
        id: 'owner_nguyen',
        tenantId: tenant.id,
        firstName: 'Minh',
        lastName: 'Nguyen',
        email: 'm.nguyen@example.ca',
        phone: '+17785550102',
      },
    ],
  });

  const leadMaya = await prisma.lead.create({
    data: {
      id: 'lead_maya',
      tenantId: tenant.id,
      unitId: unit102.id,
      name: 'Maya Thompson',
      email: 'maya.thompson@example.ca',
      phone: '+16045551001',
      message: 'Looking for a July move-in near downtown, budget around $2,700.',
      source: 'whatsapp',
      preferredChannel: 'whatsapp',
      status: 'tour_scheduled',
      showmojoShowingId: 'sm_showing_maya',
      tourUrl: 'https://showmojo.example/demo/maya',
    },
  });
  const leadNoah = await prisma.lead.create({
    data: {
      id: 'lead_noah',
      tenantId: tenant.id,
      unitId: unitPH.id,
      name: 'Noah Singh',
      email: 'noah.singh@example.ca',
      phone: '+17785551002',
      message: 'Interested in the waterfront penthouse and parking availability.',
      source: 'unit_url',
      preferredChannel: 'web',
      status: 'new_',
    },
  });
  const leadPriya = await prisma.lead.create({
    data: {
      id: 'lead_priya',
      tenantId: tenant.id,
      unitId: unitKits.id,
      name: 'Priya Nair',
      email: 'priya.nair@example.ca',
      phone: '+16045551003',
      message: 'Needs a pet-friendly suite close to Kits Beach.',
      source: 'showmojo',
      preferredChannel: 'sms',
      status: 'qualified',
      showmojoShowingId: 'sm_showing_priya',
      tourUrl: 'https://showmojo.example/demo/priya',
    },
  });
  await prisma.lead.create({
    data: {
      id: 'lead_elena',
      tenantId: tenant.id,
      unitId: unit101.id,
      name: 'Elena Garcia',
      email: 'elena.garcia@example.ca',
      phone: '+16045551004',
      message: 'Converted after broker review. Preparing references.',
      source: 'manual',
      preferredChannel: 'email',
      status: 'converted',
    },
  });

  const conversationMaya = await prisma.chatConversation.create({
    data: {
      id: 'conv_maya_whatsapp',
      tenantId: tenant.id,
      externalId: '+16045551001',
      channel: 'whatsapp',
      unitId: unit102.id,
      state: 'scheduling',
      leadId: leadMaya.id,
      updatedAt: new Date('2026-07-09T10:30:00-07:00'),
    },
  });
  const conversationNoah = await prisma.chatConversation.create({
    data: {
      id: 'conv_noah_web',
      tenantId: tenant.id,
      externalId: 'web_session_noah',
      channel: 'web',
      unitId: unitPH.id,
      state: 'collecting_budget',
      leadId: leadNoah.id,
      updatedAt: new Date('2026-07-09T11:05:00-07:00'),
    },
  });

  await prisma.chatMessage.createMany({
    data: [
      {
        id: 'msg_maya_1',
        conversationId: conversationMaya.id,
        role: 'user',
        content: 'Hi, is Cedar Court Apt 102 still available?',
        createdAt: new Date('2026-07-09T10:14:00-07:00'),
      },
      {
        id: 'msg_maya_2',
        conversationId: conversationMaya.id,
        role: 'assistant',
        content: 'Yes. Apt 102 is available for July 15. Your budget fits the listed rent.',
        createdAt: new Date('2026-07-09T10:14:20-07:00'),
      },
      {
        id: 'msg_maya_3',
        conversationId: conversationMaya.id,
        role: 'assistant',
        content: 'I can offer tours tomorrow at 10:30 AM or 3:00 PM. Which works best?',
        createdAt: new Date('2026-07-09T10:15:00-07:00'),
      },
      {
        id: 'msg_maya_4',
        conversationId: conversationMaya.id,
        role: 'user',
        content: 'Tomorrow at 3 works.',
        createdAt: new Date('2026-07-09T10:16:00-07:00'),
      },
      {
        id: 'msg_noah_1',
        conversationId: conversationNoah.id,
        role: 'user',
        content: 'Does the penthouse include parking?',
        createdAt: new Date('2026-07-09T11:01:00-07:00'),
      },
      {
        id: 'msg_noah_2',
        conversationId: conversationNoah.id,
        role: 'assistant',
        content: 'One parking stall is included. What monthly budget are you targeting?',
        createdAt: new Date('2026-07-09T11:01:25-07:00'),
      },
    ],
  });

  await prisma.conversationSlot.createMany({
    data: [
      { id: 'slot_maya_budget', conversationId: conversationMaya.id, key: 'budget', value: '2700 CAD' },
      { id: 'slot_maya_movein', conversationId: conversationMaya.id, key: 'move_in_date', value: '2026-07-15' },
      { id: 'slot_maya_occupants', conversationId: conversationMaya.id, key: 'occupants', value: '2' },
      { id: 'slot_noah_area', conversationId: conversationNoah.id, key: 'preferred_area', value: 'Victoria waterfront' },
    ],
  });

  await prisma.showing.createMany({
    data: [
      {
        id: 'showing_maya',
        tenantId: tenant.id,
        leadId: leadMaya.id,
        unitId: unit102.id,
        showmojoId: 'sm_showing_maya',
        scheduledAt: new Date('2026-07-10T15:00:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'scheduled',
        showmojoUrl: 'https://showmojo.example/demo/maya',
      },
      {
        id: 'showing_priya',
        tenantId: tenant.id,
        leadId: leadPriya.id,
        unitId: unitKits.id,
        showmojoId: 'sm_showing_priya',
        scheduledAt: new Date('2026-07-11T11:30:00-07:00'),
        durationMinutes: 30,
        brokerUserId: broker.id,
        status: 'confirmed',
        showmojoUrl: 'https://showmojo.example/demo/priya',
      },
      {
        id: 'showing_noah',
        tenantId: tenant.id,
        leadId: leadNoah.id,
        unitId: unitPH.id,
        showmojoId: 'sm_showing_noah',
        scheduledAt: new Date('2026-07-08T16:00:00-07:00'),
        durationMinutes: 45,
        brokerUserId: broker.id,
        status: 'completed',
        showmojoUrl: 'https://showmojo.example/demo/noah',
      },
    ],
  });

  const approval = await prisma.approvalRequest.create({
    data: {
      id: 'approval_bill_lift',
      tenantId: tenant.id,
      action: 'qbo.create_bill',
      proposedPayload: {
        vendorName: 'LiftTech Elevator Services',
        billDate: '2026-07-07',
        totalCents: 184250,
        category: 'maintenance',
      } as Prisma.InputJsonValue,
      confidenceScore: 0.73,
      confidenceReasons: ['vendor matched', 'amount requires review', 'unit allocation missing'],
      status: 'pending',
    },
  });

  await prisma.bill.createMany({
    data: [
      {
        id: 'bill_lifttech_review',
        tenantId: tenant.id,
        vendorName: 'LiftTech Elevator Services',
        billDate: new Date('2026-07-07'),
        dueDate: new Date('2026-07-21'),
        totalCents: 184250,
        currency: 'CAD',
        category: 'maintenance',
        unitId: null,
        ocrConfidence: 0.73,
        sourceDocRef: 'receipts/lifttech-elevator-july.pdf',
        approvalRequestId: approval.id,
        status: 'pending_review',
      },
      {
        id: 'bill_bc_hydro_synced',
        tenantId: tenant.id,
        vendorName: 'BC Hydro',
        billDate: new Date('2026-07-03'),
        dueDate: new Date('2026-07-17'),
        totalCents: 64280,
        currency: 'CAD',
        category: 'utilities',
        unitId: unit101.id,
        ocrConfidence: 0.94,
        sourceDocRef: 'receipts/bc-hydro-cedar-101.pdf',
        qboBillId: 'qbo_bill_demo_1001',
        qboSyncedAt: new Date('2026-07-03T16:20:00-07:00'),
        status: 'synced_to_qbo',
      },
      {
        id: 'bill_cleaning_rejected',
        tenantId: tenant.id,
        vendorName: 'SparkleWest Cleaning',
        billDate: new Date('2026-07-02'),
        dueDate: new Date('2026-07-16'),
        totalCents: 31200,
        currency: 'CAD',
        category: 'repairs',
        unitId: unit102.id,
        ocrConfidence: 0.51,
        sourceDocRef: 'receipts/sparklewest-duplicate.jpg',
        status: 'rejected',
      },
    ],
  });

  const rentDate = new Date('2026-07-01T09:00:00-07:00');
  await prisma.transaction.createMany({
    data: [
      {
        id: 'txn_buildium_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 240000,
        reference: 'bldm_pay_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_bank_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'bank',
        amountCents: 240000,
        reference: 'etr_2026_0701_88213',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_qbo_sarah',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'qbo',
        amountCents: 240000,
        reference: 'qbo_je_001',
        unitId: unit101.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_buildium_cedar_102',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'buildium',
        amountCents: 265000,
        reference: 'bldm_pay_002',
        unitId: unit102.id,
        occurredAt: rentDate,
      },
      {
        id: 'txn_bank_unmatched',
        tenantId: tenant.id,
        type: 'rent_payment',
        source: 'bank',
        amountCents: 185000,
        reference: 'etr_2026_0702_unknown',
        unitId: null,
        occurredAt: new Date('2026-07-02T13:12:00-07:00'),
      },
    ],
  });

  const batch = await prisma.reconciliationBatch.create({
    data: {
      id: 'recon_batch_july_demo',
      tenantId: tenant.id,
      runDate: new Date('2026-07-09T07:00:00-07:00'),
      status: 'partial',
      qboBalanceCents: 240000,
      bankBalanceCents: 425000,
      buildiumBalanceCents: 505000,
      balanced: false,
    },
  });

  await prisma.discrepancy.createMany({
    data: [
      {
        id: 'disc_missing_qbo_cedar_102',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'missing_in_qbo',
        entryReference: 'bldm_pay_002',
        entryAmountCents: 265000,
        relatedReferences: [],
        resolved: false,
      },
      {
        id: 'disc_missing_buildium_unknown',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'missing_in_buildium',
        entryReference: 'etr_2026_0702_unknown',
        entryAmountCents: 185000,
        relatedReferences: ['bank feed'],
        resolved: false,
      },
      {
        id: 'disc_resolved_hydro',
        tenantId: tenant.id,
        reconciliationBatchId: batch.id,
        kind: 'amount_mismatch',
        entryReference: 'qbo_bill_demo_1001',
        entryAmountCents: 64280,
        relatedReferences: ['bc_hydro_statement_2026_07'],
        resolved: true,
        resolvedByUserId: bookkeeper.id,
        resolvedAt: new Date('2026-07-09T12:15:00-07:00'),
      },
    ],
  });

  await addAudit({
    tenantId: tenant.id,
    actorId: 'showmojo_webhook',
    actorType: 'system',
    action: 'lead.created',
    entityType: 'lead',
    entityId: leadMaya.id,
    payload: { source: 'whatsapp', unitId: unit102.id },
    occurredAt: '2026-07-09T10:16:05.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: 'sentinel_ai',
    actorType: 'ai_agent',
    action: 'payment.review_required',
    entityType: 'transaction',
    entityId: 'txn_bank_unmatched',
    payload: {
      amountCents: 185000,
      decision: 'review',
      score: 0.62,
      reasons: ['sender not matched', 'no lease for amount', 'bank feed only'],
    },
    occurredAt: '2026-07-09T11:28:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: bookkeeper.id,
    actorType: 'user',
    action: 'bill.processed',
    entityType: 'bill',
    entityId: 'bill_lifttech_review',
    payload: { vendorName: 'LiftTech Elevator Services', decision: 'review', score: 0.73 },
    occurredAt: '2026-07-09T12:06:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: 'system_reconciliation',
    actorType: 'system',
    action: 'reconciliation.run',
    entityType: 'reconciliation_batch',
    entityId: batch.id,
    payload: { balanced: false, discrepancyCount: 3, reconciledCount: 1 },
    occurredAt: '2026-07-09T12:20:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: broker.id,
    actorType: 'user',
    action: 'showing.confirmed',
    entityType: 'showing',
    entityId: 'showing_priya',
    payload: { leadId: leadPriya.id, unitId: unitKits.id },
    occurredAt: '2026-07-09T13:10:00.000-07:00',
  });
  await addAudit({
    tenantId: tenant.id,
    actorId: pm.id,
    actorType: 'user',
    action: 'photo.enhancement_requested',
    entityType: 'listing_photo',
    entityId: 'photo_harbour_ph_view',
    payload: { enhancementType: 'virtual_staging', status: 'processing' },
    occurredAt: '2026-07-09T14:02:00.000-07:00',
  });

  console.log('Demo seed complete.');
  console.log('Login demo:');
  console.log('  Property Manager: pm@pacificridge.ca');
  console.log('  Bookkeeper:       books@pacificridge.ca');
  console.log('  Broker:           broker@pacificridge.ca');
  console.log(`  Password:         ${DEMO_PASSWORD}`);
}

async function addAudit(input: {
  tenantId: string;
  actorId: string;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}) {
  const last = await prisma.auditEntry.findFirst({
    where: { tenantId: input.tenantId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });

  const occurredAt = new Date(input.occurredAt).toISOString();
  const entry = buildAuditEntry({ ...input, occurredAt }, last?.hash);

  await prisma.auditEntry.create({
    data: {
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      actorType: entry.actorType,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      payload: entry.payload as Prisma.InputJsonValue,
      occurredAt: new Date(entry.occurredAt),
      createdAt: new Date(entry.occurredAt),
      previousHash: entry.previousHash,
      hash: entry.hash,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
