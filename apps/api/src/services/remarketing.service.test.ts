import type { ChatChannel, GlmAdapter, GlmReasoningRequest, MessagingAdapter, OutboundMessage } from '@property-manager/adapters';
import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../config/db.js';
import { draftReengagementMessage, findReengagementCandidates, runWeeklyReengagement, sendReengagementMessage } from './remarketing.service.js';

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
  // Default is 'sms', NOT 'web': web is now excluded from remarketing
  // candidates entirely (Fix 2 — WebChatMockAdapter is a permanent mock,
  // there's no real outbound push for that channel), so tests that want a
  // remarketable candidate must use a real channel. Tests that specifically
  // exercise the web exclusion pass channel: 'web' explicitly.
  channel?: ChatChannel;
  lastMessageDaysAgo: number;
  lastRemarketedAt?: Date;
  optedOutAt?: Date;
  withShowing?: boolean;
  // Fix 3: simulates our OWN outbound remarketing attempt (role: 'assistant')
  // landing more recently than the lead's own last message, to prove it
  // doesn't reset the 14-day inactivity clock.
  assistantMessageDaysAgo?: number;
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
      channel: options.channel ?? 'sms',
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
  if (options.assistantMessageDaysAgo !== undefined) {
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'Hi! Are you still looking?',
        deliveryStatus: 'failed',
        createdAt: new Date(Date.now() - options.assistantMessageDaysAgo * 24 * 60 * 60 * 1000),
      },
    });
  }
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

  // Fix 2: web chat is request/response over POST /chat/messages, not a
  // persistent push channel — WebChatMockAdapter is permanent (factory.ts
  // always wires it for 'web', real credentials or not), so "sending" there
  // delivers nothing to the actual person. A web-only lead must never be
  // selected, otherwise it burns its one-and-only lastRemarketedAt attempt
  // without ever receiving anything.
  it('excludes a lead whose only conversation is on the web channel, even when otherwise eligible', async () => {
    const { lead } = await seedLeadWithConversation({ phone: '+16045550012', channel: 'web', lastMessageDaysAgo: 20 });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).not.toContain(lead.id);
  });

  // Fix 3: a failed (or successful) remarketing attempt creates its own
  // ChatMessage (role: 'assistant'). Eligibility must be driven by when the
  // LEAD last wrote to us, not by our own outbound attempts — otherwise a
  // failed send resets the 14-day clock and blocks the lead's own retry for
  // up to 14 days, contradicting the spec's "se reintenta la siguiente
  // semana automáticamente".
  it('is not excluded/reset by its own assistant-authored remarketing message, even if that message is more recent than the 14-day threshold', async () => {
    const { lead } = await seedLeadWithConversation({
      phone: '+16045550013',
      lastMessageDaysAgo: 20, // the lead's own last message: past the threshold, eligible
      assistantMessageDaysAgo: 1, // our own (failed) attempt: very recent
    });

    const candidates = await findReengagementCandidates(TENANT_ID);

    expect(candidates.map((c) => c.leadId)).toContain(lead.id);
  });
});

function fakeGlm(content: string): GlmAdapter {
  return {
    name: 'glm',
    reason: vi.fn(async (_request: GlmReasoningRequest) => ({ content })),
    extractReceipt: vi.fn(),
  } as unknown as GlmAdapter;
}

function fakeMessaging(options: { shouldFail?: boolean } = {}): MessagingAdapter & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    channel: 'web',
    sent,
    async send(message: OutboundMessage) {
      if (options.shouldFail) throw new Error('simulated send failure');
      sent.push(message);
      return { messageId: `msg_${sent.length}` };
    },
    async parseWebhook() {
      throw new Error('not used in this test');
    },
  };
}

describe('draftReengagementMessage', () => {
  it('returns the trimmed content from the GLM adapter', async () => {
    const glm = fakeGlm('  ¡Hola! ¿Sigues buscando en Surrey?  ');

    const message = await draftReengagementMessage(glm, { preferred_area: 'Surrey', budget: '1800' });

    expect(message).toBe('¡Hola! ¿Sigues buscando en Surrey?');
    expect(glm.reason).toHaveBeenCalledTimes(1);
  });

  // Fix 1: GlmMockAdapter.reason() returns the literal placeholder
  // 'Simulated GLM agent response.' when no schema branch matches (which is
  // exactly what happens for this request shape) — that text must never
  // reach a real lead. isMockGlm: true must skip the mock's reason() call
  // entirely and use the deterministic fallback template instead.
  it('never returns the GLM mock placeholder text when isMockGlm is true, and uses captured slots', async () => {
    const mockGlm = fakeGlm('Simulated GLM agent response.');

    const message = await draftReengagementMessage(
      mockGlm,
      { preferred_area: 'Surrey', budget: '1800' },
      { isMockGlm: true },
    );

    expect(message).not.toContain('Simulated GLM');
    expect(mockGlm.reason).not.toHaveBeenCalled();
    expect(message).toContain('Surrey');
    expect(message).toContain('1800');
  });

  it('falls back to a fully generic message when isMockGlm is true and no slots were captured', async () => {
    const mockGlm = fakeGlm('Simulated GLM agent response.');

    const message = await draftReengagementMessage(mockGlm, {}, { isMockGlm: true });

    expect(message).not.toContain('Simulated GLM');
    expect(message.length).toBeGreaterThan(0);
  });

  // Fix 4: the rest of the product (rental-conversation prompts, shortlist
  // reminders, chatbot fallbacks) defaults to English and only switches to
  // Spanish on a detected signal (looksLikeSpanish, reused from
  // chatbot.service.ts) — the remarketing draft must follow the same
  // convention instead of being hardcoded to Spanish.
  it('defaults to English when there is no signal of Spanish in the lead\'s last message', async () => {
    const message = await draftReengagementMessage(fakeGlm('Simulated GLM agent response.'), {}, { isMockGlm: true });

    expect(message).toMatch(/still looking/i);
  });

  it('drafts in Spanish when the lead\'s last message looks like Spanish', async () => {
    const message = await draftReengagementMessage(
      fakeGlm('Simulated GLM agent response.'),
      { preferred_area: 'Surrey' },
      { isMockGlm: true, lastUserMessage: 'Hola, ¿siguen teniendo departamentos disponibles?' },
    );

    expect(message).toMatch(/¿Sigues buscando/);
  });

  // Fix 5: draftReengagementMessage's output is the only checkpoint before
  // an unsupervised send (no human review queue by design) — it must
  // defend against an empty response, overly long content, and wrapping
  // quotes, whether the content came from real GLM or the fallback.
  it('falls back to the deterministic template when the GLM response is empty/whitespace-only', async () => {
    const glm = fakeGlm('   ');

    const message = await draftReengagementMessage(glm, { preferred_area: 'Burnaby' });

    expect(message.trim().length).toBeGreaterThan(0);
    expect(message).toContain('Burnaby');
  });

  it('caps overly long GLM content to a bounded length instead of sending it verbatim', async () => {
    const glm = fakeGlm('a'.repeat(500));

    const message = await draftReengagementMessage(glm, {});

    expect(message.length).toBeLessThanOrEqual(325);
    expect(message.length).toBeLessThan(500);
  });

  it('strips a single layer of wrapping quotes from the GLM response', async () => {
    const glm = fakeGlm('"Hi there, are you still looking?"');

    const message = await draftReengagementMessage(glm, {});

    expect(message).toBe('Hi there, are you still looking?');
  });
});

describe('sendReengagementMessage', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('creates a ChatMessage, sends it, and marks lastRemarketedAt on success', async () => {
    const { lead, conversation } = await seedLeadWithConversation({ phone: '+16045550010', lastMessageDaysAgo: 20 });
    const messaging = fakeMessaging();
    const candidate = { leadId: lead.id, conversationId: conversation.id, channel: 'web' as const, externalId: conversation.externalId };

    const result = await sendReengagementMessage(messaging, candidate, 'Hola, ¿sigues buscando?');

    expect(result).toBe(true);
    expect(messaging.sent).toHaveLength(1);
    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead.lastRemarketedAt).not.toBeNull();
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id, role: 'assistant' } });
    expect(messages).toHaveLength(1);
    expect(messages[0].deliveryStatus).toBe('sent');
    // Fix 6: closes the loop with detectOptOutPhrase — every remarketing
    // message must carry an explicit, deterministic way for the lead to
    // trigger the opt-out detector.
    expect(messages[0].content).toContain('Reply STOP to stop receiving messages like this.');
    expect(messaging.sent[0].body).toContain('Reply STOP to stop receiving messages like this.');
  });

  it('does not mark lastRemarketedAt when the send fails', async () => {
    const { lead, conversation } = await seedLeadWithConversation({ phone: '+16045550011', lastMessageDaysAgo: 20 });
    const messaging = fakeMessaging({ shouldFail: true });
    const candidate = { leadId: lead.id, conversationId: conversation.id, channel: 'web' as const, externalId: conversation.externalId };

    const result = await sendReengagementMessage(messaging, candidate, 'Hola, ¿sigues buscando?');

    expect(result).toBe(false);
    const updatedLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updatedLead.lastRemarketedAt).toBeNull();
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id, role: 'assistant' } });
    expect(messages[0].deliveryStatus).toBe('failed');
  });
});

describe('runWeeklyReengagement', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('sends to the eligible lead only, skipping one with a showing, one already remarketed, and one opted out', async () => {
    const { lead: eligible } = await seedLeadWithConversation({ phone: '+16045550020', lastMessageDaysAgo: 20 });
    await seedLeadWithConversation({ phone: '+16045550021', lastMessageDaysAgo: 20, withShowing: true });
    await seedLeadWithConversation({ phone: '+16045550022', lastMessageDaysAgo: 20, lastRemarketedAt: new Date() });
    await seedLeadWithConversation({ phone: '+16045550023', lastMessageDaysAgo: 20, optedOutAt: new Date() });

    const glm = fakeGlm('¡Hola de nuevo! ¿Sigues buscando?');
    const messaging = fakeMessaging();

    const result = await runWeeklyReengagement(TENANT_ID, {
      glm,
      messaging: { sms: messaging } as never,
    });

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(messaging.sent).toHaveLength(1);
    const updatedEligible = await prisma.lead.findUniqueOrThrow({ where: { id: eligible.id } });
    expect(updatedEligible.lastRemarketedAt).not.toBeNull();
  });

  it('counts a candidate as skipped when there is no adapter for its channel', async () => {
    await seedLeadWithConversation({ phone: '+16045550024', lastMessageDaysAgo: 20 });
    const glm = fakeGlm('¡Hola de nuevo!');

    const result = await runWeeklyReengagement(TENANT_ID, { glm, messaging: {} as never });

    expect(result).toEqual({ sent: 0, skipped: 1 });
  });

  it('skips a candidate whose draft fails (GLM outage) without blocking the rest of the run', async () => {
    const { lead: broken } = await seedLeadWithConversation({ phone: '+16045550025', lastMessageDaysAgo: 20 });
    const { lead: healthy } = await seedLeadWithConversation({ phone: '+16045550026', lastMessageDaysAgo: 20 });
    const throwingGlm = {
      name: 'glm',
      reason: vi.fn()
        .mockRejectedValueOnce(new Error('simulated GLM outage'))
        .mockResolvedValueOnce({ content: '¡Hola de nuevo!' }),
      extractReceipt: vi.fn(),
    } as unknown as GlmAdapter;
    const messaging = fakeMessaging();

    const result = await runWeeklyReengagement(TENANT_ID, { glm: throwingGlm, messaging: { sms: messaging } as never });

    expect(result).toEqual({ sent: 1, skipped: 1 });
    const brokenLead = await prisma.lead.findUniqueOrThrow({ where: { id: broken.id } });
    expect(brokenLead.lastRemarketedAt).toBeNull();
    const healthyLead = await prisma.lead.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(healthyLead.lastRemarketedAt).not.toBeNull();
  });
});
