import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShowMojoMockAdapter,
  WebChatMockAdapter,
  type GlmAdapter,
  type GlmReasoningRequest,
} from '@property-manager/adapters';
import { prisma } from '../config/db.js';
import { handleInboundMessage } from './chatbot.service.js';

/**
 * Prueba de integración de la decisión de enrutamiento de
 * `handleInboundMessage`: ¿el modelo real se convierte en el camino
 * principal una vez que `transaction_intent` está definido, y el motor
 * determinista solo se usa (a) antes de que exista ese intent, y
 * (b) como respaldo ante un fallo real del proveedor?
 *
 * Usa Prisma real contra la BD de test (mismo patrón que
 * bills.service.test.ts) y adapters mock/espía para GLM, mensajería y
 * ShowMojo — nunca golpea la red real.
 */

const TENANT_ID = 'tenant_test_chatbot_routing';

async function seedTenant() {
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {},
    create: { id: TENANT_ID, name: 'Routing Test Tenant', province: 'BC' },
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
  await prisma.chatConversation.deleteMany({ where: { tenantId: TENANT_ID } });
  await prisma.lead.deleteMany({ where: { tenantId: TENANT_ID } });
}

function glmReturning(content: string): { glm: GlmAdapter; reason: ReturnType<typeof vi.fn> } {
  const reason = vi.fn(async (_request: GlmReasoningRequest) => ({ content }));
  return { glm: { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter, reason };
}

function throwingGlm(): { glm: GlmAdapter; reason: ReturnType<typeof vi.fn> } {
  const reason = vi.fn(async () => {
    throw new Error('simulated provider outage');
  });
  return { glm: { name: 'glm', reason, extractReceipt: vi.fn() } as unknown as GlmAdapter, reason };
}

async function seedConversationWithSlots(
  externalId: string,
  state: string,
  slots: Record<string, string>,
) {
  return prisma.chatConversation.create({
    data: {
      tenantId: TENANT_ID,
      externalId,
      channel: 'web',
      state,
      slots: { create: Object.entries(slots).map(([key, value]) => ({ key, value })) },
    },
  });
}

const messaging = new WebChatMockAdapter();
const showmojo = new ShowMojoMockAdapter();

describe('chatbot routing integration (handleInboundMessage)', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTenant();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('never calls the model before transaction_intent is known — the initial menu turn stays deterministic', async () => {
    const { glm, reason } = glmReturning('{}');

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-greeting-1', body: 'hi', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).not.toHaveBeenCalled();
    expect(reply.replyText).toMatch(/rent|buy|sell/i);
  });

  it('routes a rental conversation through the model once transaction_intent is rent and no deterministic builder matches', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Sure — this unit has a dedicated parking stall included.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: {}, clear: [] },
    }));

    // Todos los campos de calificación de renta ya están llenos, así que
    // buildFastQualificationTurn (y por tanto buildDeterministicQualificationTurn)
    // no tiene ninguna pregunta pendiente que hacer para este mensaje ambiguo:
    // ningún builder determinista puede responder esto, por diseño.
    await seedConversationWithSlots('routing-rental-1', 'proposing_tour', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      bedrooms: '2',
      pets: 'cat',
      budget: '2600',
      move_in_date: 'August',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-rental-1', body: 'does it have parking?', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Sure — this unit has a dedicated parking stall included.');
  });

  it('routes an ownership (buy) conversation through the model once transaction_intent is buy, never through the deterministic buyer builder', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Got it — a $850k budget for a townhouse in Burnaby.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { purchase_budget: '850000' }, clear: [] },
    }));

    await seedConversationWithSlots('routing-ownership-buy-1', 'collecting_budget', {
      transaction_intent: 'buy',
      prospect_name: 'Sarah',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-buy-1', body: 'My budget is around 850k for a townhouse in Burnaby', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Got it — a $850k budget for a townhouse in Burnaby.');
    expect(reply.extractedSlots).toMatchObject({ purchase_budget: '850000' });
  });

  it('routes an ownership (sell) conversation through the model once transaction_intent is sell', async () => {
    const { glm, reason } = glmReturning(JSON.stringify({
      reply: 'Thanks — noted the address and timeline.',
      intent: 'discover',
      confidence: 'high',
      profile: { set: { seller_property_address: '45 Oak Street, Richmond' }, clear: [] },
    }));

    await seedConversationWithSlots('routing-ownership-sell-1', 'collecting_budget', {
      transaction_intent: 'sell',
      prospect_name: 'Marcus',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-sell-1', body: 'The property is at 45 Oak Street, Richmond', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    expect(reply.replyText).toBe('Thanks — noted the address and timeline.');
  });

  it('falls back to a real, non-generic deterministic reply for rental when the provider genuinely fails (Finding 1, end-to-end through the real handler)', async () => {
    const { glm, reason } = throwingGlm();

    await seedConversationWithSlots('routing-rental-outage-1', 'proposing_tour', {
      transaction_intent: 'rent',
      prospect_name: 'Carlos',
      preferred_area: 'Burnaby',
      preferred_province: 'British Columbia',
      location_confirmed: 'yes',
      bedrooms: '2',
      pets: 'cat',
      budget: '2600',
      move_in_date: 'August',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-rental-outage-1', body: 'does it have parking?', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    // Este es exactamente el texto genérico que quedaba atascado antes del
    // fix de la revisión final (Finding 1) — si vuelve a aparecer aquí, el
    // respaldo de renta ante fallo del proveedor volvió a ser código muerto.
    expect(reply.replyText).not.toBe('Could you clarify that in one sentence?');
  });

  it('falls back to the real deterministic ownership builder when the provider genuinely fails for a buy/sell conversation', async () => {
    const { glm, reason } = throwingGlm();

    await seedConversationWithSlots('routing-ownership-outage-1', 'collecting_budget', {
      transaction_intent: 'buy',
    });

    const reply = await handleInboundMessage(
      { tenantId: TENANT_ID, from: 'routing-ownership-outage-1', body: 'My name is Sarah', channel: 'web' },
      { glm, messaging, showmojo },
    );

    expect(reason).toHaveBeenCalledTimes(1);
    // buildOwnershipConversationTurn's buyerTurn produces this exact
    // template for a name given with no name on file yet — proves the
    // deterministic ownership fallback is genuinely reachable and working,
    // not dead code like the rental fallback was before Finding 1's fix.
    expect(reply.replyText).toContain('pleasure to meet you, Sarah');
  });
});
