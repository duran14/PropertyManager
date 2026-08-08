import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { findReengagementCandidates } from './remarketing.service.js';

const TENANT_ID = 'tenant_test_remarketing';

async function seedTenant() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Remarketing Test Tenant', province: 'BC' },
  });
}

async function cleanup() {
  const conversations = await prisma.chatConversation.findMany({
    where: { tenantId: TENANT_ID },
    select: { id: true },
  });
  const conversationIds = conversations.map((c) => c.id);
  if (conversationIds.length > 0) {
    await prisma.conversationSlot.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await prisma.chatMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
  }
  await prisma.showing.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

async function seedLeadWithConversation(options: {
  phone: string;
  status?: 'new_' | 'contacted' | 'qualified' | 'tour_scheduled' | 'converted' | 'lost';
  lastMessageDaysAgo: number;
  lastRemarketedAt?: Date;
  optedOutAt?: Date;
  withShowing?: boolean;
}) {
  const lead = await prisma.lead.create({
    data: {
      tenantId: TENANT_ID,
      phone: options.phone,
      source: 'web',
      status: options.status ?? 'new_',
      lastRemarketedAt: options.lastRemarketedAt,
      optedOutAt: options.optedOutAt,
    },
  });
  const conversation = await prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId: options.phone,
      channel: 'web',
      state: 'collecting_budget',
      leadId: lead.id,
    },
  });
  const messageDate = new Date(Date.now() - options.lastMessageDaysAgo * 24 * 60 * 60 * 1000);
  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: 'user',
      content: 'hola',
      createdAt: messageDate,
    },
  });
  if (options.withShowing) {
    await prisma.showing.create({
      data: { tenantId: TENANT_ID, leadId: lead.id, scheduledAt: new Date() },
    });
  }
  return { lead, conversation };
}

describe('findReengagementCandidates', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('includes a new_ lead inactive for 15 days with no showing', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550001', lastMessageDaysAgo: 15 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).toContain(lead.id);
  });

  it('excludes a lead inactive for only 10 days (below the 14-day threshold)', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550002', lastMessageDaysAgo: 10 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead that already has a showing scheduled', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550003', lastMessageDaysAgo: 20, withShowing: true });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead already remarketed', async () => {
    const { lead } = await seedLeadWithConversation({
      phone: '+16045550004',
      lastMessageDaysAgo: 20,
      lastRemarketedAt: new Date(),
    });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead that opted out', async () => {
    const { lead } = await seedLeadWithConversation({
      phone: '+16045550005',
      lastMessageDaysAgo: 20,
      optedOutAt: new Date(),
    });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  it('excludes a lead whose status is tour_scheduled, converted, or lost', async () => {
    const { lead: touring } = await seedLeadWithConversation({ phone: '+16045550006', status: 'tour_scheduled', lastMessageDaysAgo: 20 });
    const { lead: converted } = await seedLeadWithConversation({ phone: '+16045550007', status: 'converted', lastMessageDaysAgo: 20 });
    const { lead: lost } = await seedLeadWithConversation({ phone: '+16045550008', status: 'lost', lastMessageDaysAgo: 20 });

    const candidates = await findReengagementCandidates(TENANT_ID);
    const ids = candidates.map((c) => c.leadId);

    expect(ids).not.toContain(touring.id);
    expect(ids).not.toContain(converted.id);
    expect(ids).not.toContain(lost.id);
  });

  it('includes a qualified lead', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550009', status: 'qualified', lastMessageDaysAgo: 20 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).toContain(lead.id);
  });
});
